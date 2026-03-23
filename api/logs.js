// api/logs.js
import { getLogs, getStats, db } from '../lib/db.js';
import { cors } from '../lib/cors.js';

export default async function handler(req, res) {
    if (cors(req, res)) return;
    // PATCH — atualiza anexos e status de um log específico (usado pelo reverificar anexos)
    if (req.method === 'PATCH') {
        const { log_id, message_id, attachments, status, update_message_id } = req.body || {};
        if (!log_id && !message_id) return res.status(400).json({ error: 'log_id ou message_id obrigatório' });
        try {
            const { ObjectId } = await import('mongodb');
            const query = log_id
                ? { _id: new ObjectId(log_id) }
                : { gmail_message_id: message_id };
            const update = {};
            if (attachments) update.attachments = attachments;
            if (status)      update.status = status;
            // Atualiza o gmail_message_id se o email foi encontrado por assunto e é diferente
            if (update_message_id && message_id) update.gmail_message_id = message_id;
            update.updated_at = new Date();
            const col = (await db()).collection('email_logs');
            const r = await col.updateOne(query, { $set: update });
            return res.status(200).json({ ok: true, matched: r.matchedCount, modified: r.modifiedCount });
        } catch(e) {
            return res.status(500).json({ error: e.message });
        }
    }

    if (req.method !== 'GET') return res.status(405).end();
    const { page = 1, status, search, stats, sort = 'newest' } = req.query;

    try {
        if (stats === '1') {
            return res.status(200).json(await getStats());
        }
        const data = await getLogs({
            page: parseInt(page),
            limit: 25,
            status: status || null,
            search: search || null,
            sort: sort === 'oldest' ? 'oldest' : 'newest',
        });
        return res.status(200).json(data);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}