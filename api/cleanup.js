// api/cleanup.js — Deleta uploads duplicados com base no último log ou em um log específico
// POST /api/cleanup  body: { log_id?: string, dry_run?: boolean }
//   dry_run=true → só lista o que seria deletado, não deleta
//   log_id → usa um log específico; sem log_id usa o último log com status 'uploaded' ou 'partial'

import { db } from '../lib/db.js';
import { deleteUpload } from '../lib/codental.js';
import { ObjectId } from 'mongodb';

export const config = { maxDuration: 120 };

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const key = req.headers['x-api-key'];
    if (key !== process.env.API_KEY) return res.status(401).json({ error: 'Não autorizado' });

    const { log_id, dry_run = false } = req.body || {};

    try {
        const col = (await db()).collection('email_logs');

        // Busca o log alvo
        let log;
        if (log_id) {
            log = await col.findOne({ _id: new ObjectId(log_id) });
            if (!log) return res.status(404).json({ error: 'Log não encontrado' });
        } else {
            // Último log que teve uploads
            log = await col.findOne(
                { status: { $in: ['uploaded', 'partial'] } },
                { sort: { processed_at: -1 } }
            );
            if (!log) return res.status(404).json({ error: 'Nenhum log com uploads encontrado' });
        }

        // Coleta todos os uploads feitos neste log
        const uploaded = (log.attachments || []).filter(a => a.status === 'uploaded' && a.codental_upload_id);

        if (!uploaded.length) {
            return res.status(200).json({
                ok: true,
                message: 'Nenhum upload para desfazer neste log',
                log_id: log._id,
                subject: log.subject,
            });
        }

        const results = [];

        for (const att of uploaded) {
            if (dry_run) {
                results.push({
                    filename: att.filename,
                    upload_id: att.codental_upload_id,
                    patient_id: log.patient_id_codental,
                    action: 'would_delete',
                });
                continue;
            }

            try {
                await deleteUpload(log.patient_id_codental, att.codental_upload_id);
                results.push({
                    filename: att.filename,
                    upload_id: att.codental_upload_id,
                    status: 'deleted',
                });

                // Atualiza o log no MongoDB
                await col.updateOne(
                    { _id: log._id, 'attachments.codental_upload_id': att.codental_upload_id },
                    { $set: { 'attachments.$.status': 'deleted', 'attachments.$.deleted_at': new Date() } }
                );
            } catch (err) {
                results.push({
                    filename: att.filename,
                    upload_id: att.codental_upload_id,
                    status: 'error',
                    error: err.message,
                });
            }
        }

        const deleted = results.filter(r => r.status === 'deleted').length;
        const errors  = results.filter(r => r.status === 'error').length;

        return res.status(200).json({
            ok: true,
            dry_run,
            log_id: String(log._id),
            subject: log.subject,
            patient: log.patient_name_codental || log.patient_name_extracted,
            total: uploaded.length,
            deleted,
            errors,
            results,
        });

    } catch (err) {
        console.error('cleanup error:', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
}
