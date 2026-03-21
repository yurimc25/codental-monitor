// lib/processor.js — Pipeline principal: não lidos → upload → marcar como lido

import {
    fetchUnreadMessages, getMessage, getHeaders, getBody,
    getAttachments, downloadAttachment, markAsRead, detectKeywords,
} from './gmail.js';
import { searchPatients, isDuplicate, uploadFile } from './codental.js';
import { extractNames, bestMatch, matchWithSuggestions, nameSearchVariants } from './extractor.js';
import { getSettings, isProcessed, saveLog, ensureIndexes } from './db.js';

export async function run({ sinceDate = null } = {}) {
    await ensureIndexes();
    const settings = await getSettings();
    const keywords = Array.isArray(settings.keywords) && settings.keywords.length > 0
        ? settings.keywords
        : ['tomografia', 'voxels', 'fenelon', 'radiomaster', 'documentacao', 'cbct', 'radiografia', 'laudo'];

    console.log('🚀 Pipeline iniciado');
    const summary = {
        emails_found: 0,
        emails_skipped: 0,
        emails_processed: 0,
        att_uploaded: 0,
        att_duplicate: 0,
        att_error: 0,
        no_patient: 0,
        marked_read: 0,
        since_date: sinceDate ? sinceDate.toISOString() : null,
        errors: [],
    };

    // 1. Busca não lidos (com filtro de data opcional)
    const messages = await fetchUnreadMessages(keywords, sinceDate);
    summary.emails_found = messages.length;
    console.log(`📧 ${messages.length} mensagens não lidas encontradas`);

    for (const { id: messageId, threadId } of messages) {
        try {
            // Já processado antes? (pode ter sido marcado como lido, mas por segurança)
            if (await isProcessed(messageId)) {
                summary.emails_skipped++;
                await markAsRead(messageId).catch(() => {});
                continue;
            }

            const result = await processMessage(messageId, threadId, keywords);
            summary.emails_processed++;
            summary.att_uploaded += result.att_uploaded;
            summary.att_duplicate += result.att_duplicate;
            summary.att_error += result.att_error;
            if (result.status === 'no_patient') summary.no_patient++;

            // Marca como lido após processar (independente do resultado)
            await markAsRead(messageId);
            summary.marked_read++;

        } catch (err) {
            console.error(`❌ Erro fatal no email ${messageId}:`, err.message);
            summary.errors.push({ messageId, error: err.message });
        }
    }

    console.log('✅ Pipeline concluído:', summary);
    return summary;
}

// ─── PROCESSAR UMA MENSAGEM ───────────────────────────────────────────────────

