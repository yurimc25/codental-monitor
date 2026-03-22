// api/debug-search.js — Mostra resposta crua da busca no Codental
// GET /api/debug-search?name=Lucas

import { searchPatients } from '../lib/codental.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
    const key = req.headers['x-api-key'];
    if (key !== process.env.API_KEY) return res.status(401).json({ error: 'Não autorizado' });

    const name = req.query.name || 'Lucas';

    try {
        const results = await searchPatients(name);
        return res.status(200).json({
            query: name,
            count: results.length,
            // Mostra os campos do primeiro resultado para identificar o campo de nome
            fields_sample: results[0] ? Object.keys(results[0]) : [],
            first_3: results.slice(0, 3),
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
