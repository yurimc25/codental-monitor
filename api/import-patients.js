// api/import-patients.js — Importa CSV de pacientes via upload direto
// POST /api/import-patients  multipart/form-data  campo: csv

import { db } from '../lib/db.js';

export const config = {
    maxDuration: 60,
    api: { bodyParser: { sizeLimit: '10mb' } },
};

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();
    const key = req.headers['x-api-key'];
    if (key !== process.env.API_KEY) return res.status(401).json({ error: 'Não autorizado' });

    try {
        // Recebe o CSV como texto no body (Content-Type: text/plain ou application/json)
        let csvText = '';

        if (typeof req.body === 'string') {
            csvText = req.body;
        } else if (req.body?.csv) {
            csvText = req.body.csv;
        } else {
            return res.status(400).json({ error: 'Envie o conteúdo CSV no body como texto ou JSON { csv: "..." }' });
        }

        const patients = parseCSV(csvText);
        if (patients.length === 0) {
            return res.status(400).json({ error: 'CSV vazio ou formato não reconhecido. Verifique os headers do arquivo.' });
        }

        console.log(`📥 Importando ${patients.length} pacientes...`);
        console.log('Amostra:', JSON.stringify(patients.slice(0, 2)));

        const col = (await db()).collection('patients_cache');
        await col.deleteMany({});
        await col.insertMany(patients);
        await col.createIndex({ name_norm: 1 });

        await (await db()).collection('settings').updateOne(
            { _id: 'patients_sync' },
            { $set: { synced_at: new Date(), total: patients.length, source: 'manual_upload' } },
            { upsert: true }
        );

        return res.status(200).json({
            ok: true,
            total: patients.length,
            sample: patients.slice(0, 5).map(p => ({ id: p.id, name: p.name, phone: p.phone })),
        });

    } catch (err) {
        console.error('import-patients error:', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

function normName(s) {
    return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
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

function parseCSV(text) {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return [];

    const sep = lines[0].includes(';') ? ';' : ',';
    const rawHeaders = lines[0].split(sep).map(h =>
        h.trim().replace(/^"|"$/g, '').toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, '_')
    );

    console.log('CSV headers detectados:', rawHeaders.join(' | '));

    const patients = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const values = splitCSVLine(line, sep);
        const obj = {};
        rawHeaders.forEach((h, idx) => {
            obj[h] = (values[idx] || '').replace(/^"|"$/g, '').trim();
        });

        // Detecta campo de nome automaticamente
        const name = obj.nome || obj.name || obj.paciente || obj.nome_completo
            || obj.full_name || obj.nome_paciente || '';
        if (!name || name.length < 2) continue;

        // Detecta campo de ID
        const id = obj.id || obj.codigo || obj.code || obj.patient_id
            || obj.numero || obj.nr || String(i);

        patients.push({
            id:        String(id),
            name:      name,
            name_norm: normName(name),
            phone:     obj.telefone || obj.phone || obj.celular || obj.fone || obj.tel || '',
            cpf:       obj.cpf || '',
            email:     obj.email || obj.e_mail || '',
            raw:       obj,
        });
    }
    return patients;
}
