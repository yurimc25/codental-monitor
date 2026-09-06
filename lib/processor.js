// lib/processor.js — Pipeline principal: não lidos → upload → marcar como lido

import {
    fetchUnreadMessages, fetchMessagesByName, getMessage, getHeaders, getBody,
    getAttachments, downloadAttachment, markAsRead, detectKeywords, findPhoneInContacts,
} from './gmail.js';
import {
    uploadFile, listUploadsWithMeta, downloadUploadBinary,
} from './codental.js';
import { searchPatientsWithFallback } from './patientSearch.js';
import { extractNames, bestMatch, matchWithSuggestions, nameSearchVariants } from './extractor.js';
import { db, getSettings, isProcessed, getExistingLog, saveLog, ensureIndexes } from './db.js';

/**
 * @param {{ sinceDate?: Date|null, days?: number, includeRead?: boolean }} opts
 *   days: quantos dias retroativos buscar (padrão: 2 para cron, configurável no manual)
 *   includeRead: se true, inclui emails já lidos (padrão: true — sempre reprocessa)
 *   sinceDate: data específica (sobrescreve days)
 */
export async function run({ sinceDate = null, days = 2, includeRead = true, offset = 0, batchSize = 80, prevOldestDate = null } = {}) {
    await ensureIndexes();
    const settings = await getSettings();
    const keywords = Array.isArray(settings.keywords) && settings.keywords.length > 0
        ? settings.keywords
        : ['tomografia', 'voxels', 'fenelon', 'radiomaster', 'documentacao', 'cbct', 'radiografia', 'laudo'];

    console.log('🚀 Pipeline iniciado');
    // Mapa de arquivos já enviados — carrega do histórico MongoDB + acumula durante o lote
    // Chaves: "patientId:sizeBytes:ext" e "patientId:filename_lower"
    const batchUploaded = new Map();

    // Pré-carrega histórico de uploads bem-sucedidos do MongoDB
    try {
        const col = (await db()).collection('email_logs');
        const uploadedLogs = await col.find({
            'attachments.status': 'uploaded',
            patient_id_codental: { $exists: true, $ne: null },
        }).toArray();

        for (const log of uploadedLogs) {
            const pid = log.patient_id_codental;
            for (const att of (log.attachments || [])) {
                if (att.status !== 'uploaded') continue;
                const fn  = (att.filename || '').toLowerCase();
                const ext = fn.split('.').pop();
                const sz  = att.size_bytes;
                if (fn)  batchUploaded.set(`${pid}:${fn}`,       { filename: att.filename, messageId: log.gmail_message_id, fromHistory: true });
                if (sz)  batchUploaded.set(`${pid}:${sz}:${ext}`, { filename: att.filename, messageId: log.gmail_message_id, fromHistory: true });
            }
        }
        console.log(`📚 Histórico carregado: ${batchUploaded.size} entradas de ${uploadedLogs.length} logs`);
    } catch (err) {
        console.warn(`⚠️ Erro ao carregar histórico: ${err.message}`);
    }

    const summary = {
        emails_found: 0,
        emails_skipped: 0,
        emails_processed: 0,
        att_uploaded: 0,
        att_duplicate: 0,
        att_error: 0,
        no_patient: 0,
        marked_read: 0,
        since_date: sinceDate ? sinceDate.toISOString() : new Date(Date.now() - days * 86400000).toISOString(),
        errors: [],
    };

    // 1. Busca não lidos (com filtro de data opcional)
    // Calcula data de início: sinceDate explícita ou N dias atrás
    const effectiveSince = sinceDate || new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    console.log(`📅 Buscando emails desde ${effectiveSince.toISOString().slice(0,10)} (includeRead: ${includeRead})`);

    // Busca TODOS os emails com paginação completa
    // A API retorna em ordem do mais recente para o mais antigo
    const messages = await fetchUnreadMessages(keywords, effectiveSince, includeRead);
    summary.emails_found = messages.length;

    // Aplica offset para continuar de onde parou (paginação de processamento)
    const batchSz  = batchSize;
    const batch    = messages.slice(offset, offset + batchSz);
    const hasMore  = (offset + batchSz) < messages.length;

    console.log(`📧 ${messages.length} email(s) total | lote: ${offset}–${offset + batch.length} | tem mais: ${hasMore}`);
    summary.total_found       = messages.length;
    summary.offset            = offset;
    summary.next_offset       = hasMore ? offset + batchSz : null;
    summary.has_more          = hasMore;
    // helper: atualiza datas min/max (persiste entre lotes via opts)
    const trackDate = (d) => {
        if (!d) return;
        const t = new Date(d).getTime();
        if (isNaN(t)) return;
        if (!summary.oldest_date_seen || t < new Date(summary.oldest_date_seen).getTime())
            summary.oldest_date_seen = new Date(d).toISOString();
        if (!summary.newest_date_seen || t > new Date(summary.newest_date_seen).getTime())
            summary.newest_date_seen = new Date(d).toISOString();
    };
    // Inicializa com valor do checkpoint anterior (mantém histórico entre lotes)
    summary.oldest_date_seen = prevOldestDate || null;
    summary.newest_date_seen = null;

    for (const { id: messageId, threadId } of batch) {
        try {
            // Já processado? Verifica se todos os anexos foram enviados com sucesso
            // Se houve limpeza geral (purge), permite reprocessar
            if (await isProcessed(messageId)) {
                // Log existe — verifica se foi totalmente enviado com sucesso
                const existing = await getExistingLog(messageId);
                const fullyUploaded = existing?.status === 'uploaded'
                    && (existing?.attachments || []).some(a => a.status === 'uploaded');

                if (fullyUploaded) {
                    // Já foi enviado com sucesso → marca como lido e pula
                    trackDate(existing?.date);
                    try { await markAsRead(messageId); } catch(_) {}
                    summary.emails_skipped++;
                    continue;
                }

                // Status retry → força reprocessamento mesmo que já tenha sido processado
                if (existing?.status === 'retry') {
                    console.log(`🔄 Reprocessando ${messageId} (retry forçado)`);
                    // Continua para reprocessar
                }
                // Ignorado manualmente pelo usuário → marca como lido e não reprocessa
                else if (existing?.review_action === 'rejected' || existing?.review_action === 'ignore') {
                    trackDate(existing?.date);
                    try { await markAsRead(messageId); } catch(_) {}
                    summary.emails_skipped++;
                    continue;
                }

                // Sem paciente E sem anexos → marca como lido e não reprocessa
                if (existing?.status === 'no_patient' && !(existing?.attachments?.length)) {
                    trackDate(existing?.date);
                    try { await markAsRead(messageId); } catch(_) {}
                    summary.emails_skipped++;
                    continue;
                }

                // pending_review com needs_creation já verificado → não reprocessa
                // (aguarda ação manual da recepcionista)
                if (existing?.needs_creation === true && existing?.status === 'pending_review' && existing?.reviewed_at == null) {
                    trackDate(existing?.date);
                    summary.emails_skipped++;
                    continue;
                }

                // pending_review com sugestão já revisada e rejeitada → não reprocessa
                if (existing?.status === 'no_patient' && existing?.reviewed_at) {
                    trackDate(existing?.date);
                    summary.emails_skipped++;
                    continue;
                }

                // Status diferente → reprocessa
                console.log(`🔄 Reprocessando ${messageId} (status anterior: ${existing?.status})`);
            }

            const result = await processMessage(messageId, threadId, keywords, batchUploaded);
            trackDate(result.date);
            summary.emails_processed++;
            summary.att_uploaded += result.att_uploaded;
            summary.att_duplicate += result.att_duplicate;
            summary.att_error += result.att_error;
            if (result.status === 'no_patient') summary.no_patient++;

            // Marca como lido sempre que o email foi processado (independente do resultado)
            // Se está no log, já foi tratado — não precisa ficar na inbox
            try { await markAsRead(messageId); } catch(_) {}
            summary.marked_read++;

        } catch (err) {
            console.error(`❌ Erro fatal no email ${messageId}:`, err.message);
            summary.errors.push({ messageId, error: err.message });

            // Se foi erro de autenticação Codental, invalida sessão para próxima tentativa
            if (err.message?.includes('_domain_session') || err.message?.includes('Login Codental')) {
                try {
                    const { invalidateSession } = await import('./codental.js');
                    invalidateSession();
                    console.warn('🔑 Sessão Codental invalidada — será renovada na próxima tentativa');
                } catch (_) {}
            }

            // Salva status de erro no log para não perder o email
            try {
                await saveLog({
                    gmail_message_id: messageId,
                    gmail_thread_id: threadId,
                    status: 'failed',
                    error_message: err.message,
                    processed_at: new Date(),
                });
            } catch (_) {}
        }
    }

    console.log('✅ Pipeline concluído:', summary);
    return summary;
}

