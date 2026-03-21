// api/purge.js — Apaga do Codental TUDO que esta plataforma enviou
//
// GET  /api/purge                    → lista o que seria deletado (dry run)
// POST /api/purge                    → deleta tudo (todos os logs)
// POST /api/purge { log_ids: [...] } → deleta apenas logs específicos

import crypto from 'crypto';
import { db } from '../lib/db.js';

export const config = { maxDuration: 300 };

const APP_BASE  = 'https://odonto-on-face.codental.com.br';
const LOGIN_URL = 'https://www.codental.com.br/login';

// ─── SESSION ──────────────────────────────────────────────────────────────────
let _sess = null, _sessAt = 0;

async function sess() {
    if (_sess && Date.now() - _sessAt < 4 * 60 * 1000) return _sess;

    const pg  = await fetch(LOGIN_URL, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' } });
    const htm = await pg.text();
    const raw = pg.headers.get('set-cookie') || '';
    const csrf = (htm.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)/i) || [])[1] || '';
    const init = (raw.match(/_domain_session=[^;,]+/) || [])[0] || '';

    const lr = await fetch(LOGIN_URL, {
        method: 'POST', redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': init, 'User-Agent': 'Mozilla/5.0' },
        body: new URLSearchParams({
            'professional[email]':    process.env.CODENTAL_EMAIL,
            'professional[password]': process.env.CODENTAL_PASSWORD,
            authenticity_token: csrf,
        }).toString(),
    });

    const sc     = lr.headers.get('set-cookie') || '';
    const cookie = (sc.match(/_domain_session=[^;,]+/) || [])[0];
    if (!cookie) throw new Error('Login Codental falhou no purge');

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

    const dryRun = req.method === 'GET';

    try {
        const col = (await db()).collection('email_logs');

        // Busca todos os logs que tiveram uploads com codental_upload_id
        const filter = {};  // deleta todos os logs com uploads

        const logs = await col.find(filter).toArray();

        // Coleta todos os uploads registrados com ID do Codental
        const toDelete = [];
        for (const log of logs) {
            for (const att of log.attachments || []) {
                if (att.codental_upload_id && att.status === 'uploaded') {
                    toDelete.push({
                        log_id:           String(log._id),
                        patient_id:       log.patient_id_codental,
                        patient_name:     log.patient_name_codental || log.patient_name_extracted || '?',
                        upload_id:        att.codental_upload_id,
                        filename:         att.filename,
                        email_subject:    log.subject,
                        processed_at:     log.processed_at,
                    });
                }
            }
        }

        if (dryRun) {
            return res.status(200).json({
                ok: true,
                dry_run: true,
                total: toDelete.length,
                items: toDelete,
            });
        }

        // Executa as deleções
        let deleted = 0;
        const errors = [];

        for (const item of toDelete) {
            try {
                await deleteUpload(item.patient_id, item.upload_id);
                deleted++;
                console.log(`🗑 Deletado: ${item.filename} (paciente ${item.patient_id})`);

                // Marca como deletado no MongoDB
                await col.updateOne(
                    { _id: item.log_id, 'attachments.codental_upload_id': item.upload_id },
                    { $set: {
                        'attachments.$.status': 'purged',
                        'attachments.$.purged_at': new Date(),
                    }}
                );
            } catch (err) {
                console.error(`❌ ${item.filename}: ${err.message}`);
                errors.push({ ...item, error: err.message });
            }
        }

        return res.status(200).json({
            ok: true,
            dry_run: false,
            total: toDelete.length,
            deleted,
            errors: errors.length,
            error_details: errors,
        });

    } catch (err) {
        console.error('purge error:', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

// ─── DELETAR (POST _method=delete, Rails Turbo) ───────────────────────────────
async function deleteUpload(patientId, uploadId) {
    const s   = await sess();
    const url = `${APP_BASE}/patients/${patientId}/uploads/${uploadId}`;
    const r   = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type':       'application/x-www-form-urlencoded;charset=UTF-8',
            'Cookie':             s.cookie,
            'X-CSRF-Token':       s.csrf,
            'X-Requested-With':   'XMLHttpRequest',
            'X-Turbo-Request-Id': crypto.randomUUID(),
            'Accept':             'text/vnd.turbo-stream.html, text/html, application/xhtml+xml',
            'Origin':             APP_BASE,
            'Referer':            `${APP_BASE}/patients/${patientId}/uploads`,
            'User-Agent':         'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: new URLSearchParams({
            _method: 'delete',
            authenticity_token: s.csrf,
        }).toString(),
    });
    if (!r.ok && r.status !== 302 && r.status !== 204) {
        const txt = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}: ${txt.slice(0, 100)}`);
    }
}
