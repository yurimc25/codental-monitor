import { MongoClient } from 'mongodb';

const URI = process.env.MONGODB_URI;

let client;
let clientPromise;

if (!global._mongoClientPromise) {
    client = new MongoClient(URI);
    global._mongoClientPromise = client.connect();
}
clientPromise = global._mongoClientPromise;

export async function db() {
    const c = await clientPromise;
    return c.db('codental_monitor');
}

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