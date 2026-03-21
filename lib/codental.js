// lib/codental.js — Codental: autenticação, busca de pacientes, upload

import crypto from 'crypto';
import { getSettings } from './db.js';

// ─── SESSION CACHE ────────────────────────────────────────────────────────────
// Mantém sessão em memória durante a execução do cron (até 5 minutos)
let _session = null;
let _sessionAt = 0;
const SESSION_TTL = 5 * 60 * 1000;

async function session() {
    if (_session && Date.now() - _sessionAt < SESSION_TTL) return _session;
    _session = await authenticate();
    _sessionAt = Date.now();
    return _session;
}

// ─── AUTENTICAÇÃO ─────────────────────────────────────────────────────────────

async function authenticate() {
    const settings = await getSettings();
    const base = settings.codental_base_url
        || process.env.CODENTAL_BASE_URL
        || 'https://odonto-on-face.codental.com.br';
    if (!base || base === 'undefined') throw new Error('CODENTAL_BASE_URL não configurada. Adicione nas variáveis de ambiente da Vercel.');

    // 1. Busca página de login para obter CSRF
    const loginPage = await fetch(`${base}/users/sign_in`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
        redirect: 'follow',
    });
    const html = await loginPage.text();
    const rawCookie = loginPage.headers.get('set-cookie') || '';

    const csrfMatch = html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)/i)
        || html.match(/content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i);
    if (!csrfMatch) throw new Error('CSRF token não encontrado na página de login do Codental');
    const csrf = csrfMatch[1];

    const initCookie = (rawCookie.match(/_session=[^;,]+/) || [])[0] || '';

    // 2. POST login
    const loginRes = await fetch(`${base}/users/sign_in`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-CSRF-Token': csrf,
            'Cookie': initCookie,
            'User-Agent': 'Mozilla/5.0',
            'Referer': `${base}/users/sign_in`,
        },
        body: new URLSearchParams({
            'user[email]': process.env.CODENTAL_EMAIL,
            'user[password]': process.env.CODENTAL_PASSWORD,
            authenticity_token: csrf,
        }).toString(),
    });

    const newCookies = loginRes.headers.get('set-cookie') || '';
    const sessionCookie = (newCookies.match(/_session=[^;,]+/) || [])[0];
    if (!sessionCookie) throw new Error('Login Codental falhou — sessão não retornada. Verifique email/senha.');

    // 3. Pega novo CSRF da página inicial (mais seguro que reusar o anterior)
    const homeRes = await fetch(`${base}/patients`, {
        headers: { 'Cookie': sessionCookie, 'User-Agent': 'Mozilla/5.0' },
    });
    const homeHtml = await homeRes.text();
    const csrfMatch2 = homeHtml.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)/i)
        || homeHtml.match(/content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i);
    const sessionCsrf = csrfMatch2 ? csrfMatch2[1] : csrf;

    console.log('✅ Autenticado no Codental');
    return { base, cookie: sessionCookie, csrf: sessionCsrf };
}

// ─── BUSCAR PACIENTES ─────────────────────────────────────────────────────────

export async function searchPatients(name) {
    const { base, cookie } = await session();
    const encoded = encodeURIComponent(name);

    // Tenta os endpoints mais comuns de busca em apps Rails
    const endpoints = [
        `${base}/patients.json?q=${encoded}`,
        `${base}/patients/search.json?term=${encoded}`,
        `${base}/patients/search.json?q=${encoded}`,
        `${base}/patients.json?search=${encoded}`,
    ];

    for (const url of endpoints) {
        try {
            const res = await fetch(url, {
                headers: { 'Cookie': cookie, 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
            });
            if (!res.ok) continue;
            const ct = res.headers.get('content-type') || '';
            if (!ct.includes('json')) continue;
            const data = await res.json();
            const list = Array.isArray(data) ? data : (data.patients || data.data || []);
            if (list.length >= 0) { // endpoint respondeu
                console.log(`🔍 Busca "${name}" em ${url}: ${list.length} resultado(s)`);
                return list;
            }
        } catch (_) {}
    }

    return [];
}

// ─── LISTAR UPLOADS DO PACIENTE ───────────────────────────────────────────────

export async function listUploads(patientId) {
    const { base, cookie } = await session();
    const res = await fetch(`${base}/patients/${patientId}/uploads.json`, {
        headers: { 'Cookie': cookie, 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) {
        console.warn(`⚠️ Não foi possível listar uploads do paciente ${patientId}: ${res.status}`);
        return [];
    }
    const data = await res.json();
    return Array.isArray(data) ? data : (data.uploads || []);
}

// ─── VERIFICAR DUPLICATA ──────────────────────────────────────────────────────

export async function isDuplicate(patientId, filename) {
    try {
        const uploads = await listUploads(patientId);
        const target = filename.toLowerCase();
        return uploads.some(u => (u.name || u.filename || '').toLowerCase() === target);
    } catch {
        return false; // em caso de erro, tenta o upload
    }
}

// ─── UPLOAD (Rails Active Storage) ───────────────────────────────────────────
// Replica exatamente o fluxo do content.js da extensão da câmera:
// direct_uploads → S3 (se houver) → /patients/:id/uploads

export async function uploadFile(patientId, buffer, filename, mimeType) {
    const { base, cookie, csrf } = await session();
    const checksum = md5b64(buffer);

    // 1. Registrar blob
    const directRes = await fetch(`${base}/rails/active_storage/direct_uploads`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf,
            'Cookie': cookie,
            'User-Agent': 'Mozilla/5.0',
        },
        body: JSON.stringify({
            blob: { filename, content_type: mimeType, byte_size: buffer.length, checksum },
        }),
    });
    if (!directRes.ok) {
        const err = await directRes.text();
        throw new Error(`direct_uploads falhou (${directRes.status}): ${err.slice(0, 200)}`);
    }
    const blob = await directRes.json();
    const { signed_id, direct_upload } = blob;

    // 2. Upload para S3 (se necessário)
    if (direct_upload?.url) {
        const s3 = await fetch(direct_upload.url, {
            method: 'PUT',
            headers: direct_upload.headers || {},
            body: buffer,
        });
        if (!s3.ok) throw new Error(`S3 upload falhou: ${s3.status}`);
    }

    // 3. Criar registro no Codental
    const form = new FormData();
    form.append('upload[name]', filename);
    form.append('upload[notes]', 'Importado automaticamente via monitor de email');
    form.append('upload[file]', signed_id);

    const uploadRes = await fetch(`${base}/patients/${patientId}/uploads`, {
        method: 'POST',
        headers: {
            'X-CSRF-Token': csrf,
            'Cookie': cookie,
            'User-Agent': 'Mozilla/5.0',
        },
        body: form,
    });
    if (!uploadRes.ok) throw new Error(`Criação do upload falhou: ${uploadRes.status}`);

    // Extrai ID do upload da Location header
    const location = uploadRes.headers.get('location') || '';
    const idMatch = location.match(/uploads\/(\d+)/);
    return { signedId: signed_id, uploadId: idMatch?.[1] || null };
}

// ─── MD5 BASE64 ───────────────────────────────────────────────────────────────

function md5b64(buffer) {
    return crypto.createHash('md5').update(buffer).digest('base64');
}