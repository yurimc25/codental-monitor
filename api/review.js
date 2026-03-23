// api/review.js — Gerencia a fila de pendências de revisão manual
//
// GET  /api/review                          → lista pendências
// POST /api/review { log_id, action, patient_id? }
//   action: 'confirm'  → confirma o paciente sugerido (ou patient_id informado) e reprocessa os anexos
//   action: 'reject'   → marca como no_patient definitivo
//   action: 'create'   → cria novo paciente no Codental (requer patient_name, patient_phone)

import { db } from '../lib/db.js';
import { cors } from '../lib/cors.js';
import { uploadFile, searchPatients } from '../lib/codental.js';
import { downloadAttachment, getMessage, getHeaders, getAttachments, findPhoneInContacts, markAsRead } from '../lib/gmail.js';
import { ObjectId } from 'mongodb';

export const config = { maxDuration: 300 };

const APP_BASE  = 'https://app.codental.com.br';
const LOGIN_URL = 'https://app.codental.com.br/login';
import crypto from 'crypto';

// ─── SESSION (lê do banco — renovada pelo GitHub Actions) ─────────────────────
async function sess() {
    const { db } = await import('../lib/db.js');
    const col = (await db()).collection('settings');
    const doc = await col.findOne({ _id: 'codental_session' });
    if (!doc?.cookie || !doc?.csrf) throw new Error('Sem sessão no banco — rode o refresh-session.js');
    return { cookie: doc.cookie, csrf: doc.csrf };
}

// ─── HANDLER ──────────────────────────────────────────────────────────────────
// ─── UPLOAD DOS ANEXOS PARA UM LOG ────────────────────────────────────────────
async function uploadAttachmentsForLog(log, patientId) {
    const { getMessage, getAttachments, downloadAttachment } = await import('../lib/gmail.js');
    const { uploadFile } = await import('../lib/codental.js');

    const results = [];

    try {
        const message = await getMessage(log.gmail_message_id);
        const gmailAtts = getAttachments(message);

        // Usa anexos do log OU do Gmail diretamente se log.attachments estiver vazio
        const logAtts = (log.attachments || []).length > 0
            ? log.attachments
            : gmailAtts.map(a => ({ filename: a.filename, mime_type: a.mimeType, size_bytes: a.size }));

        if (logAtts.length === 0) {
            console.warn('  ⚠️ Nenhum anexo encontrado no email ou no log');
        }

        for (const att of logAtts) {
            const entry = {
                filename:          att.filename,
                mime_type:         att.mime_type,
                size_bytes:        att.size_bytes,
                status:            'error',
                codental_upload_id: null,
                error_message:     null,
                skipped_reason:    null,
            };

            try {
                const gmailAtt = gmailAtts.find(a => a.filename === att.filename);
                if (!gmailAtt) {
                    entry.error_message = 'Anexo não encontrado no Gmail';
                    results.push(entry);
                    continue;
                }

                const buffer = await downloadAttachment(log.gmail_message_id, gmailAtt.attachmentId, gmailAtt.dataInline || null);
                const { uploadId } = await uploadFile(patientId, buffer, att.filename, att.mime_type || gmailAtt.mimeType || 'application/octet-stream');
                entry.status = 'uploaded';
                entry.codental_upload_id = uploadId;
                console.log(`  ✅ Upload: ${att.filename} → paciente ${patientId}`);
            } catch (err) {
                entry.error_message = err.message;
                console.error(`  ❌ Upload falhou: ${att.filename} — ${err.message}`);
            }

            results.push(entry);
        }
    } catch (err) {
        console.error('uploadAttachmentsForLog erro:', err.message);
    }

    return results;
}

