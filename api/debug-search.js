// api/debug-search.js — Mostra resposta crua da busca no Codental
// GET /api/debug-search?name=Lucas

import { searchPatients } from '../lib/codental.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
    const key = req.headers['x-api-key'] || req.query.key;
    if (key !== process.env.API_KEY) return res.status(401).json({ error: 'Não autorizado' });

    const name = req.query.name || 'Lucas';

    try {
        const results = await searchPatients(name);
        // Normaliza fullName → name
        results.forEach(p => { if (!p.name && p.fullName) p.name = p.fullName; });
        
        return res.status(200).json({
            query: name,
            count: results.length,
            fields_sample: results[0] ? Object.keys(results[0]) : [],
            first_3: results.slice(0, 3),
            all: results,  // retorna todos para busca manual no painel
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}