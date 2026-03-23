// lib/processor.js — Pipeline principal: não lidos → upload → marcar como lido

import {
    fetchUnreadMessages, getMessage, getHeaders, getBody,
    getAttachments, downloadAttachment, markAsRead, detectKeywords,
} from './gmail.js';
import { searchPatients, uploadFile } from './codental.js';
import { searchPatientsWithFallback } from './patientSearch.js';
import { extractNames, bestMatch, matchWithSuggestions, nameSearchVariants } from './extractor.js';
import { db, getSettings, isProcessed, getExistingLog, saveLog, ensureIndexes } from './db.js';

/**
 * @param {{ sinceDate?: Date|null, days?: number, includeRead?: boolean }} opts
 *   days: quantos dias retroativos buscar (padrão: 2 para cron, configurável no manual)
 *   includeRead: se true, inclui emails já lidos (padrão: true — sempre reprocessa)
 *   sinceDate: data específica (sobrescreve days)
 */
export async function run({ sinceDate = null, days = 2, includeRead = true, offset = 0, batchSize = 80, prevOldestDate = null } = {}) {
    await ensureIndexes();
    const settings = await getSettings();
    const keywords = Array.isArray(settings.keywords) && settings.keywords.length > 0
        ? settings.keywords
        : ['tomografia', 'voxels', 'fenelon', 'radiomaster', 'documentacao', 'cbct', 'radiografia', 'laudo'];

    console.log('🚀 Pipeline iniciado');
    // Mapa de arquivos já enviados — carrega do histórico MongoDB + acumula durante o lote
    // Chaves: "patientId:sizeBytes:ext" e "patientId:filename_lower"
    const batchUploaded = new Map();

    // Pré-carrega histórico de uploads bem-sucedidos do MongoDB
    try {
        const col = (await db()).collection('email_logs');
        const uploadedLogs = await col.find({
            'attachments.status': 'uploaded',
            patient_id_codental: { $exists: true, $ne: null },
        }).toArray();

        for (const log of uploadedLogs) {
            const pid = log.patient_id_codental;
            for (const att of (log.attachments || [])) {
                if (att.status !== 'uploaded') continue;
                const fn  = (att.filename || '').toLowerCase();
                const ext = fn.split('.').pop();
                const sz  = att.size_bytes;
                if (fn)  batchUploaded.set(`${pid}:${fn}`,       { filename: att.filename, messageId: log.gmail_message_id, fromHistory: true });
                if (sz)  batchUploaded.set(`${pid}:${sz}:${ext}`, { filename: att.filename, messageId: log.gmail_message_id, fromHistory: true });
            }
        }
        console.log(`📚 Histórico carregado: ${batchUploaded.size} entradas de ${uploadedLogs.length} logs`);
    } catch (err) {
        console.warn(`⚠️ Erro ao carregar histórico: ${err.message}`);
    }

    const summary = {
        emails_found: 0,
        emails_skipped: 0,
        emails_processed: 0,
        att_uploaded: 0,
        att_duplicate: 0,
        att_error: 0,
        no_patient: 0,
        marked_read: 0,
        since_date: sinceDate ? sinceDate.toISOString() : new Date(Date.now() - days * 86400000).toISOString(),
        errors: [],
    };

    // 1. Busca não lidos (com filtro de data opcional)
    // Calcula data de início: sinceDate explícita ou N dias atrás
    const effectiveSince = sinceDate || new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    console.log(`📅 Buscando emails desde ${effectiveSince.toISOString().slice(0,10)} (includeRead: ${includeRead})`);

    // Busca TODOS os emails com paginação completa
    // A API retorna em ordem do mais recente para o mais antigo
    const messages = await fetchUnreadMessages(keywords, effectiveSince, includeRead);
    summary.emails_found = messages.length;

    // Aplica offset para continuar de onde parou (paginação de processamento)
    const batchSz  = batchSize;
    const batch    = messages.slice(offset, offset + batchSz);
    const hasMore  = (offset + batchSz) < messages.length;

    console.log(`📧 ${messages.length} email(s) total | lote: ${offset}–${offset + batch.length} | tem mais: ${hasMore}`);
    summary.total_found       = messages.length;
    summary.offset            = offset;
    summary.next_offset       = hasMore ? offset + batchSz : null;
    summary.has_more          = hasMore;
    // helper: atualiza datas min/max (persiste entre lotes via opts)
    const trackDate = (d) => {
        if (!d) return;
        const t = new Date(d).getTime();
        if (isNaN(t)) return;
        if (!summary.oldest_date_seen || t < new Date(summary.oldest_date_seen).getTime())
            summary.oldest_date_seen = new Date(d).toISOString();
        if (!summary.newest_date_seen || t > new Date(summary.newest_date_seen).getTime())
            summary.newest_date_seen = new Date(d).toISOString();
    };
    // Inicializa com valor do checkpoint anterior (mantém histórico entre lotes)
    summary.oldest_date_seen = prevOldestDate || null;
    summary.newest_date_seen = null;

    for (const { id: messageId, threadId } of batch) {
        try {
            // Já processado? Verifica se todos os anexos foram enviados com sucesso
            // Se houve limpeza geral (purge), permite reprocessar
            if (await isProcessed(messageId)) {
                // Log existe — verifica se foi totalmente enviado com sucesso
                const existing = await getExistingLog(messageId);
                const fullyUploaded = existing?.status === 'uploaded'
                    && (existing?.attachments || []).some(a => a.status === 'uploaded');

                if (fullyUploaded) {
                    // Já foi enviado com sucesso → pula
                    trackDate(existing?.date);
                    summary.emails_skipped++;
                    continue;
                }

                // Ignorado manualmente pelo usuário → não reprocessa nunca
                if (existing?.review_action === 'rejected' || existing?.review_action === 'ignore') {
                    trackDate(existing?.date);
                    summary.emails_skipped++;
                    continue;
                }

                // Sem paciente E sem anexos (email interno, avisos, etc) → não reprocessa
                if (existing?.status === 'no_patient' && !(existing?.attachments?.length)) {
                    trackDate(existing?.date);
                    summary.emails_skipped++;
                    continue;
                }

                // pending_review com sugestão já revisada e rejeitada → não reprocessa
                if (existing?.status === 'no_patient' && existing?.reviewed_at) {
                    trackDate(existing?.date);
                    summary.emails_skipped++;
                    continue;
                }

                // Status diferente → reprocessa
                console.log(`🔄 Reprocessando ${messageId} (status anterior: ${existing?.status})`);
            }

            const result = await processMessage(messageId, threadId, keywords, batchUploaded);
            trackDate(result.date);
            summary.emails_processed++;
            summary.att_uploaded += result.att_uploaded;
            summary.att_duplicate += result.att_duplicate;
            summary.att_error += result.att_error;
            if (result.status === 'no_patient') summary.no_patient++;

            // Marca como lido APENAS se upload foi bem-sucedido
            if (result.status === 'uploaded') {
                await markAsRead(messageId);
                summary.marked_read++;
            }

        } catch (err) {
            console.error(`❌ Erro fatal no email ${messageId}:`, err.message);
            summary.errors.push({ messageId, error: err.message });

            // Se foi erro de autenticação Codental, invalida sessão para próxima tentativa
            if (err.message?.includes('_domain_session') || err.message?.includes('Login Codental')) {
                try {
                    const { invalidateSession } = await import('./codental.js');
                    invalidateSession();
                    console.warn('🔑 Sessão Codental invalidada — será renovada na próxima tentativa');
                } catch (_) {}
            }

            // Salva status de erro no log para não perder o email
            try {
                await saveLog({
                    gmail_message_id: messageId,
                    gmail_thread_id: threadId,
                    status: 'failed',
                    error_message: err.message,
                    processed_at: new Date(),
                });
            } catch (_) {}
        }
    }

    console.log('✅ Pipeline concluído:', summary);
    return summary;
}

