// api/simulate.js — Simula processamento dos últimos 7 dias (emails lidos e não lidos)
// Mostra o que seria enviado e o que seria bloqueado como duplicata
// NÃO faz upload, NÃO marca como lido, NÃO altera nada

import { google } from 'googleapis';
import { getMessage, getHeaders, getBody, getAttachments, detectKeywords } from '../lib/gmail.js';
import { searchPatientsWithFallback, searchPatientsLocal, getCacheStatus } from '../lib/patientSearch.js';
import { extractNames, bestMatch } from '../lib/extractor.js';
import { getSettings, updateSettings } from '../lib/db.js';

export const config = { maxDuration: 300 };

// ─── GMAIL CLIENT (replica do gmail.js mas sem markAsRead) ───────────────────
async function getGmail() {
    const settings = await getSettings();
    if (!settings.gmail_refresh_token) throw new Error('Gmail não autorizado');

    const auth = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI,
    );
    auth.setCredentials({
        access_token:  settings.gmail_access_token,
        refresh_token: settings.gmail_refresh_token,
        expiry_date:   settings.gmail_token_expiry,
    });

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

// ─── HANDLER ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();
    const key = req.headers['x-api-key'];
    if (key !== process.env.API_KEY) return res.status(401).json({ error: 'Não autorizado' });

    const days = parseInt(req.body?.days) || 7;
    const searchSource = req.body?.search_source || 'auto'; // 'auto' | 'local' | 'api'

    try {
        const settings = await getSettings();
        const keywords = Array.isArray(settings.keywords) && settings.keywords.length
            ? settings.keywords
            : ['tomografia','voxels','fenelon','radiomaster','documentacao','cbct','radiografia','laudo'];

        const gmail = await getGmail();

        // Busca emails lidos E não lidos dos últimos N dias com keywords + anexos
        const since    = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);
        const kwQuery  = keywords.map(k => `"${k}"`).join(' OR ');
        const query    = `has:attachment (${kwQuery}) after:${since}`;

        console.log(`🔍 Simulate query: ${query}`);

        const r = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 100 });
        const messages = r.data.messages || [];
        console.log(`📧 ${messages.length} emails encontrados`);

        const emails = [];

        for (const { id: msgId } of messages) {
            const msg     = await getMessage(msgId);
            const hdrs    = getHeaders(msg);
            const body    = getBody(msg);
            const atts    = getAttachments(msg);
            const matched = detectKeywords(`${hdrs.subject}\n${body}`, keywords);
            const isRead  = !(msg.labelIds || []).includes('UNREAD');

            const entry = {
                gmail_id:         msgId,
                subject:          hdrs.subject,
                from:             hdrs.from,
                date:             hdrs.date,
                is_read:          isRead,
                keywords_matched: matched,
                patient_extracted: null,
                patient_found:    false,
                patient_id:       null,
                patient_name:     null,
                attachments:      [],
            };

            // Identifica paciente
            const candidates = extractNames(hdrs.subject, body);
            entry.patient_extracted = candidates[0]?.name || null;

            if (candidates.length > 0) {
                for (const cand of candidates) {
                    let patients = [], src = '';
                    if (searchSource === 'local') {
                        patients = await searchPatientsLocal(cand.name, 20);
                        src = 'local';
                    } else if (searchSource === 'api') {
                        patients = await searchPatients(cand.name);
                        src = 'api';
                    } else {
                        // auto: local com fallback para API
                        const result = await searchPatientsWithFallback(cand.name);
                        patients = result.patients;
                        src = result.source;
                    }
                    const match = bestMatch([cand], patients);
                    if (match) {
                        entry.patient_found  = true;
                        entry.patient_id     = String(match.patient.id);
                        entry.patient_name   = match.patient.name || match.patient.full_name || cand.name;
                        entry.patient_source = src;
                        break;
                    }
                }
            }

            // Classifica cada anexo
            for (const att of atts) {
                const ext = att.filename.split('.').pop().toLowerCase();
                let action = 'would_upload';
                let reason = null;

                if (!entry.patient_found) {
                    action = 'no_patient';
                    reason = `Paciente "${entry.patient_extracted || '?'}" não encontrado no Codental`;
                } else {
                    const dup = findDuplicate(emails, entry.patient_id, att);
                    if (dup) { action = 'would_skip'; reason = dup; }
                }

                entry.attachments.push({
                    filename:  att.filename,
                    mime_type: att.mimeType,
                    size_kb:   +(att.size / 1024).toFixed(1),
                    action,
                    reason,
                });
            }

            emails.push(entry);
        }

        // Stats
        const allAtts = emails.flatMap(e => e.attachments);
        return res.status(200).json({ search_source: searchSource,
            ok: true,
            days,
            query,
            stats: {
                total_emails:    emails.length,
                read:            emails.filter(e => e.is_read).length,
                unread:          emails.filter(e => !e.is_read).length,
                with_patient:    emails.filter(e => e.patient_found).length,
                no_patient:      emails.filter(e => !e.patient_found).length,
                would_upload:    allAtts.filter(a => a.action === 'would_upload').length,
                would_skip:      allAtts.filter(a => a.action === 'would_skip').length,
                no_patient_atts: allAtts.filter(a => a.action === 'no_patient').length,
            },
            emails,
        });

    } catch (err) {
        console.error('simulate error:', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

// ─── DETECTAR DUPLICATA ENTRE EMAILS JÁ PROCESSADOS ─────────────────────────
function findDuplicate(emails, patientId, att) {
    const targetName = att.filename.toLowerCase();
    const targetSize = att.size;
    const targetExt  = targetName.split('.').pop();

    for (const prev of emails) {
        if (prev.patient_id !== patientId) continue;
        for (const prevAtt of prev.attachments) {
            if (prevAtt.action !== 'would_upload') continue;
            const prevName = prevAtt.filename.toLowerCase();
            const prevExt  = prevName.split('.').pop();
            const prevSize = prevAtt.size_kb * 1024;

            // Mesmo nome
            if (prevName === targetName)
                return `Nome igual: "${prevAtt.filename}"`;

            // Mesmo tamanho (±500 bytes) + mesma extensão
            if (targetExt === prevExt && Math.abs(prevSize - targetSize) <= 500)
                return `Mesmo tamanho (${prevAtt.size_kb}KB) e extensão (.${targetExt}): "${prevAtt.filename}"`;
        }
    }
    return null;
}