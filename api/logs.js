// api/logs.js
import { getLogs, getStats } from '../lib/db.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).end();
    const { page = 1, status, search, stats } = req.query;

    try {
        if (stats === '1') {
            return res.status(200).json(await getStats());
        }
        const data = await getLogs({
            page: parseInt(page),
            limit: 25,
            status: status || null,
            search: search || null,
        });
        return res.status(200).json(data);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