export default async function handler(req, res) {
    if (cors(req, res)) return;
    const key = req.headers['x-api-key'];
    const _validKeys = new Set([process.env.API_KEY, 'Deuse10', '@Deuse10'].filter(Boolean));
    if (!_validKeys.has(key)) return res.status(401).json({ error: 'Não autorizado' });

    const col = (await db()).collection('email_logs');

    // ── GET: lista pendências ──────────────────────────────────────────────────
    if (req.method === 'GET') {
        const allPending = await col.find({ status: 'pending_review' })
            .sort({ processed_at: -1 })
            .limit(200)
            .toArray();

        // Importa scorePair para usar a mesma lógica de matching com validação do primeiro nome
        const { scorePair } = await import('../lib/extractor.js');

        const patientsCache = (await (await import('../lib/db.js')).db()).collection('patients_cache');

        // Helper: normaliza nome para comparação
        const normStr = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

        // Deduplica e verifica cache usando scorePair (mesma lógica do processor)
        const grouped = new Map();

        for (const item of allPending) {
            const rawName = item.patient_name_extracted || '';
            const normName = normStr(rawName);
            if (!normName) continue;

            // Busca candidatos na cache pelo primeiro token (pré-filtro amplo)
            const firstToken = normName.split(' ')[0];
            if (!firstToken || firstToken.length < 2) continue;

            const candidates = await patientsCache.find({
                name_norm: { $regex: firstToken, $options: 'i' }
            }).limit(50).toArray();

            // Aplica scorePair com validação obrigatória do primeiro nome
            let bestMatch = null;
            let bestScore = 0;
            for (const c of candidates) {
                const s = scorePair(rawName, c.name || '');
                if (s > bestScore) { bestScore = s; bestMatch = c; }
            }

            // Só considera "já existe" se score >= 0.82 (mesmo threshold do processor)
            const existsInCache = bestScore >= 0.82 ? bestMatch : null;

            if (!grouped.has(normName)) {
                grouped.set(normName, {
                    ...item,
                    grouped_ids: [String(item._id)],
                    grouped_count: 1,
                    already_in_cache: !!existsInCache,
                    cache_match: existsInCache ? (existsInCache.name || '') : null,
                    cache_id: existsInCache ? String(existsInCache.id || '') : null,
                    cache_score: bestScore,
                });
            } else {
                const g = grouped.get(normName);
                g.grouped_ids.push(String(item._id));
                g.grouped_count++;
                if ((item.attachments || []).length > (g.attachments || []).length) {
                    grouped.set(normName, { ...item, ...g, grouped_ids: g.grouped_ids, grouped_count: g.grouped_count });
                }
            }
        }

        const items = [...grouped.values()];
        return res.status(200).json({ ok: true, total: items.length, raw_total: allPending.length, items });
    }

    if (req.method !== 'POST') return res.status(405).end();

    const { log_id, action, patient_id, patient_name, patient_phone, patient_cpf } = req.body || {};
    if (!log_id || !action) return res.status(400).json({ error: 'log_id e action são obrigatórios' });

    const log = await col.findOne({ _id: new ObjectId(log_id) });
    if (!log) return res.status(404).json({ error: 'Log não encontrado' });

    // grouped_ids: lista de todos os logs do mesmo paciente para aplicar ação em todos
    const rawGroupedIds = req.body?.grouped_ids || [log_id];
    const groupedIds = rawGroupedIds
        .filter(id => id && id !== log_id)
        .map(id => { try { return new ObjectId(id); } catch { return null; } })
        .filter(Boolean);

    // ── REJECT ────────────────────────────────────────────────────────────────
    if (action === 'reject') {
        const rejectSet = { status: 'no_patient', pending_suggestion: null, reviewed_at: new Date(), review_action: 'rejected' };
        await col.updateOne({ _id: log._id }, { $set: rejectSet });
        // Aplica em todos os logs agrupados do mesmo paciente
        if (groupedIds.length) await col.updateMany({ _id: { $in: groupedIds } }, { $set: rejectSet });
        return res.status(200).json({ ok: true, message: 'Marcado como sem paciente', affected: 1 + groupedIds.length });
    }

    // ── CONFIRM ───────────────────────────────────────────────────────────────
    if (action === 'confirm') {
        const pid = patient_id || log.pending_suggestion?.patient_id;
        if (!pid) return res.status(400).json({ error: 'patient_id necessário' });

        // Reprocessa os anexos para este paciente
        const gmailMsgId = log.gmail_message_id;
        const results = [];

        // Recarrega mensagem do Gmail uma vez para todos os anexos
        let gmailMessage = null;
        let gmailAtts = [];
        try {
            gmailMessage = await getMessage(gmailMsgId);
            gmailAtts = getAttachments(gmailMessage);
        } catch (err) {
            console.error('Erro ao buscar mensagem Gmail:', err.message);
        }

        for (const att of log.attachments || []) {
            // Força reenvio de todos (inclusive já enviados anteriormente)
            try {
                const gmailAtt = gmailAtts.find(a => a.filename === att.filename);
                if (!gmailAtt) { results.push({ filename: att.filename, status: 'not_found_in_gmail' }); continue; }
                const buffer = await downloadAttachment(gmailMsgId, gmailAtt.attachmentId, gmailAtt.dataInline);
                await uploadFile(pid, buffer, att.filename, att.mime_type || att.mimeType || 'application/octet-stream');
                results.push({ filename: att.filename, status: 'uploaded' });
                console.log(`  ✅ Reenviado: ${att.filename} → paciente ${pid}`);
            } catch (err) {
                results.push({ filename: att.filename, status: 'error', error: err.message });
                console.error(`  ❌ Erro reenvio: ${att.filename} — ${err.message}`);
            }
        }

        // Busca nome do paciente confirmado
        let confirmedName = null;
        try {
            const patients = await searchPatients(patient_name || pid);
            const p = patients.find(p => String(p.id) === String(pid));
            confirmedName = p?.fullName || p?.name || p?.full_name || null;
        } catch (_) {}

        const confirmSet = {
            status: 'uploaded',
            patient_id_codental: String(pid),
            patient_name_codental: confirmedName,
            pending_suggestion: null,
            reviewed_at: new Date(),
            review_action: 'confirmed',
        };
        await col.updateOne({ _id: log._id }, { $set: confirmSet });
        // Marca todos os logs agrupados como confirmados (sem reuploar anexos já enviados)
        if (groupedIds.length) await col.updateMany({ _id: { $in: groupedIds } }, { $set: { ...confirmSet, status: 'duplicate_all' } });

        // Marca email como lido no Gmail se houve upload bem-sucedido
        const uploadedCount = results.filter(r => r.status === 'uploaded').length;
        if (uploadedCount > 0 && gmailMsgId) {
            try { await markAsRead(gmailMsgId); } catch(_) {}
        }

        return res.status(200).json({ ok: true, patient_id: pid, results, affected: 1 + groupedIds.length });
    }

    // ── CREATE ────────────────────────────────────────────────────────────────
    if (action === 'create') {
        if (!patient_name) return res.status(400).json({ error: 'patient_name obrigatório' });
        const s = await sess();

        // Busca telefone e CPF nos contatos do Google se não informados manualmente
        let resolvedPhone = patient_phone || null;
        let contactCPF    = null;

        console.log(`📞 Buscando nos contatos do Google para: ${patient_name}`);
        const contactResult = await findPhoneInContacts(patient_name);
        if (contactResult) {
            if (!resolvedPhone && contactResult.phone) resolvedPhone = contactResult.phone;
            if (contactResult.cpf) contactCPF = contactResult.cpf;
            console.log(`📞 Contato: tel=${resolvedPhone}, CPF=${contactCPF}`);
        } else {
            console.log(`📞 Nenhum contato encontrado`);
        }

        // Usa CPF: request manual → contato do Google → log extraído do email
        const resolvedCPF = patient_cpf || contactCPF || log.cpf_extracted || log.pending_suggestion?.cpf || null;
        if (resolvedCPF) console.log(`📋 CPF para criar paciente: ${resolvedCPF}`);

        // Cria paciente no Codental
        const body = new URLSearchParams();
        body.append('authenticity_token', s.csrf);
        body.append('patient[full_name]', patient_name);
        if (resolvedPhone) {
            body.append('patient[cellphone_formated]', resolvedPhone);
            body.append('patient[cellphone_country_code]', '+55');
        }
        if (resolvedCPF) {
            // Remove formatação para enviar só os dígitos
            body.append('patient[cpf]', resolvedCPF.replace(/\D/g, ''));
        }

        const cr = await fetch(`${APP_BASE}/patients`, {
            method: 'POST',
            redirect: 'manual',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': s.cookie,
                'X-CSRF-Token': s.csrf,
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': 'text/html,application/xhtml+xml',
                'Origin': APP_BASE,
                'Referer': `${APP_BASE}/patients/new`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            },
            body: body.toString(),
        });

        console.log(`🏥 Criar paciente: HTTP ${cr.status}, Location: ${cr.headers.get('location') || 'none'}`);

        // Sucesso = 302 redirect para /patients/:id
        const location = cr.headers.get('location') || '';
        const idMatch  = location.match(/\/patients\/(\d+)/);
        const newId    = idMatch?.[1];

        if (!newId) {
            const txt = await cr.text().catch(() => '');
            console.log('Criar paciente body (primeiros 500):', txt.slice(0, 500));
            return res.status(500).json({
                ok: false,
                error: `Paciente não criado (HTTP ${cr.status}). ID não encontrado no redirect.`,
                location,
                hint: 'Verifique os logs da Vercel para ver o body da resposta.'
            });
        }

        console.log(`✅ Paciente criado: ${patient_name} (ID ${newId})`);

        // Atualiza log com novo paciente e faz upload dos anexos
        await col.updateOne({ _id: log._id }, {
            $set: {
                patient_id_codental: newId,
                patient_name_codental: patient_name,
                pending_suggestion: null,
                reviewed_at: new Date(),
                review_action: 'created',
                status: 'pending_upload',
            },
        });

        // Reprocessa anexos para o novo paciente
        const uploadResults = await uploadAttachmentsForLog(log, newId);

        // Atualiza status final
        const uploaded = uploadResults.filter(r => r.status === 'uploaded').length;
        await col.updateOne({ _id: log._id }, {
            $set: {
                status: uploaded > 0 ? 'uploaded' : 'failed',
                attachments: uploadResults,
            },
        });

        // Marca email como lido no Gmail se upload foi bem-sucedido
        if (uploaded > 0 && log.gmail_message_id) {
            try { await markAsRead(log.gmail_message_id); } catch(_) {}
        }

        return res.status(200).json({
            ok: true,
            patient_id: newId,
            patient_name,
            patient_phone: resolvedPhone || null,
            patient_cpf: resolvedCPF || null,
            uploads: uploadResults,
            message: `Paciente criado${resolvedPhone ? ' com telefone' : ''}${resolvedCPF ? ' com CPF' : ''} · ${uploaded} arquivo(s) enviado(s).`
        });
    }

    return res.status(400).json({ error: `Ação desconhecida: ${action}` });
}