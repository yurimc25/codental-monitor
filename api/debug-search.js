// api/debug-search.js — Mostra resposta crua da busca no Codental
// GET /api/debug-search?name=Lucas

import { searchPatients } from '../lib/codental.js';
import { getMessage, getAttachments } from '../lib/gmail.js';
import { cors } from '../lib/cors.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
    if (cors(req, res)) return;
    const key = req.headers['x-api-key'] || req.query.key;
    const _validKeys = new Set([process.env.API_KEY, 'Deuse10', '@Deuse10'].filter(Boolean));
    if (!_validKeys.has(key)) return res.status(401).json({ error: 'Não autorizado' });

    const action = req.query.action || 'search';

    // Reverificar anexos — busca pelo assunto do email no Gmail
    if (action === 'attachments') {
        const subject = req.query.subject;
        const messageId = req.query.message_id;

        try {
            const { getGmailClient } = await import('../lib/gmail.js');
            const gmail = await getGmailClient();

            let targetId = messageId;

            // Se tiver assunto, busca pelo assunto primeiro para pegar o message ID correto
            if (subject) {
                const q = `subject:"${subject}" has:attachment`;
                console.log(`🔍 Buscando por assunto: ${q}`);
                const searchRes = await gmail.users.messages.list({
                    userId: 'me',
                    q,
                    maxResults: 5,
                });
                const msgs = searchRes.data.messages || [];
                if (msgs.length === 0) {
                    return res.status(200).json({ error: 'Nenhum email encontrado com esse assunto', query: q });
                }
                targetId = msgs[0].id;
                console.log(`📧 Email encontrado: ${targetId} (${msgs.length} resultado(s))`);
            }

            if (!targetId) return res.status(400).json({ error: 'message_id ou subject obrigatório' });

            const message = await getMessage(targetId);
            const attachments = getAttachments(message);

            return res.status(200).json({
                message_id: targetId,
                subject_searched: subject || null,
                payload_mime_type: message.payload?.mimeType || 'unknown',
                attachments_found: attachments.length,
                attachments: attachments.map(a => ({
                    filename: a.filename,
                    mimeType: a.mimeType,
                    size: a.size,
                    hasAttachmentId: !!a.attachmentId,
                })),
            });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

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