// ─── PROCESSAR UMA MENSAGEM ───────────────────────────────────────────────────

async function processMessage(messageId, threadId, keywords, batchUploaded) {
    const message = await getMessage(messageId);
    const { subject, from, date } = getHeaders(message);
    const body = getBody(message);
    const attachments = getAttachments(message);

    console.log(`\n📨 "${subject}" de ${from}`);

    const log = {
        gmail_message_id: messageId,
        gmail_thread_id: threadId,
        subject,
        from,
        date,
        patient_name_extracted: null,
        patient_id_codental: null,
        patient_name_codental: null,
        keywords_matched: detectKeywords(`${subject}\n${body}`, keywords),
        attachments: [],
        status: null,
        marked_read: false,
    };

    const result = { att_uploaded: 0, att_duplicate: 0, att_error: 0, status: null, date: date || null };

    // Sem anexos relevantes
    if (attachments.length === 0) {
        log.status = 'no_attachments';
        await saveLog(log);
        return { ...result, status: 'no_attachments' };
    }

    // ── Identificar paciente ─────────────────────────────────────────────────
    const nameCandidates = extractNames(subject, body);
    console.log(`  👤 Candidatos: ${nameCandidates.map(c => `${c.name}[${c.confidence}]`).join(', ') || 'nenhum'}`);

    let patientMatch = null;
    let pendingSuggestion = null;

    for (const cand of nameCandidates) {
        // Busca com variantes do nome para melhorar recall
        // Busca com fallback: base local → API Codental
        const { patients: allPatients, source } = await searchPatientsWithFallback(cand.name);
        console.log(`  🔍 "${cand.name}" (${source}): ${allPatients.length} resultado(s)${allPatients[0] ? ' — melhor: ' + (allPatients[0].name||'?') : ''}`);

        const { auto, suggestion } = matchWithSuggestions([cand], allPatients);

        if (auto) {
            patientMatch = auto;
            log.patient_name_extracted = cand.name;
            log.patient_id_codental = String(auto.patient.id);
            log.patient_name_codental = auto.patient.fullName || auto.patient.name || auto.patient.full_name || null;
            log.match_score = auto.score;
            console.log(`  ✅ Paciente: ${log.patient_name_codental} (ID ${log.patient_id_codental}, score ${auto.score.toFixed(2)})`);
            break;
        }
        if (suggestion && (!pendingSuggestion || suggestion.score > pendingSuggestion.score)) {
            pendingSuggestion = { ...suggestion, candidateName: cand.name };
        }
    }

    if (!patientMatch) {
        log.patient_name_extracted = nameCandidates[0]?.name || null;

        // Verifica se este paciente já foi confirmado em outro email (pelo nome extraído)
        if (log.patient_name_extracted) {
            const col = (await db()).collection('email_logs');
            const alreadyConfirmed = await col.findOne({
                patient_name_extracted: { $regex: new RegExp('^' + log.patient_name_extracted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') },
                status: 'uploaded',
                review_action: { $in: ['confirmed', 'created'] },
            });
            if (alreadyConfirmed) {
                // Paciente já confirmado — mas ainda precisa enviar os anexos deste email
                log.patient_id_codental = alreadyConfirmed.patient_id_codental;
                log.patient_name_codental = alreadyConfirmed.patient_name_codental;
                console.log(`  📎 Paciente já confirmado: ${log.patient_name_extracted} → enviando anexos deste email`);
                // Não retorna aqui — continua para enviar os anexos
                pendingSuggestion = {
                    patient: { id: alreadyConfirmed.patient_id_codental, name: alreadyConfirmed.patient_name_codental },
                    score: 1.0,
                    confirmed: true,
                };
            }
        }

        if (pendingSuggestion) {
            log.status = 'pending_review';
            log.pending_suggestion = {
                patient_id:   String(pendingSuggestion.patient.id),
                patient_name: pendingSuggestion.patient.name || pendingSuggestion.patient.full_name || '',
                score:        pendingSuggestion.score,
                candidate:    pendingSuggestion.candidateName,
            };
            console.log(`  ⏳ Pendente: sugerindo "${log.pending_suggestion.patient_name}" (score ${pendingSuggestion.score.toFixed(2)})`);
        } else {
            log.status = 'no_patient';
            console.log(`  ❌ Paciente nao identificado: ${log.patient_name_extracted}`);
        }
        await saveLog(log);
        return { ...result, status: log.status };
    }
    const patientId = patientMatch.patient.id;

    // ── Processar cada anexo ─────────────────────────────────────────────────
    for (const att of attachments) {
        const attLog = {
            filename: att.filename,
            mime_type: att.mimeType,
            size_bytes: att.size,
            status: null,
            codental_upload_id: null,
            error_message: null,
            skipped_reason: null,
        };

        try {
            // Verifica duplicata
            const buffer = await downloadAttachment(messageId, att.attachmentId, att.dataInline || null);

            // 1. Verifica duplicata dentro do lote atual (mesma execução)
            const batchKey = `${patientId}:${buffer.length}:${att.filename.split('.').pop().toLowerCase()}`;
            const batchNameKey = `${patientId}:${att.filename.toLowerCase()}`;
            const batchPrev = batchUploaded.get(batchKey) || batchUploaded.get(batchNameKey);
            if (batchPrev) {
                const src = batchPrev.fromHistory ? 'histórico' : 'lote atual';
                console.log(`  ⏭ Duplicata (${src}): ${att.filename} == ${batchPrev.filename}`);
                attLog.status = 'skipped_duplicate';
                attLog.skipped_reason = `Duplicata de ${batchPrev.filename} (${src})`;
                result.att_duplicate++;
                log.attachments.push(attLog);
                continue;
            }

            // (verificação no Codental removida — usa só dedup em memória, igual à simulação)

            console.log(`  ⬇ Arquivo: ${att.filename} (${(att.size / 1024).toFixed(1)} KB)`);

            // Upload
            const { uploadId } = await uploadFile(patientId, buffer, att.filename, att.mimeType);
            attLog.status = 'uploaded';
            attLog.codental_upload_id = uploadId;
            result.att_uploaded++;
            // Registra no mapa do lote para evitar reenvio no mesmo processamento
            batchUploaded.set(batchKey, { filename: att.filename, messageId });
            batchUploaded.set(batchNameKey, { filename: att.filename, messageId });
            console.log(`  ✅ Upload OK: ${att.filename}`);

        } catch (err) {
            attLog.status = 'error';
            attLog.error_message = err.message;
            result.att_error++;
            console.error(`  ❌ Erro: ${att.filename} — ${err.message}`);
        }

        log.attachments.push(attLog);
    }

    // Status geral do email
    const ok = result.att_uploaded;
    const dup = result.att_duplicate;
    const err = result.att_error;
    const total = log.attachments.length;

    if (ok === 0 && dup === total) log.status = 'duplicate_all';
    else if (ok > 0 && err === 0) log.status = 'uploaded';
    else if (ok > 0 && err > 0) log.status = 'partial';
    else if (ok === 0 && err > 0) log.status = 'failed';
    else log.status = 'uploaded';

    log.marked_read = true;
    await saveLog(log);
    result.status = log.status;
    return result;
}