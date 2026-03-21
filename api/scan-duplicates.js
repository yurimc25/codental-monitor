// api/scan-duplicates.js — Varre uploads do Codental, compara conteúdo por MD5, deleta duplicatas
//
// POST /api/scan-duplicates { patient_ids: ["3744810","7037014"], delete: false }
// GET  /api/scan-duplicates?patient_id=3744810&delete=0

import crypto from 'crypto';

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
    if (!cookie) throw new Error('Login falhou no scan-duplicates');

    const ar  = await fetch(`${APP_BASE}/patients`, { headers: { 'Cookie': cookie, 'User-Agent': 'Mozilla/5.0' } });
    const ah  = await ar.text();
    const ac  = (ah.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)/i) || [])[1] || csrf;
    const nc  = (ar.headers.get('set-cookie') || '').match(/_domain_session=[^;,]+/)?.[0] || cookie;

    _sess = { cookie: nc, csrf: ac };
    _sessAt = Date.now();
    console.log('✅ Session OK para scan-duplicates');
    return _sess;
}

// ─── HANDLER ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
    const key = req.headers['x-api-key'];
    if (key !== process.env.API_KEY) return res.status(401).json({ error: 'Não autorizado' });

    const doDelete = req.query.delete === '1' || req.body?.delete === true;

    try {
        let patientIds = [];

        if (req.query.patient_id) {
            patientIds = [String(req.query.patient_id)];
        } else if (req.body?.patient_ids?.length) {
            patientIds = req.body.patient_ids.map(String);
        } else {
            return res.status(400).json({ error: 'Forneça patient_id ou patient_ids' });
        }

        const results = [];
        for (const pid of patientIds) {
            results.push(await scanPatient(pid, doDelete));
        }

        return res.status(200).json({
            ok: true,
            dry_run: !doDelete,
            total_duplicates: results.reduce((s, r) => s + r.duplicates_found, 0),
            total_deleted:    results.reduce((s, r) => s + r.deleted, 0),
            patients: results,
        });

    } catch (err) {
        console.error('scan error:', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

// ─── ESCANEAR PACIENTE ────────────────────────────────────────────────────────
async function scanPatient(patientId, doDelete) {
    console.log(`\n🔍 Escaneando paciente ${patientId}...`);

    // 1. Lista uploads do paciente (parse do HTML — único jeito de ter as URLs do S3)
    const uploads = await listUploadsWithUrls(patientId);
    console.log(`  📁 ${uploads.length} arquivo(s) encontrado(s)`);

    // 2. Baixa e calcula MD5 de cada arquivo
    const withHash = [];
    for (const u of uploads) {
        try {
            const buf  = await downloadFile(u.downloadUrl);
            const hash = md5hex(buf);
            withHash.push({ ...u, hash, size: buf.length });
            console.log(`  ✓ ${u.filename} → ${hash.slice(0,8)}... (${(buf.length/1024).toFixed(1)}KB)`);
        } catch (err) {
            console.warn(`  ⚠ ${u.filename}: download falhou — ${err.message}`);
            withHash.push({ ...u, hash: null, size: 0 });
        }
    }

    // 3. Agrupa por hash — mesmo hash = mesmo conteúdo = duplicata
    const groups = {};
    for (const u of withHash) {
        if (!u.hash) continue; // não conseguiu baixar, não mexe
        if (!groups[u.hash]) groups[u.hash] = [];
        groups[u.hash].push(u);
    }

    // 4. Identifica grupos com mais de 1 arquivo
    const dupGroups = Object.values(groups)
        .filter(g => g.length > 1)
        // Ordena por ID numérico — menor ID = mais antigo = keeper
        .map(g => g.sort((a, b) => parseInt(a.id) - parseInt(b.id)));

    const result = {
        patient_id: patientId,
        total_files: uploads.length,
        duplicates_found: dupGroups.reduce((s, g) => s + g.length - 1, 0),
        groups: dupGroups.map(g => ({
            hash: g[0].hash.slice(0, 12) + '...',
            size_kb: (g[0].size / 1024).toFixed(1),
            keep:   { id: g[0].id, filename: g[0].filename },
            remove: g.slice(1).map(u => ({ id: u.id, filename: u.filename })),
        })),
        deleted: 0,
        errors: [],
    };

    // 5. Deleta se solicitado
    if (doDelete && dupGroups.length > 0) {
        for (const g of dupGroups) {
            for (const u of g.slice(1)) {
                try {
                    await deleteUpload(patientId, u.id);
                    result.deleted++;
                    console.log(`  🗑 Deletado: ${u.filename} [${u.id}]`);
                } catch (err) {
                    result.errors.push({ id: u.id, filename: u.filename, error: err.message });
                    console.error(`  ❌ Erro ao deletar ${u.id}: ${err.message}`);
                }
            }
        }
    }

    console.log(`  ✅ ${result.duplicates_found} duplicata(s)${doDelete ? `, ${result.deleted} deletada(s)` : ' (simulação)'}`);
    return result;
}

// ─── LISTAR UPLOADS COM URLS DE DOWNLOAD ─────────────────────────────────────
// Parseia o HTML da página de uploads para extrair ID, filename e URL do S3
async function listUploadsWithUrls(patientId) {
    const s   = await sess();
    const res = await fetch(`${APP_BASE}/patients/${patientId}/uploads`, {
        headers: { 'Cookie': s.cookie, 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
    });
    if (!res.ok) throw new Error(`Página de uploads ${patientId}: HTTP ${res.status}`);
    const html = await res.text();

    const uploads = [];
    // Extrai: data-upload-id="ID" ... data-url="{filename:..., download:...}"
    const re = /data-upload-id="(\d+)"[\s\S]*?data-url="([^"]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        const id  = m[1];
        const raw = m[2]
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, '&');
        try {
            const d = JSON.parse(raw);
            uploads.push({
                id,
                filename:    d.filename    || '',
                downloadUrl: d.download    || '',  // URL pré-assinada do S3
            });
        } catch {
            // fallback manual
            const fn  = raw.match(/"filename":"([^"]+)"/)?.[1] || '';
            const url = raw.match(/"download":"([^"]+)"/)?.[1] || '';
            if (fn) uploads.push({ id, filename: fn, downloadUrl: url });
        }
    }
    return uploads;
}

