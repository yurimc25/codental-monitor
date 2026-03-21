// api/review.js — Gerencia a fila de pendências de revisão manual
//
// GET  /api/review                          → lista pendências
// POST /api/review { log_id, action, patient_id? }
//   action: 'confirm'  → confirma o paciente sugerido (ou patient_id informado) e reprocessa os anexos
//   action: 'reject'   → marca como no_patient definitivo
//   action: 'create'   → cria novo paciente no Codental (requer patient_name, patient_phone)

import { db } from '../lib/db.js';
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
export default async function handler(req, res) {
    const key = req.headers['x-api-key'];
    if (key !== process.env.API_KEY) return res.status(401).json({ error: 'Não autorizado' });

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
        await col.updateOne({ _id: log._id }, { $set: { status: 'no_patient', pending_suggestion: null, reviewed_at: new Date() } });
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
            confirmedName = p?.name || p?.full_name || null;
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
        const form = new FormData();
        form.append('patient[name]', patient_name);
        if (patient_phone) form.append('patient[phone]', patient_phone);

        const cr = await fetch(`${APP_BASE}/patients`, {
            method: 'POST',
            headers: {
                'Cookie': s.cookie,
                'X-CSRF-Token': s.csrf,
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': 'application/json, text/html',
                'User-Agent': 'Mozilla/5.0',
            },
            body: form,
        });

        if (!cr.ok && cr.status !== 302) {
            const txt = await cr.text().catch(() => '');
            return res.status(500).json({ ok: false, error: `Criação falhou: HTTP ${cr.status}`, detail: txt.slice(0, 200) });
        }

        // Extrai ID do novo paciente da Location header
        const location = cr.headers.get('location') || '';
        const idMatch  = location.match(/\/patients\/(\d+)/);
        const newId    = idMatch?.[1];

        if (!newId) {
            return res.status(200).json({ ok: true, warning: 'Paciente criado mas ID não obtido. Confirme manualmente no Codental.', location });
        }

        // Marca o log com o novo paciente
        await col.updateOne({ _id: log._id }, {
            $set: {
                patient_id_codental: newId,
                patient_name_codental: patient_name,
                pending_suggestion: null,
                reviewed_at: new Date(),
                review_action: 'created',
            },
        });

        return res.status(200).json({ ok: true, patient_id: newId, patient_name, message: 'Paciente criado. Use "confirm" para enviar os anexos.' });
    }

    return res.status(400).json({ error: `Ação desconhecida: ${action}` });
}