async function processMessage(messageId, threadId, keywords) {
    const message = await getMessage(messageId);
    const { subject, from, date } = getHeaders(message);
    const body = getBody(message);
    const attachments = getAttachments(message);

    console.log(`\n📨 "${subject}" de ${from}`);

    const log = {
        gmail_message_id: messageId,
        gmail_thread_id: threadId,
        subject,
        from,
        date,
        patient_name_extracted: null,
        patient_id_codental: null,
        patient_name_codental: null,
        keywords_matched: detectKeywords(`${subject}\n${body}`, keywords),
        attachments: [],
        status: null,
        marked_read: false,
    };

    const result = { att_uploaded: 0, att_duplicate: 0, att_error: 0, status: null };

    // Sem anexos relevantes
    if (attachments.length === 0) {
        log.status = 'no_attachments';
        await saveLog(log);
        return { ...result, status: 'no_attachments' };
    }

    // ── Identificar paciente ─────────────────────────────────────────────────
    const nameCandidates = extractNames(subject, body);
    console.log(`  👤 Candidatos: ${nameCandidates.map(c => `${c.name}[${c.confidence}]`).join(', ') || 'nenhum'}`);

    let patientMatch = null;
    let pendingSuggestion = null;

    for (const cand of nameCandidates) {
        // Busca com variantes do nome para melhorar recall
        const variants = nameSearchVariants(cand.name);
        let allPatients = [];
        const seenIds = new Set();
        for (const variant of variants) {
            const pts = await searchPatients(variant);
            for (const p of pts) {
                const pid = String(p.id || '');
                if (!seenIds.has(pid)) { seenIds.add(pid); allPatients.push(p); }
            }
        }

        const { auto, suggestion } = matchWithSuggestions([cand], allPatients);

        if (auto) {
            patientMatch = auto;
            log.patient_name_extracted = cand.name;
            log.patient_id_codental = String(auto.patient.id);
            log.patient_name_codental = auto.patient.name || auto.patient.full_name || null;
            log.match_score = auto.score;
            console.log(`  ✅ Paciente: ${log.patient_name_codental} (ID ${log.patient_id_codental}, score ${auto.score.toFixed(2)})`);
            break;
        }
        if (suggestion && (!pendingSuggestion || suggestion.score > pendingSuggestion.score)) {
            pendingSuggestion = { ...suggestion, candidateName: cand.name };
        }
    }

    if (!patientMatch) {
        log.patient_name_extracted = nameCandidates[0]?.name || null;
        if (pendingSuggestion) {
            log.status = 'pending_review';
            log.pending_suggestion = {
                patient_id:   String(pendingSuggestion.patient.id),
                patient_name: pendingSuggestion.patient.name || pendingSuggestion.patient.full_name || '',
                score:        pendingSuggestion.score,
                candidate:    pendingSuggestion.candidateName,
            };
            console.log(`  ⏳ Pendente: sugerindo "${log.pending_suggestion.patient_name}" (score ${pendingSuggestion.score.toFixed(2)})`);
        } else {
            log.status = 'no_patient';
            console.log(`  ❌ Paciente nao identificado: ${log.patient_name_extracted}`);
        }
        await saveLog(log);
        return { ...result, status: log.status };
    }
    const patientId = patientMatch.patient.id;

    // ── Processar cada anexo ─────────────────────────────────────────────────
    for (const att of attachments) {
        const attLog = {
            filename: att.filename,
            mime_type: att.mimeType,
            size_bytes: att.size,
            status: null,
            codental_upload_id: null,
            error_message: null,
            skipped_reason: null,
        };

        try {
            // Verifica duplicata
            const buffer = await downloadAttachment(messageId, att.attachmentId, att.dataInline || null);

            // Verifica duplicata por nome + hash MD5 + tamanho
            if (await isDuplicate(patientId, att.filename, buffer)) {
                console.log(`  ⏭ Duplicata: ${att.filename}`);
                attLog.status = 'skipped_duplicate';
                attLog.skipped_reason = 'Arquivo com mesmo nome já existe no prontuário';
                result.att_duplicate++;
                log.attachments.push(attLog);
                continue;
            }

            console.log(`  ⬇ Arquivo: ${att.filename} (${(att.size / 1024).toFixed(1)} KB)`);

            // Upload
            const { uploadId } = await uploadFile(patientId, buffer, att.filename, att.mimeType);
            attLog.status = 'uploaded';
            attLog.codental_upload_id = uploadId;
            result.att_uploaded++;
            console.log(`  ✅ Upload OK: ${att.filename}`);

        } catch (err) {
            attLog.status = 'error';
            attLog.error_message = err.message;
            result.att_error++;
            console.error(`  ❌ Erro: ${att.filename} — ${err.message}`);
        }

        log.attachments.push(attLog);
    }

    // Status geral do email
    const ok = result.att_uploaded;
    const dup = result.att_duplicate;
    const err = result.att_error;
    const total = log.attachments.length;

    if (ok === 0 && dup === total) log.status = 'duplicate_all';
    else if (ok > 0 && err === 0) log.status = 'uploaded';
    else if (ok > 0 && err > 0) log.status = 'partial';
    else if (ok === 0 && err > 0) log.status = 'failed';
    else log.status = 'uploaded';

    log.marked_read = true;
    await saveLog(log);
    result.status = log.status;
    return result;
}