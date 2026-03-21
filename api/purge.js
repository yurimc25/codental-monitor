// api/purge.js — Limpa do Codental tudo que esta plataforma enviou
// Estratégia: para cada log com status=uploaded, acessa a página do paciente,
// encontra os uploads pelo nome do arquivo e deleta.
//
// GET  /api/purge  → dry run, lista o que seria deletado
// POST /api/purge  → executa a limpeza

import crypto from 'crypto';
import { db } from '../lib/db.js';

export const config = { maxDuration: 300 };

const APP_BASE  = 'https://odonto-on-face.codental.com.br';
const LOGIN_URL = 'https://www.codental.com.br/login';

// ─── SESSION ──────────────────────────────────────────────────────────────────
let _sess = null, _sessAt = 0;

async function sess() {
    if (_sess && Date.now() - _sessAt < 4 * 60 * 1000) return _sess;

    const pg   = await fetch(LOGIN_URL, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' } });
    const htm  = await pg.text();
    const raw  = pg.headers.get('set-cookie') || '';
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
    if (!cookie) throw new Error('Login Codental falhou');

    const ar = await fetch(`${APP_BASE}/patients`, { headers: { 'Cookie': cookie, 'User-Agent': 'Mozilla/5.0' } });
    const ah = await ar.text();
    const ac = (ah.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)/i) || [])[1] || csrf;
    const nc = (ar.headers.get('set-cookie') || '').match(/_domain_session=[^;,]+/)?.[0] || cookie;

    _sess = { cookie: nc, csrf: ac };
    _sessAt = Date.now();
    console.log('✅ Session OK para purge');
    return _sess;
}

