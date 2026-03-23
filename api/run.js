// api/run.js — Disparo manual e cron
import { run } from '../lib/processor.js';
import { cors } from '../lib/cors.js';
import { saveCheckpoint, getCheckpoint, clearCheckpoint } from '../lib/db.js';
export const config = { maxDuration: 300 };

// Meses em português → número (0-based)
const MONTHS_PT = {
    janeiro: 0, fevereiro: 1, marco: 2,
    abril: 3, maio: 4, junho: 5,
    julho: 6, agosto: 7, setembro: 8,
    outubro: 9, novembro: 10, dezembro: 11,
};

/**
 * Parseia data no formato "dd de Nome do Mês de yyyy"
 * Ex: "15 de março de 2025" → Date(2025, 2, 15, 0, 0, 0)
 * Aceita também DD/MM/YYYY e YYYY-MM-DD como fallback.
 */
function parsePtDate(str) {
    if (!str || typeof str !== 'string') return null;
    const clean = str.trim().toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    const m1 = clean.match(/^(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})$/);
    if (m1) {
        const day = parseInt(m1[1], 10);
        const month = MONTHS_PT[m1[2]];
        const year = parseInt(m1[3], 10);
        if (month === undefined || day < 1 || day > 31 || year < 2000) return null;
        return new Date(year, month, day, 0, 0, 0);
    }
    const m2 = clean.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m2) return new Date(parseInt(m2[1]), parseInt(m2[2]) - 1, parseInt(m2[3]));
    const m3 = clean.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m3) return new Date(parseInt(m3[3]), parseInt(m3[2]) - 1, parseInt(m3[1]));
    return null;
}

