// lib/gmail.js — Gmail API: não lidos, download, marcar como lido

import { google } from 'googleapis';
import { getSettings, updateSettings } from './db.js';

// ─── OAUTH CLIENT ─────────────────────────────────────────────────────────────

export function oauthClient() {
    return new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI,
    );
}

export function authUrl() {
    return oauthClient().generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/gmail.modify'], // .modify para marcar como lido
        prompt: 'consent',
    });
}

export async function exchangeCode(code) {
    const { tokens } = await oauthClient().getToken(code);
    return tokens;
}

// ─── GMAIL CLIENT COM AUTO-REFRESH ───────────────────────────────────────────

async function gmailClient() {
    const settings = await getSettings();
    if (!settings.gmail_refresh_token) throw new Error('Gmail não autorizado. Conecte sua conta no painel.');

    const auth = oauthClient();
    auth.setCredentials({
        access_token: settings.gmail_access_token,
        refresh_token: settings.gmail_refresh_token,
        expiry_date: settings.gmail_token_expiry,
    });

    // Auto-refresh: se o token vai expirar em menos de 5 minutos, renova
    if (!settings.gmail_token_expiry || Date.now() > settings.gmail_token_expiry - 300_000) {
        const { credentials } = await auth.refreshAccessToken();
        await updateSettings({
            gmail_access_token: credentials.access_token,
            gmail_token_expiry: credentials.expiry_date,
        });
        auth.setCredentials(credentials);
    }

    return google.gmail({ version: 'v1', auth });
}

// ─── BUSCAR MENSAGENS NÃO LIDAS COM KEYWORDS ─────────────────────────────────

/**
 * @param {string[]} keywords
 * @param {Date|null} sinceDate  — se fornecida, busca emails a partir desta data
 *                                 (usa `after:` na query do Gmail, em Unix timestamp)
 */
export async function fetchUnreadMessages(keywords, sinceDate = null) {
    const gmail = await gmailClient();

    // Garante que keywords é sempre um array válido
    const kws = Array.isArray(keywords) && keywords.length > 0
        ? keywords
        : ['tomografia', 'voxels', 'fenelon', 'radiomaster', 'documentacao', 'cbct', 'radiografia', 'laudo'];

    const kwQuery = kws.map(k => `"${k}"`).join(' OR ');

    // Se sinceDate foi passada, adiciona filtro de data na query
    const dateFilter = sinceDate instanceof Date
        ? ` after:${Math.floor(sinceDate.getTime() / 1000)}`
        : '';

    const query = `is:unread has:attachment (${kwQuery})${dateFilter}`;

    console.log(`📧 Query Gmail: ${query}`);

    const res = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 100,
    });

    return res.data.messages || []; // [{ id, threadId }]
}

// ─── DETALHES DE UMA MENSAGEM ─────────────────────────────────────────────────

export async function getMessage(messageId) {
    const gmail = await gmailClient();
    const res = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
    });
    return res.data;
}

// ─── EXTRAIR CABEÇALHOS ───────────────────────────────────────────────────────

export function getHeaders(message) {
    const h = message.payload.headers || [];
    const get = name => h.find(x => x.name.toLowerCase() === name)?.value || '';
    return {
        subject: get('subject'),
        from: get('from'),
        to: get('to'),
        date: get('date'),
    };
}

// ─── EXTRAIR TEXTO DO CORPO ───────────────────────────────────────────────────

export function getBody(message) {
    const parts = [];
    function walk(part) {
        if (!part) return;
        if (part.mimeType === 'text/plain' && part.body?.data)
            parts.push(Buffer.from(part.body.data, 'base64').toString('utf-8'));
        (part.parts || []).forEach(walk);
    }
    walk(message.payload);
    return parts.join('\n');
}

// ─── LISTAR ANEXOS (METADADOS) ────────────────────────────────────────────────

export function getAttachments(message) {
    const atts = [];

    function walk(part) {
        if (!part) return;

        const hasFilename = part.filename && part.filename.trim().length > 0;
        const hasAttachmentId = part.body?.attachmentId;
        // Alguns emails têm dados inline (body.data) em vez de attachmentId
        const hasData = part.body?.data && part.body.data.length > 0;

        if (hasFilename && (hasAttachmentId || hasData)) {
            // Ignora partes inline muito pequenas sem nome real (ex: imagens de assinatura)
            const size = part.body?.size || 0;
            const isInlineImage = (part.headers || []).some(h =>
                h.name?.toLowerCase() === 'content-disposition' &&
                h.value?.toLowerCase().includes('inline')
            ) && size < 10000;

            if (!isInlineImage) {
                atts.push({
                    filename: part.filename.trim(),
                    mimeType: part.mimeType || 'application/octet-stream',
                    size,
                    attachmentId: hasAttachmentId ? part.body.attachmentId : null,
                    dataInline: !hasAttachmentId && hasData ? part.body.data : null,
                });
            }
        }

        (part.parts || []).forEach(walk);
    }

    walk(message.payload);
    return atts;
}

// ─── DOWNLOAD DE ANEXO → Buffer ───────────────────────────────────────────────

export async function downloadAttachment(messageId, attachmentId, dataInline = null) {
    // Se os dados já vieram inline no payload, usa direto
    if (dataInline) {
        return Buffer.from(dataInline, 'base64');
    }
    const gmail = await gmailClient();
    const res = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: attachmentId,
    });
    return Buffer.from(res.data.data, 'base64');
}

// ─── MARCAR COMO LIDO ─────────────────────────────────────────────────────────

export async function markAsRead(messageId) {
    const gmail = await gmailClient();
    await gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: { removeLabelIds: ['UNREAD'] },
    });
}

// ─── DETECTAR KEYWORDS NO TEXTO ──────────────────────────────────────────────

export function detectKeywords(text, keywords) {
    const norm = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const normText = norm(text);
    return keywords.filter(kw => normText.includes(norm(kw)));
}