// ─── HANDLER ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
    const key = req.headers['x-api-key'];
    if (key !== process.env.API_KEY) return res.status(401).json({ error: 'Não autorizado' });

    const dryRun = req.method === 'GET';

    try {
        const col = (await db()).collection('email_logs');

        // Busca todos os logs com uploads bem-sucedidos
        const logs = await col.find({
            status: { $in: ['uploaded', 'partial'] },
            'attachments.status': 'uploaded',
        }).toArray();

        console.log(`📋 ${logs.length} logs com uploads encontrados`);
        
        // Debug: log first attachment to verify structure
        if (logs[0]?.attachments?.[0]) {
            console.log('Sample attachment:', JSON.stringify(logs[0].attachments[0]));
        }

        // Agrupa por paciente → lista de filenames a deletar
        const byPatient = {};
        for (const log of logs) {
            const pid = log.patient_id_codental;
            if (!pid) continue;
            if (!byPatient[pid]) {
                byPatient[pid] = {
                    patient_id:   pid,
                    patient_name: log.patient_name_codental || log.patient_name_extracted || '?',
                    filenames:    new Set(),
                    log_ids:      [],
                };
            }
            for (const att of log.attachments || []) {
                if (att.status === 'uploaded' && att.filename) {
                    byPatient[pid].filenames.add(att.filename);
                }
            }
            byPatient[pid].log_ids.push(String(log._id));
        }

        const patients = Object.values(byPatient);
        console.log(`👥 ${patients.length} pacientes com uploads`);

        if (dryRun) {
            // Dry run: lista o que seria deletado sem acessar o Codental
            const preview = patients.map(p => ({
                patient_id:   p.patient_id,
                patient_name: p.patient_name,
                files_to_delete: [...p.filenames],
            }));
            return res.status(200).json({
                ok: true,
                dry_run: true,
                total_patients: patients.length,
                total_files: patients.reduce((s, p) => s + p.filenames.size, 0),
                patients: preview,
            });
        }

        // Execução: para cada paciente, busca os uploads no Codental e deleta por nome
        let totalDeleted = 0;
        let totalNotFound = 0;
        const errors = [];
        const results = [];

        for (const p of patients) {
            const r = await purgePatient(p.patient_id, p.patient_name, [...p.filenames]);
            totalDeleted  += r.deleted;
            totalNotFound += r.not_found;
            if (r.errors.length) errors.push(...r.errors);
            results.push(r);

            // Marca logs como purgados no MongoDB
            if (r.deleted > 0) {
                await col.updateMany(
                    { _id: { $in: p.log_ids }, 'attachments.status': 'uploaded' },
                    { $set: { 'attachments.$[att].status': 'purged', 'attachments.$[att].purged_at': new Date() } },
                    { arrayFilters: [{ 'att.status': 'uploaded' }] }
                );
            }
        }

        return res.status(200).json({
            ok: true,
            dry_run: false,
            total_patients: patients.length,
            total_deleted:  totalDeleted,
            total_not_found: totalNotFound,
            total_errors:   errors.length,
            results,
        });

    } catch (err) {
        console.error('purge error:', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

// ─── PURGAR UM PACIENTE ───────────────────────────────────────────────────────
async function purgePatient(patientId, patientName, filenames) {
    console.log(`\n🧹 Paciente ${patientId} (${patientName}): ${filenames.length} arquivo(s) a deletar`);

    const result = { patient_id: patientId, patient_name: patientName, deleted: 0, not_found: 0, errors: [] };

    // 1. Busca todos os uploads do paciente no Codental (parse do HTML)
    let uploadsOnCodental;
    try {
        uploadsOnCodental = await listUploadsFromPage(patientId);
    } catch (err) {
        result.errors.push({ error: `Falha ao listar uploads: ${err.message}` });
        return result;
    }

    console.log(`  📁 ${uploadsOnCodental.length} arquivo(s) no Codental`);
    console.log(`  🎯 Buscando: ${filenames.slice(0,3).join(', ')}...`);
    if (uploadsOnCodental.length > 0) {
        console.log(`  📄 No Codental: ${uploadsOnCodental.slice(0,3).map(u=>u.filename).join(', ')}...`);
    }

    // 2. Para cada filename que queremos deletar, acha o upload_id no Codental
    const filenameSet = new Set(filenames.map(f => f.toLowerCase()));

    for (const upload of uploadsOnCodental) {
        if (!filenameSet.has(upload.filename.toLowerCase())) continue;

        try {
            await deleteUpload(patientId, upload.id);
            result.deleted++;
            console.log(`  🗑 Deletado: ${upload.filename} [${upload.id}]`);
        } catch (err) {
            result.errors.push({ filename: upload.filename, upload_id: upload.id, error: err.message });
            console.error(`  ❌ Erro: ${upload.filename} — ${err.message}`);
        }
    }

    // Conta arquivos que estavam nos logs mas não foram encontrados no Codental
    // (podem já ter sido deletados manualmente)
    const foundFilenames = new Set(uploadsOnCodental.map(u => u.filename.toLowerCase()));
    for (const fn of filenameSet) {
        if (!foundFilenames.has(fn)) {
            result.not_found++;
            console.log(`  ⚠ Não encontrado no Codental (já deletado?): ${fn}`);
        }
    }

    return result;
}

// ─── LISTAR UPLOADS DO PACIENTE VIA HTML ─────────────────────────────────────
async function listUploadsFromPage(patientId) {
    const s   = await sess();
    const res = await fetch(`${APP_BASE}/patients/${patientId}/uploads`, {
        headers: { 'Cookie': s.cookie, 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    const uploads = [];
    const re = /data-upload-id="(\d+)"[\s\S]*?data-url="([^"]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        const id  = m[1];
        const raw = m[2].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
        try {
            const d = JSON.parse(raw);
            if (d.filename) uploads.push({ id, filename: d.filename });
        } catch {
            const fn = raw.match(/"filename":"([^"]+)"/)?.[1];
            if (fn) uploads.push({ id, filename: fn });
        }
    }
    return uploads;
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
        body: new URLSearchParams({ _method: 'delete', authenticity_token: s.csrf }).toString(),
    });
    if (!r.ok && r.status !== 302 && r.status !== 204) {
        throw new Error(`HTTP ${r.status}`);
    }
}