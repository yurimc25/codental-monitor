// lib/db.js — MongoDB: conexão e todas as operações

import { MongoClient, ObjectId } from 'mongodb';

const URI = process.env.MONGODB_URI;
let _client;

async function client() {
    if (!_client) {
        _client = new MongoClient(URI);
        await _client.connect();
    }
    return _client;
}

export async function db() {
    return (await client()).db('codental_monitor');
}

// ─── SETTINGS ────────────────────────────────────────────────────────────────
// {
//   _id: 'main',
//   keywords: string[],
//   codental_base_url: string,
//   gmail_refresh_token: string,
//   gmail_access_token: string,
//   gmail_token_expiry: number,
//   cron_enabled: boolean,
// }

export async function getSettings() {
    const col = (await db()).collection('settings');
    return await col.findOne({ _id: 'main' }) || {
        keywords: ['tomografia', 'voxels', 'fenelon', 'radiomaster', 'documentação', 'documentacao', 'cbct', 'radiografia', 'laudo'],
        codental_base_url: process.env.CODENTAL_BASE_URL || 'https://odonto-on-face.codental.com.br',
        cron_enabled: true,
    };
}

export async function updateSettings(patch) {
    const col = (await db()).collection('settings');
    await col.updateOne({ _id: 'main' }, { $set: { ...patch, updated_at: new Date() } }, { upsert: true });
}

// ─── EMAIL LOGS ───────────────────────────────────────────────────────────────
// {
//   _id: ObjectId,
//   gmail_message_id: string,       ← índice único
//   gmail_thread_id: string,
//   processed_at: Date,
//   subject: string,
//   from: string,
//   date: string,                   ← data do email
//   patient_name_extracted: string,
//   patient_id_codental: string | null,
//   patient_name_codental: string | null,
//   keywords_matched: string[],
//   attachments: AttachmentLog[],
//   status: 'uploaded'|'partial'|'failed'|'no_patient'|'no_attachments'|'duplicate_all',
//   marked_read: boolean,
// }
//
// AttachmentLog:
// {
//   filename: string,
//   mime_type: string,
//   size_bytes: number,
//   status: 'uploaded'|'skipped_duplicate'|'error',
//   codental_upload_id: string | null,
//   error_message: string | null,
//   skipped_reason: string | null,
// }

export async function isProcessed(gmailMessageId) {
    const col = (await db()).collection('email_logs');
    return !!(await col.findOne({ gmail_message_id: gmailMessageId }));
}

export async function saveLog(doc) {
    const col = (await db()).collection('email_logs');
    return col.insertOne({ ...doc, processed_at: new Date() });
}

export async function getLogs({ page = 1, limit = 25, status, search } = {}) {
    const col = (await db()).collection('email_logs');
    const filter = {};
    if (status) filter.status = status;
    if (search) {
        filter.$or = [
            { subject: { $regex: search, $options: 'i' } },
            { patient_name_extracted: { $regex: search, $options: 'i' } },
            { from: { $regex: search, $options: 'i' } },
        ];
    }
    const [logs, total] = await Promise.all([
        col.find(filter).sort({ processed_at: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
        col.countDocuments(filter),
    ]);
    return { logs, total, pages: Math.ceil(total / limit) };
}

export async function getStats() {
    const col = (await db()).collection('email_logs');
    const [total, byStatus, lastRun, attachStats] = await Promise.all([
        col.countDocuments(),
        col.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]).toArray(),
        col.findOne({}, { sort: { processed_at: -1 }, projection: { processed_at: 1 } }),
        col.aggregate([
            { $unwind: '$attachments' },
            { $group: { _id: '$attachments.status', count: { $sum: 1 } } },
        ]).toArray(),
    ]);

    const statusMap = Object.fromEntries(byStatus.map(s => [s._id, s.count]));
    const attMap = Object.fromEntries(attachStats.map(s => [s._id, s.count]));

    return {
        total_emails: total,
        uploaded: statusMap.uploaded || 0,
        partial: statusMap.partial || 0,
        failed: statusMap.failed || 0,
        no_patient: statusMap.no_patient || 0,
        duplicate_all: statusMap.duplicate_all || 0,
        att_uploaded: attMap.uploaded || 0,
        att_duplicate: attMap.skipped_duplicate || 0,
        att_error: attMap.error || 0,
        last_run: lastRun?.processed_at || null,
    };
}

export async function ensureIndexes() {
    const col = (await db()).collection('email_logs');
    await col.createIndex({ gmail_message_id: 1 }, { unique: true });
    await col.createIndex({ processed_at: -1 });
    await col.createIndex({ status: 1 });
}