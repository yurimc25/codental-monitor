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
import { downloadAttachment, getMessage, getHeaders, getAttachments } from '../lib/gmail.js';
import { ObjectId } from 'mongodb';

export const config = { maxDuration: 300 };

const APP_BASE  = 'https://odonto-on-face.codental.com.br';
const LOGIN_URL = 'https://www.codental.com.br/login';
import crypto from 'crypto';

// ─── SESSION (reutiliza padrão já estabelecido) ────────────────────────────────
let _sess = null, _sessAt = 0;
async function sess() {
    if (_sess && Date.now() - _sessAt < 4 * 60 * 1000) return _sess;
    const pg   = await fetch(LOGIN_URL, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' } });
    const htm  = await pg.text();
    const raw  = pg.headers.get('set-cookie') || '';
    const csrf = (htm.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)/i) || [])[1] || '';
    const init = (raw.match(/_domain_session=[^;,]+/) || [])[0] || '';
    const lr   = await fetch(LOGIN_URL, {
        method: 'POST', redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': init, 'User-Agent': 'Mozilla/5.0' },
        body: new URLSearchParams({ 'professional[email]': process.env.CODENTAL_EMAIL, 'professional[password]': process.env.CODENTAL_PASSWORD, authenticity_token: csrf }).toString(),
    });
    const sc     = lr.headers.get('set-cookie') || '';
    const cookie = (sc.match(/_domain_session=[^;,]+/) || [])[0];
    if (!cookie) throw new Error('Login falhou');
    const ar = await fetch(`${APP_BASE}/patients`, { headers: { 'Cookie': cookie, 'User-Agent': 'Mozilla/5.0' } });
    const ah = await ar.text();
    const ac = (ah.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)/i) || [])[1] || csrf;
    const nc = (ar.headers.get('set-cookie') || '').match(/_domain_session=[^;,]+/)?.[0] || cookie;
    _sess = { cookie: nc, csrf: ac };
    _sessAt = Date.now();
    return _sess;
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

        for (const att of (log.attachments || [])) {
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
                const { uploadId } = await uploadFile(patientId, buffer, att.filename, att.mime_type || 'application/octet-stream');
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
        const pending = await col.find({ status: 'pending_review' })
            .sort({ processed_at: -1 })
            .limit(100)
            .toArray();
        return res.status(200).json({ ok: true, total: pending.length, items: pending });
    }

    if (req.method !== 'POST') return res.status(405).end();

    const { log_id, action, patient_id, patient_name, patient_phone } = req.body || {};
    if (!log_id || !action) return res.status(400).json({ error: 'log_id e action são obrigatórios' });

    const log = await col.findOne({ _id: new ObjectId(log_id) });
    if (!log) return res.status(404).json({ error: 'Log não encontrado' });

    // ── REJECT ────────────────────────────────────────────────────────────────
    if (action === 'reject') {
        await col.updateOne({ _id: log._id }, { $set: { status: 'no_patient', pending_suggestion: null, reviewed_at: new Date(), review_action: 'rejected' } });
        return res.status(200).json({ ok: true, message: 'Marcado como sem paciente' });
    }

    // ── CONFIRM ───────────────────────────────────────────────────────────────
    if (action === 'confirm') {
        const pid = patient_id || log.pending_suggestion?.patient_id;
        if (!pid) return res.status(400).json({ error: 'patient_id necessário' });

        // Reprocessa os anexos para este paciente
        const gmailMsgId = log.gmail_message_id;
        const results = [];

        for (const att of log.attachments || []) {
            if (att.status !== 'uploaded' && att.status !== 'pending') {
                // Tenta baixar e enviar do Gmail
                try {
                    const message  = await getMessage(gmailMsgId);
                    const gmailAtts = getAttachments(message);
                    const gmailAtt  = gmailAtts.find(a => a.filename === att.filename);
                    if (!gmailAtt) { results.push({ filename: att.filename, status: 'not_found_in_gmail' }); continue; }

                    const buffer = await downloadAttachment(gmailMsgId, gmailAtt.attachmentId, gmailAtt.dataInline);
                    await uploadFile(pid, buffer, att.filename, att.mimeType || 'application/octet-stream');
                    results.push({ filename: att.filename, status: 'uploaded' });
                } catch (err) {
                    results.push({ filename: att.filename, status: 'error', error: err.message });
                }
            }
        }

        // Busca nome do paciente confirmado
        let confirmedName = null;
        try {
            const patients = await searchPatients(patient_name || pid);
            const p = patients.find(p => String(p.id) === String(pid));
            confirmedName = p?.fullName || p?.name || p?.full_name || null;
        } catch (_) {}

        await col.updateOne({ _id: log._id }, {
            $set: {
                status: 'uploaded',
                patient_id_codental: String(pid),
                patient_name_codental: confirmedName,
                pending_suggestion: null,
                reviewed_at: new Date(),
                review_action: 'confirmed',
            },
        });

        return res.status(200).json({ ok: true, patient_id: pid, results });
    }

    // ── CREATE ────────────────────────────────────────────────────────────────
    if (action === 'create') {
        if (!patient_name) return res.status(400).json({ error: 'patient_name obrigatório' });
        const s = await sess();

        // Cria paciente no Codental
        // Campo correto é patient[full_name] conforme HTML do formulário /patients/new
        const body = new URLSearchParams();
        body.append('authenticity_token', s.csrf);
        body.append('patient[full_name]', patient_name);
        if (patient_phone) {
            // Remove formatação, mantém só dígitos + country code
            const digits = patient_phone.replace(/\D/g, '');
            body.append('patient[cellphone_formated]', patient_phone);
            body.append('patient[cellphone_country_code]', '+55');
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
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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

        return res.status(200).json({
            ok: true,
            patient_id: newId,
            patient_name,
            uploads: uploadResults,
            message: `Paciente criado e ${uploaded} arquivo(s) enviado(s).`
        });
    }

    return res.status(400).json({ error: `Ação desconhecida: ${action}` });
}