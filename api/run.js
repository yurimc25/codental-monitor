// api/run.js — Disparo manual e cron
import { run } from '../lib/processor.js';
export const config = { maxDuration: 300 };

export default async function handler(req, res) {
    // Cron Vercel usa Bearer; dashboard usa x-api-key
    const auth = req.headers.authorization;
    const key = req.headers['x-api-key'];
    const cronSecret = process.env.CRON_SECRET;
    const apiKey = process.env.API_KEY;

    const ok = (cronSecret && auth === `Bearer ${cronSecret}`) || (apiKey && key === apiKey);
    if (!ok) return res.status(401).json({ error: 'Não autorizado' });
    if (req.method !== 'POST') return res.status(405).end();

    try {
        const summary = await run();
        return res.status(200).json({ ok: true, ran_at: new Date().toISOString(), ...summary });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ ok: false, error: err.message });
    }
}
