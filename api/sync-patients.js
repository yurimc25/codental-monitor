// api/sync-patients.js — Baixa o CSV de pacientes do Codental e salva no MongoDB
// POST /api/sync-patients → dispara a sincronização
// GET  /api/sync-patients → retorna status da última sincronização

import crypto from 'crypto';
import { db } from '../lib/db.js';

export const config = { maxDuration: 120 };

const APP_BASE  = 'https://odonto-on-face.codental.com.br';
const LOGIN_URL = 'https://www.codental.com.br/login';

// ─── SESSION ──────────────────────────────────────────────────────────────────
let _sess = null, _sessAt = 0;
async function sess() {
    if (_sess && Date.now() - _sessAt < 10 * 60 * 1000) return _sess;
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

    const col = (await db()).collection('patients_cache');

    if (req.method === 'GET') {
        const meta = await (await db()).collection('settings').findOne({ _id: 'patients_sync' });
        const count = await col.countDocuments();
        return res.status(200).json({ ok: true, total_patients: count, last_sync: meta?.synced_at || null });
    }

    if (req.method !== 'POST') return res.status(405).end();

    try {
        console.log('📥 Iniciando sync de pacientes...');
        const s = await sess();

        // 1. Solicita geração do relatório CSV
        const genRes = await fetch(`${APP_BASE}/patients/generate_report`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json;charset=UTF-8',
                'Cookie': s.cookie,
                'X-CSRF-Token': s.csrf,
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': '*/*',
                'Origin': APP_BASE,
                'Referer': `${APP_BASE}/patients`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
            // Body com todos os tipos possíveis — ajuste após ver o payload real
            body: JSON.stringify({ format_type: 'csv', query: '' }),
        });

        if (!genRes.ok) {
            const txt = await genRes.text();
            throw new Error(`generate_report falhou: HTTP ${genRes.status} — ${txt.slice(0, 200)}`);
        }

        // Resposta pode ser JSON com URL ou HTML com link de download
        const ct = genRes.headers.get('content-type') || '';
        let csvUrl = null;

        if (ct.includes('json')) {
            const genData = await genRes.json();
            console.log('📋 generate_report JSON:', JSON.stringify(genData).slice(0, 300));
            csvUrl = genData.url || genData.download_url || genData.csv_url
                || genData.link || genData.file_url || genData.path;
        } else {
            // HTML: extrai link href com .csv
            const html = await genRes.text();
            console.log('📋 generate_report HTML (primeiros 500):', html.slice(0, 500));
            const m = html.match(/href=["']([^"']*\.csv[^"']*)/i)
                || html.match(/href=["']([^"']*active_storage[^"']*)/i)
                || html.match(/"(https?:\/\/[^"]*\.csv[^"]*)"/i);
            if (m) csvUrl = m[1];
        }

        if (!csvUrl) {
            throw new Error('URL do CSV não encontrada. Verifique os logs para ver a resposta completa.');
        }

        // 2. Baixa o CSV
        const fullUrl = csvUrl.startsWith('http') ? csvUrl : `${APP_BASE}${csvUrl}`;
        console.log(`📥 Baixando CSV: ${fullUrl}`);

        const csvRes = await fetch(fullUrl, {
            headers: { 'Cookie': s.cookie, 'User-Agent': 'Mozilla/5.0' },
        });

        if (!csvRes.ok) throw new Error(`Download CSV falhou: HTTP ${csvRes.status}`);

        const csvText = await csvRes.text();
        console.log(`📄 CSV recebido: ${csvText.length} bytes, primeiros 200: ${csvText.slice(0, 200)}`);

        // 3. Parseia CSV
        const patients = parseCSV(csvText);
        console.log(`👥 ${patients.length} pacientes parseados`);

        if (patients.length === 0) throw new Error('CSV vazio ou formato inesperado');

        // 4. Salva no MongoDB (substitui tudo)
        await col.deleteMany({});
        if (patients.length > 0) {
            await col.insertMany(patients);
        }

        // Cria índice de busca por nome
        await col.createIndex({ name_norm: 'text' });
        await col.createIndex({ name_norm: 1 });

        // Atualiza metadata
        await (await db()).collection('settings').updateOne(
            { _id: 'patients_sync' },
            { $set: { synced_at: new Date(), total: patients.length } },
            { upsert: true }
        );

        return res.status(200).json({
            ok: true,
            total: patients.length,
            sample: patients.slice(0, 3),
        });

    } catch (err) {
        console.error('sync-patients error:', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

// ─── PARSE CSV ────────────────────────────────────────────────────────────────
function parseCSV(text) {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return [];

    // Detecta separador (vírgula ou ponto-e-vírgula)
    const sep = lines[0].includes(';') ? ';' : ',';
    const headers = lines[0].split(sep).map(h => h.trim().toLowerCase()
        .replace(/"/g, '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, '_'));

    console.log('CSV headers:', headers.join(', '));

    const patients = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const values = splitCSVLine(line, sep);
        const obj = {};
        headers.forEach((h, idx) => { obj[h] = (values[idx] || '').replace(/^"|"$/g, '').trim(); });

        // Normaliza campos de nome (pode ser 'nome', 'name', 'paciente', 'nome_completo')
        const name = obj.nome || obj.name || obj.paciente || obj.nome_completo || obj.full_name || '';
        if (!name) continue;

        // ID do paciente (pode ser 'id', 'codigo', 'code', 'patient_id')
        const id = obj.id || obj.codigo || obj.code || obj.patient_id || obj.numero || '';

        patients.push({
            id:        String(id),
            name:      name,
            name_norm: normName(name),  // versão normalizada para busca
            phone:     obj.telefone || obj.phone || obj.celular || obj.fone || '',
            cpf:       obj.cpf || '',
            email:     obj.email || '',
            raw:       obj,
        });
    }
    return patients;
}

function splitCSVLine(line, sep) {
    const result = [];
    let cur = '', inQ = false;
    for (const c of line) {
        if (c === '"') { inQ = !inQ; }
        else if (c === sep && !inQ) { result.push(cur); cur = ''; }
        else { cur += c; }
    }
    result.push(cur);
    return result;
}

function normName(s) {
    return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}