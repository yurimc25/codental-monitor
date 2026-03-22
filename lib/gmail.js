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
/**
 * Busca emails com paginação completa.
 * @param {string[]} keywords
 * @param {Date|null} sinceDate
 * @param {boolean} includeRead
 * @param {string|null} pageToken - continua de onde parou (checkpoint)
 * @param {number} maxTotal - limite total de emails (0 = sem limite)
 * @returns {{ messages: {id,threadId}[], nextPageToken: string|null, total: number }}
 */
export async function fetchUnreadMessages(keywords, sinceDate = null, includeRead = false, pageToken = null, maxTotal = 0) {
    const gmail = await gmailClient();

    const kws = Array.isArray(keywords) && keywords.length > 0
        ? keywords
        : ['tomografia', 'voxels', 'fenelon', 'radiomaster', 'documentacao', 'cbct', 'radiografia', 'laudo'];

    const kwQuery = kws.map(k => `"${k}"`).join(' OR ');

    const dateFilter = sinceDate instanceof Date
        ? ` after:${Math.floor(sinceDate.getTime() / 1000)}`
        : '';

    const readFilter = includeRead ? '' : 'is:unread ';
    const query = `${readFilter}has:attachment (${kwQuery})${dateFilter}`;

    console.log(`📧 Query Gmail: ${query}${pageToken ? ` (continuando de pageToken)` : ''}`);

    // Coleta todas as páginas até acabar ou atingir maxTotal
    const allMessages = [];
    let currentToken = pageToken || undefined;
    let page = 0;

    while (true) {
        page++;
        const res = await gmail.users.messages.list({
            userId: 'me',
            q: query,
            maxResults: 100,
            ...(currentToken ? { pageToken: currentToken } : {}),
        });

        const msgs = res.data.messages || [];
        allMessages.push(...msgs);
        currentToken = res.data.nextPageToken || null;

        console.log(`📧 Página ${page}: ${msgs.length} emails (total até agora: ${allMessages.length}, nextPageToken: ${currentToken ? 'sim' : 'não'})`);

        // Para se não há mais páginas
        if (!currentToken) break;

        // Para se atingiu o limite máximo
        if (maxTotal > 0 && allMessages.length >= maxTotal) break;

        // Pausa pequena para não throttlar a API
        await new Promise(r => setTimeout(r, 200));
    }

    console.log(`📧 Total de emails encontrados: ${allMessages.length}`);
    return allMessages;
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

        const filename = (part.filename || '').trim();
        const hasAttachmentId = !!part.body?.attachmentId;
        const hasData = !!(part.body?.data && part.body.data.length > 100);
        const size = part.body?.size || 0;

        // Considera anexo se: tem nome de arquivo E (tem attachmentId OU dados inline)
        if (filename && (hasAttachmentId || hasData)) {
            // Descarta imagens de assinatura inline (sem nome real ou muito pequenas)
            const contentDisp = (part.headers || [])
                .find(h => h.name?.toLowerCase() === 'content-disposition')?.value || '';
            const isInline = contentDisp.toLowerCase().includes('inline') && size < 8000;

            if (!isInline) {
                atts.push({
                    filename,
                    mimeType: part.mimeType || 'application/octet-stream',
                    size,
                    attachmentId: hasAttachmentId ? part.body.attachmentId : null,
                    dataInline: !hasAttachmentId && hasData ? part.body.data : null,
                });
            }
        }

        // Percorre recursivamente todos os subtipos multipart
        (part.parts || []).forEach(walk);
    }

    // Começa pelo payload principal E por cada parte de nível superior
    walk(message.payload);

    // Alguns clientes de email colocam anexos fora da árvore principal
    if (message.payload?.parts) {
        for (const part of message.payload.parts) {
            if (part.parts) part.parts.forEach(walk);
        }
    }

    // Remove duplicatas pelo filename
    const seen = new Set();
    return atts.filter(a => {
        if (seen.has(a.filename)) return false;
        seen.add(a.filename);
        return true;
    });
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