export default async function handler(req, res) {
    if (cors(req, res)) return;
    const auth = req.headers.authorization;
    const key  = req.headers['x-api-key'];
    const cronSecret = process.env.CRON_SECRET;
    const apiKey     = process.env.API_KEY || 'Deuse10';
    const validKeys  = new Set([apiKey, 'Deuse10', '@Deuse10']); // aceita qualquer variante

    const ok = (cronSecret && auth === `Bearer ${cronSecret}`) || validKeys.has(key);
    if (!ok) return res.status(401).json({ error: 'Não autorizado' });
    if (req.method !== 'POST') return res.status(405).end();

    let sinceDate = null;
    const rawDate = req.body?.since_date;
    if (rawDate) {
        sinceDate = parsePtDate(rawDate);
        if (!sinceDate) {
            return res.status(400).json({
                ok: false,
                error: `Data inválida: "${rawDate}". Use o formato "dd de nome do mês de yyyy" — ex: "15 de março de 2025".`,
            });
        }
    }

    const days = parseInt(req.body?.days) || 2;
    const includeRead = req.body?.include_read !== false;
    // Chave do checkpoint: separa varredura horária da histórica
    const checkpointKey = days <= 1 ? 'checkpoint_hourly' : 'checkpoint_historical';

    // Só limpa o checkpoint sem processar (usado pelo botão "Reiniciar do zero")
    if (req.body?.restart === true) {
        await clearCheckpoint(checkpointKey);
        return res.status(200).json({ ok: true, message: 'Checkpoint limpo. Próxima varredura começa do início.' });
    }

    // Modo retry_errors: reprocessa apenas emails com erro, sem anexos ou upload incompleto
    if (req.body?.retry_errors === true) {
        const { db } = await import('../lib/db.js');
        const col = (await db()).collection('email_logs');
        // Busca logs com problemas: erro, sem anexos detectados, ou com algum anexo não enviado
        const errorLogs = await col.find({
            $or: [
                { status: 'error' },
                { status: 'no_attachments' },
                { 'attachments.status': 'error' },
                { status: 'uploaded', attachments: { $size: 0 } },
                { status: 'uploaded', 'attachments.0': { $exists: false } },
            ]
        }).toArray();

        console.log(`🔁 retry_errors: ${errorLogs.length} emails com problema encontrados`);

        if (errorLogs.length === 0) {
            return res.status(200).json({ ok: true, summary: { emails_processed: 0, att_uploaded: 0, att_duplicate: 0, att_error: 0 } });
        }

        // Processa diretamente os message IDs dos logs com erro — sem varrer todos os emails
        const { processSpecificMessages } = await import('../lib/processor.js');
        const messageIds = errorLogs.map(l => ({ id: l.gmail_message_id, threadId: l.gmail_thread_id }));
        const summary = await processSpecificMessages(messageIds);

        return res.status(200).json({
            ok: true,
            summary: {
                emails_processed: summary.emails_processed || 0,
                att_uploaded:     summary.att_uploaded || 0,
                att_duplicate:    summary.att_duplicate || 0,
                att_error:        summary.att_error || 0,
            }
        });
    }

    // Modo "continue" (cron horário): só processa se houver checkpoint ativo
    const continueMode = req.query?.continue === '1';
    if (continueMode) {
        const existing = await getCheckpoint(checkpointKey);
        if (!existing?.next_offset) {
            return res.status(200).json({ ok: true, message: 'Nenhum checkpoint ativo. Nada a fazer.' });
        }
        console.log(`⏰ Cron continue: retomando checkpoint offset ${existing.next_offset}/${existing.total_found}`);
    } // padrão: true (lidos e não lidos)
    // Verifica se há checkpoint salvo (continuação automática)
    const forceRestart = req.body?.restart === true;
    let checkpoint = forceRestart ? null : await getCheckpoint(checkpointKey);

    // Se o checkpoint é de um período diferente OU de includeRead diferente → reinicia
    if (checkpoint) {
        const sameDays = checkpoint.days === days;
        const sameRead = checkpoint.includeRead === undefined || checkpoint.includeRead === includeRead;
        if (!sameDays || !sameRead) {
            console.log(`⚠️ Checkpoint incompatível (days: ${checkpoint.days}→${days}, read: ${checkpoint.includeRead}→${includeRead}) — reiniciando`);
            checkpoint = null;
            await clearCheckpoint(checkpointKey);
        }
    }

    const startOffset  = checkpoint?.next_offset || parseInt(req.body?.offset) || 0;
    const effectiveDays = checkpoint?.days || days;
    const effectiveRead  = checkpoint?.includeRead !== undefined ? checkpoint.includeRead : includeRead;
    const totalFound   = checkpoint?.total_found || 0;

    console.log(`📌 ${checkpoint ? `Retomando checkpoint: offset ${startOffset}/${totalFound}` : 'Início fresh'}`);

    try {
        const started    = Date.now();
        const TIME_LIMIT = 250_000; // 250s de margem
        let offset       = startOffset;
        let lastSummary  = null;
        let iterations   = 0;

        while (true) {
            iterations++;
            console.log(`\n🔄 Iteração ${iterations} — offset: ${offset}`);

            const summary = await run({ sinceDate, days: effectiveDays, includeRead: effectiveRead, offset, batchSize: 60, prevOldestDate: checkpoint?.oldest_date_seen || null });
            lastSummary   = summary;
            offset        = summary.next_offset || 0;

            const elapsed = Date.now() - started;
            console.log(`⏱ ${elapsed}ms | has_more: ${summary.has_more} | next_offset: ${offset} | total: ${summary.total_found}`);

            if (!summary.has_more) {
                // Concluído — apaga checkpoint
                await clearCheckpoint(checkpointKey);
                console.log(`✅ Varredura completa! ${summary.total_found} emails processados.`);
                break;
            }

            // Salva checkpoint a cada iteração (garante continuidade mesmo em timeout abrupto)
            await saveCheckpoint({
                days: effectiveDays,
                includeRead,
                next_offset: offset,
                total_found: summary.total_found,
                since_date: sinceDate?.toISOString() || null,
                started_at: checkpoint?.started_at || new Date().toISOString(),
                oldest_date_seen: summary.oldest_date_seen || checkpoint?.oldest_date_seen || null,  // mantém o mais antigo de todos os lotes
            }, checkpointKey);

            if (elapsed > TIME_LIMIT) {
                console.log(`⏸ Checkpoint salvo: offset ${offset}/${summary.total_found}`);

                return res.status(200).json({
                    ok: true,
                    ran_at: new Date().toISOString(),
                    incomplete: true,
                    next_offset: offset,
                    total_found: summary.total_found,
                    pct: Math.round(offset / summary.total_found * 100),
                    oldest_date_seen: summary.oldest_date_seen || null,
                    message: `${offset} de ${summary.total_found} emails (${Math.round(offset / summary.total_found * 100)}%). Clique em Processar para continuar.`,
                    ...lastSummary,
                });
            }

            await new Promise(r => setTimeout(r, 300));
        }

        return res.status(200).json({ ok: true, ran_at: new Date().toISOString(), iterations, complete: true, oldest_date_seen: lastSummary?.oldest_date_seen || null, ...lastSummary });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ ok: false, error: err.message });
    }
}