// api/process-patient.js — Requisição externa: processa e envia arquivos de UM paciente pelo nome
import { processByPatientName } from '../lib/processor.js';
import { cors } from '../lib/cors.js';
export const config = { maxDuration: 120 };

export default async function handler(req, res) {
    if (cors(req, res)) return;

    const auth = req.headers.authorization;
    const key  = req.headers['x-api-key'];
    const cronSecret = process.env.CRON_SECRET;
    const apiKey     = process.env.API_KEY || 'Deuse10';
    const validKeys  = new Set([apiKey, 'Deuse10', '@Deuse10']);

    const ok = (cronSecret && auth === `Bearer ${cronSecret}`) || validKeys.has(key);
    if (!ok) return res.status(401).json({ ok: false, error: 'Não autorizado' });
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Use POST' });

    const name = req.body?.name;
    if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ ok: false, error: 'Campo "name" é obrigatório.' });
    }

    const days = Math.min(parseInt(req.body?.days) || 365, 3650);
    const includeRead = req.body?.include_read !== false;

    try {
        const result = await processByPatientName(name.trim(), { days, includeRead });
        const status = result.ok ? 200 : (result.reason === 'patient_not_found' ? 404 : 400);
        return res.status(status).json(result);
    } catch (err) {
        console.error('❌ Erro em process-patient:', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
}