// ─── PROCESSAR UMA MENSAGEM ───────────────────────────────────────────────────

async function processMessage(messageId, threadId, keywords, batchUploaded) {
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

    const result = { att_uploaded: 0, att_duplicate: 0, att_error: 0, status: null, date: date || null };

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
        // Busca com fallback: base local → API Codental
        const { patients: allPatients, source } = await searchPatientsWithFallback(cand.name);
        console.log(`  🔍 "${cand.name}" (${source}): ${allPatients.length} resultado(s)${allPatients[0] ? ' — melhor: ' + (allPatients[0].name||'?') : ''}`);

        const { auto, suggestion } = matchWithSuggestions([cand], allPatients);

        if (auto) {
            patientMatch = auto;
            log.patient_name_extracted = cand.name;
            log.patient_id_codental = String(auto.patient.id);
            log.patient_name_codental = auto.patient.fullName || auto.patient.name || auto.patient.full_name || null;
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

        // Verifica se este paciente já foi confirmado em outro email (pelo nome extraído)
        if (log.patient_name_extracted) {
            const col = (await db()).collection('email_logs');
            const alreadyConfirmed = await col.findOne({
                patient_name_extracted: { $regex: new RegExp('^' + log.patient_name_extracted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') },
                status: 'uploaded',
                review_action: { $in: ['confirmed', 'created'] },
            });
            if (alreadyConfirmed) {
                // Paciente já confirmado — mas ainda precisa enviar os anexos deste email
                log.patient_id_codental = alreadyConfirmed.patient_id_codental;
                log.patient_name_codental = alreadyConfirmed.patient_name_codental;
                console.log(`  📎 Paciente já confirmado: ${log.patient_name_extracted} → enviando anexos deste email`);
                // Não retorna aqui — continua para enviar os anexos
                pendingSuggestion = {
                    patient: { id: alreadyConfirmed.patient_id_codental, name: alreadyConfirmed.patient_name_codental },
                    score: 1.0,
                    confirmed: true,
                };
            }
        }

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
            // Paciente não encontrado → vai para pendência de criação
            // Busca telefone/CPF nos contatos do Google para pré-preencher o formulário
            log.status = 'pending_review';
            log.pending_suggestion = null; // sem sugestão de paciente existente
            log.needs_creation = true;     // indica que precisa criar novo paciente
            console.log(`  ❌ Paciente não encontrado: ${log.patient_name_extracted} → buscando contatos Google...`);
            try {
                const contactName = log.patient_name_extracted || '';
                const contact = await findPhoneInContacts(contactName);
                if (contact) {
                    log.contact_phone    = contact.phone    || null;
                    log.contact_cpf      = contact.cpf      || null;
                    log.contact_name     = contact.contactName || null;
                    log.contact_found    = true;
                    console.log(`  📱 Contato encontrado: ${contact.contactName} | tel: ${contact.phone||'—'} | CPF: ${contact.cpf||'—'}`);
                } else {
                    log.contact_found = false;
                    log.contact_phone = null;
                    log.contact_cpf   = null;
                    console.log(`  📵 Contato não encontrado no Google para: ${contactName}`);
                }
            } catch(e) {
                log.contact_found = false;
                console.warn(`  ⚠️ Erro ao buscar contato Google: ${e.message}`);
            }
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

            // 1. Verifica duplicata dentro do lote atual (mesma execução)
            const batchKey = `${patientId}:${buffer.length}:${att.filename.split('.').pop().toLowerCase()}`;
            const batchNameKey = `${patientId}:${att.filename.toLowerCase()}`;
            const batchPrev = batchUploaded.get(batchKey) || batchUploaded.get(batchNameKey);
            if (batchPrev) {
                const src = batchPrev.fromHistory ? 'histórico' : 'lote atual';
                console.log(`  ⏭ Duplicata (${src}): ${att.filename} == ${batchPrev.filename}`);
                attLog.status = 'skipped_duplicate';
                attLog.skipped_reason = `Duplicata de ${batchPrev.filename} (${src})`;
                result.att_duplicate++;
                log.attachments.push(attLog);
                continue;
            }

            // (verificação no Codental removida — usa só dedup em memória, igual à simulação)

            console.log(`  ⬇ Arquivo: ${att.filename} (${(att.size / 1024).toFixed(1)} KB)`);

            // Upload
            const { uploadId } = await uploadFile(patientId, buffer, att.filename, att.mimeType);
            attLog.status = 'uploaded';
            attLog.codental_upload_id = uploadId;
            result.att_uploaded++;
            // Registra no mapa do lote para evitar reenvio no mesmo processamento
            batchUploaded.set(batchKey, { filename: att.filename, messageId });
            batchUploaded.set(batchNameKey, { filename: att.filename, messageId });
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

// ─── REPROCESSAR MENSAGENS ESPECÍFICAS ───────────────────────────────────────
// Processa diretamente uma lista de message IDs sem varrer o Gmail
export async function processSpecificMessages(messages) {
    await ensureIndexes();
    const settings = await getSettings();
    const keywords = Array.isArray(settings.keywords) && settings.keywords.length > 0
        ? settings.keywords
        : ['tomografia', 'voxels', 'fenelon', 'radiomaster', 'documentacao', 'cbct', 'radiografia', 'laudo'];

    // Carrega histórico de uploads para verificação de duplicatas
    const col = (await (await import('./db.js')).db()).collection('email_logs');
    const uploadedLogs = await col.find({ 'attachments.status': 'uploaded' }).toArray();
    const batchUploaded = new Map();
    for (const log of uploadedLogs) {
        for (const att of (log.attachments || [])) {
            if (att.status !== 'uploaded') continue;
            const key = att.filename?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';
            if (key) batchUploaded.set(key, log.patient_id_codental);
        }
    }

    const summary = { emails_processed: 0, att_uploaded: 0, att_duplicate: 0, att_error: 0, errors: [] };

    console.log(`🔁 Reprocessando ${messages.length} email(s) específicos...`);

    for (const { id: messageId, threadId } of messages) {
        try {
            // Reseta o status do log para permitir reprocessamento
            await col.updateOne(
                { gmail_message_id: messageId },
                { $set: { status: 'retry' } }
            );
            const result = await processMessage(messageId, threadId || messageId, keywords, batchUploaded);
            summary.emails_processed++;
            summary.att_uploaded  += result.att_uploaded  || 0;
            summary.att_duplicate += result.att_duplicate || 0;
            summary.att_error     += result.att_error     || 0;
            if (result.att_uploaded > 0) {
                // Atualiza histórico com novos uploads
                for (const [k, v] of Object.entries(result.uploaded_keys || {})) {
                    batchUploaded.set(k, v);
                }
            }
        } catch (err) {
            console.error(`❌ Erro ao reprocessar ${messageId}:`, err.message);
            summary.errors.push({ messageId, error: err.message });
        }
    }

    console.log(`✅ retry_errors concluído:`, summary);
    return summary;
}

// ─── PROCESSAR POR NOME DE PACIENTE (requisição externa) ─────────────────────
// Recebe um nome, verifica se há emails com anexos mencionando essa pessoa, e
// envia somente os arquivos únicos (ainda não enviados) direto para o
// prontuário do paciente já identificado no Codental.
export async function processByPatientName(name, { days = 365, includeRead = true } = {}) {
    await ensureIndexes();
    if (!name || typeof name !== 'string' || !name.trim()) {
        return { ok: false, reason: 'invalid_name', message: 'Nome não informado.' };
    }
    const cleanName = name.trim();

    // 1. Resolve o paciente no Codental (base local + API)
    const { patients, source } = await searchPatientsWithFallback(cleanName);
    const best = patients[0];
    if (!best || (best.score ?? 0) < 0.90) {
        return {
            ok: false,
            reason: 'patient_not_found',
            message: `Nenhum paciente encontrado com confiança suficiente para "${cleanName}".`,
            suggestions: patients.slice(0, 5).map(p => ({ id: p.id, name: p.name, score: p.score })),
        };
    }
    const patientId = String(best.id);
    const patientName = best.name || best.fullName || cleanName;
    console.log(`👤 Paciente resolvido: ${patientName} (ID ${patientId}, fonte: ${source}, score ${best.score?.toFixed(2)})`);

    // 2. Busca emails com anexo mencionando o nome
    const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const messages = await fetchMessagesByName(cleanName, sinceDate, includeRead);

    // 3. Carrega histórico de uploads já feitos para ESTE paciente (dedup)
    const batchUploaded = new Map();
    try {
        const col = (await db()).collection('email_logs');
        const uploadedLogs = await col.find({
            patient_id_codental: patientId,
            'attachments.status': 'uploaded',
        }).toArray();
        for (const log of uploadedLogs) {
            for (const att of (log.attachments || [])) {
                if (att.status !== 'uploaded') continue;
                const fn  = (att.filename || '').toLowerCase();
                const ext = fn.split('.').pop();
                const sz  = att.size_bytes;
                if (fn) batchUploaded.set(`${patientId}:${fn}`, { filename: att.filename, fromHistory: true });
                if (sz) batchUploaded.set(`${patientId}:${sz}:${ext}`, { filename: att.filename, fromHistory: true });
            }
        }
    } catch (err) {
        console.warn(`⚠️ Erro ao carregar histórico do paciente ${patientId}: ${err.message}`);
    }

    // Também considera os arquivos já presentes no prontuário atual (ex.: enviados manualmente)
    try {
        const currentUploads = await listUploadsWithMeta(patientId);
        for (const u of currentUploads) {
            const fn  = (u.name || u.filename || u.file_name || '').toLowerCase();
            const ext = fn.split('.').pop();
            const sz  = u.byte_size;
            if (fn) batchUploaded.set(`${patientId}:${fn}`, { filename: fn, fromHistory: true });
            if (sz) batchUploaded.set(`${patientId}:${sz}:${ext}`, { filename: fn, fromHistory: true });
        }
    } catch (err) {
        console.warn(`⚠️ Erro ao listar uploads atuais do paciente ${patientId}: ${err.message}`);
    }

    const summary = {
        ok: true,
        patient_id: patientId,
        patient_name: patientName,
        emails_found: messages.length,
        emails_processed: 0,
        att_uploaded: 0,
        att_duplicate: 0,
        att_error: 0,
        errors: [],
        duplicate_records: null,
    };

    // 4. Processa cada email — envia só os anexos únicos direto para o paciente
    for (const { id: messageId, threadId } of messages) {
        try {
            const message = await getMessage(messageId);
            const { subject, from, date } = getHeaders(message);
            const attachments = getAttachments(message);

            const log = {
                gmail_message_id: messageId,
                gmail_thread_id: threadId,
                subject,
                from,
                date,
                patient_name_extracted: cleanName,
                patient_id_codental: patientId,
                patient_name_codental: patientName,
                attachments: [],
                status: null,
                source: 'process_by_name',
            };

            if (attachments.length === 0) {
                log.status = 'no_attachments';
                await saveLog(log);
                summary.emails_processed++;
                try { await markAsRead(messageId); } catch (_) {}
                continue;
            }

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
                    const buffer = await downloadAttachment(messageId, att.attachmentId, att.dataInline || null);
                    const ext = att.filename.split('.').pop().toLowerCase();
                    const batchKey = `${patientId}:${buffer.length}:${ext}`;
                    const batchNameKey = `${patientId}:${att.filename.toLowerCase()}`;
                    const dup = batchUploaded.get(batchKey) || batchUploaded.get(batchNameKey);

                    if (dup) {
                        attLog.status = 'skipped_duplicate';
                        attLog.skipped_reason = `Duplicata de ${dup.filename}`;
                        summary.att_duplicate++;
                        log.attachments.push(attLog);
                        continue;
                    }

                    const { uploadId } = await uploadFile(patientId, buffer, att.filename, att.mimeType);
                    attLog.status = 'uploaded';
                    attLog.codental_upload_id = uploadId;
                    summary.att_uploaded++;
                    batchUploaded.set(batchKey, { filename: att.filename });
                    batchUploaded.set(batchNameKey, { filename: att.filename });
                } catch (err) {
                    attLog.status = 'error';
                    attLog.error_message = err.message;
                    summary.att_error++;
                }
                log.attachments.push(attLog);
            }

            const ok = log.attachments.filter(a => a.status === 'uploaded').length;
            const dupCount = log.attachments.filter(a => a.status === 'skipped_duplicate').length;
            const errCount = log.attachments.filter(a => a.status === 'error').length;
            if (ok === 0 && dupCount === log.attachments.length) log.status = 'duplicate_all';
            else if (ok > 0 && errCount === 0) log.status = 'uploaded';
            else if (ok > 0 && errCount > 0) log.status = 'partial';
            else log.status = 'failed';

            await saveLog(log);
            summary.emails_processed++;
            try { await markAsRead(messageId); } catch (_) {}

        } catch (err) {
            console.error(`❌ Erro ao processar email ${messageId} para ${patientName}:`, err.message);
            summary.errors.push({ messageId, error: err.message });
        }
    }

    // 5. Complementa com arquivos que só existem em cadastros DUPLICADOS do
    //    mesmo paciente na mesma clínica (mesma sessão principal — sem login extra)
    summary.duplicate_records = await complementFromDuplicateRecords(cleanName, patientId, patientName, batchUploaded, patients);
    summary.att_uploaded  += summary.duplicate_records.att_uploaded;
    summary.att_duplicate += summary.duplicate_records.att_duplicate;
    summary.att_error     += summary.duplicate_records.att_error;

    console.log('✅ processByPatientName concluído:', summary);
    return summary;
}

// ─── COMPLEMENTAR COM ARQUIVOS DE CADASTROS DUPLICADOS DO MESMO PACIENTE ─────
// Às vezes o mesmo paciente tem mais de um cadastro na MESMA clínica (ex.:
// recadastro por engano, nome de solteira, etc.), cada um com arquivos
// diferentes. Usa a mesma sessão principal (sem login extra) para achar os
// outros cadastros com nome equivalente e copiar pro cadastro "oficial"
// (patientId) só os arquivos que ainda não existem nele.
async function complementFromDuplicateRecords(patientName, primaryPatientId, primaryPatientName, batchUploaded, candidatePatients) {
    const result = {
        checked: true,
        reason: null,
        duplicates_found: [],
        files_found: 0,
        att_uploaded: 0,
        att_duplicate: 0,
        att_error: 0,
        errors: [],
    };

    // Acha todos os outros cadastros com nome equivalente (score alto),
    // um de cada vez, removendo o já encontrado antes de procurar o próximo.
    const seenIds = new Set([String(primaryPatientId)]);
    let remaining = (candidatePatients || []).filter(p => !seenIds.has(String(p.id)));
    const duplicates = [];
    while (remaining.length && duplicates.length < 5) {
        const match = bestMatch([{ name: patientName, confidence: 'high' }], remaining, 0.90);
        if (!match) break;
        const dupId = String(match.patient.id);
        duplicates.push({ id: dupId, name: match.patient.name || match.patient.fullName || patientName, score: match.score });
        seenIds.add(dupId);
        remaining = remaining.filter(p => !seenIds.has(String(p.id)));
    }

    if (!duplicates.length) {
        result.reason = 'no_duplicates_found';
        return result;
    }
    result.duplicates_found = duplicates;

    for (const dup of duplicates) {
        console.log(`👤 Cadastro duplicado encontrado: ${dup.name} (ID ${dup.id}, score ${dup.score?.toFixed(2)})`);

        let dupUploads;
        try {
            dupUploads = await listUploadsWithMeta(dup.id);
        } catch (err) {
            result.errors.push(`paciente ${dup.id}: ${err.message}`);
            continue;
        }
        result.files_found += dupUploads.length;

        for (const item of dupUploads) {
            const filename = item.name || item.filename || item.file_name || '';
            if (!filename) continue;
            const ext = filename.toLowerCase().split('.').pop();
            const size = item.byte_size || null;
            const nameKey = `${primaryPatientId}:${filename.toLowerCase()}`;
            const sizeKey = size ? `${primaryPatientId}:${size}:${ext}` : null;

            if (batchUploaded.has(nameKey) || (sizeKey && batchUploaded.has(sizeKey))) {
                result.att_duplicate++;
                continue;
            }

            try {
                const buffer = await downloadUploadBinary(item);
                const mimeType = item.content_type || item.mime_type || 'application/octet-stream';
                await uploadFile(primaryPatientId, buffer, filename, mimeType);
                result.att_uploaded++;
                batchUploaded.set(nameKey, { filename });
                batchUploaded.set(`${primaryPatientId}:${buffer.length}:${ext}`, { filename });
            } catch (err) {
                result.att_error++;
                result.errors.push(`${filename} (paciente ${dup.id}): ${err.message}`);
                console.warn(`⚠️ Falha ao complementar "${filename}" do cadastro duplicado ${dup.id}: ${err.message}`);
            }
        }
    }

    return result;
}