// ─── DOWNLOAD DO ARQUIVO VIA URL PRÉ-ASSINADA DO S3 ─────────────────────────
// A URL já está no HTML — não precisa de autenticação extra
async function downloadFile(url) {
    if (!url) throw new Error('URL de download vazia');
    const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) throw new Error(`Download falhou: HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    return Buffer.from(buf);
}

// ─── MD5 ──────────────────────────────────────────────────────────────────────
function md5hex(buffer) {
    return crypto.createHash('md5').update(buffer).digest('hex');
}

// ─── DELETAR (POST _method=delete, Rails Turbo) ───────────────────────────────
async function deleteUpload(patientId, uploadId) {
    const s   = await sess();
    const url = `${APP_BASE}/patients/${patientId}/uploads/${uploadId}`;
    const r   = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type':     'application/x-www-form-urlencoded;charset=UTF-8',
            'Cookie':           s.cookie,
            'X-CSRF-Token':     s.csrf,
            'X-Requested-With': 'XMLHttpRequest',
            'X-Turbo-Request-Id': crypto.randomUUID(),
            'Accept':           'text/vnd.turbo-stream.html, text/html, application/xhtml+xml',
            'Origin':           APP_BASE,
            'Referer':          `${APP_BASE}/patients/${patientId}/uploads`,
            'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: new URLSearchParams({ _method: 'delete', authenticity_token: s.csrf }).toString(),
    });
    if (!r.ok && r.status !== 302 && r.status !== 204) {
        const txt = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}: ${txt.slice(0, 100)}`);
    }
}
