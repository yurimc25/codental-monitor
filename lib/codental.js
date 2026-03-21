// lib/codental.js — Codental: autenticação via cookie _domain_session + uploads

import crypto from 'crypto';

const APP_BASE  = 'https://odonto-on-face.codental.com.br';
const LOGIN_URL = 'https://www.codental.com.br/login';

// ─── SESSION CACHE ────────────────────────────────────────────────────────────
let _session = null;
let _sessionAt = 0;
const SESSION_TTL = 4 * 60 * 1000;

async function getSession() {
    if (_session && Date.now() - _sessionAt < SESSION_TTL) return _session;
    _session = await authenticate();
    _sessionAt = Date.now();
    return _session;
}

// ─── AUTENTICAÇÃO ─────────────────────────────────────────────────────────────
// O Codental usa cookie _domain_session com domínio .codental.com.br
// O login é feito em www.codental.com.br/login (Rails form)
// O cookie retornado funciona para odonto-on-face.codental.com.br também
async function authenticate() {
    console.log('🔐 Autenticando no Codental...');

    // 1. Busca a página de login para obter CSRF token
    const loginPageRes = await fetch(LOGIN_URL, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml',
        },
        redirect: 'follow',
    });

    const loginHtml = await loginPageRes.text();
    const rawCookie = loginPageRes.headers.get('set-cookie') || '';

    // Extrai CSRF do meta tag
    const csrfMatch = loginHtml.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)/i)
        || loginHtml.match(/content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i);
    if (!csrfMatch) throw new Error('CSRF token não encontrado na página de login do Codental');
    const csrf = csrfMatch[1];

    // Cookie inicial (session vazia antes do login)
    const initCookie = (rawCookie.match(/_domain_session=[^;,]+/) || [])[0]
        || (rawCookie.match(/_session=[^;,]+/) || [])[0]
        || '';

    // 2. POST de login
    const loginRes = await fetch(LOGIN_URL, {
        method: 'POST',
        redirect: 'manual', // não segue redirect para poder pegar o cookie
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': initCookie,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': LOGIN_URL,
            'X-CSRF-Token': csrf,
        },
        body: new URLSearchParams({
            'professional[email]': process.env.CODENTAL_EMAIL,
            'professional[password]': process.env.CODENTAL_PASSWORD,
            'professional[remember_me]': '1',
            authenticity_token: csrf,
        }).toString(),
    });

    // O cookie _domain_session vem no redirect após login bem-sucedido
    const setCookieHeader = loginRes.headers.get('set-cookie') || '';
    console.log('🍪 Set-Cookie recebido:', setCookieHeader.slice(0, 120));

    const domainSession = (setCookieHeader.match(/_domain_session=[^;,]+/) || [])[0]
        || (setCookieHeader.match(/_session=[^;,]+/) || [])[0];

    if (!domainSession) {
        throw new Error(
            'Login Codental falhou — _domain_session não retornado. ' +
            'Verifique CODENTAL_EMAIL e CODENTAL_PASSWORD nas variáveis da Vercel.'
        );
    }

    // 3. Segue o redirect para obter CSRF válido do app
    const appRes = await fetch(`${APP_BASE}/patients`, {
        headers: {
            'Cookie': domainSession,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
    });
    const appHtml = await appRes.text();

    // Pega CSRF do app (pode ser diferente do CSRF da página de login)
    const appCsrfMatch = appHtml.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)/i)
        || appHtml.match(/content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i);
    const appCsrf = appCsrfMatch ? appCsrfMatch[1] : csrf;

    // Atualiza cookie com qualquer novo _domain_session do app
    const appCookieHeader = appRes.headers.get('set-cookie') || '';
    const freshSession = (appCookieHeader.match(/_domain_session=[^;,]+/) || [])[0] || domainSession;

    console.log('✅ Autenticado no Codental');
    return { cookie: freshSession, csrf: appCsrf };
}

// ─── HEADERS BASE ─────────────────────────────────────────────────────────────
async function headers(extra = {}) {
    const s = await getSession();
    return {
        'Cookie': s.cookie,
        'X-CSRF-Token': s.csrf,
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...extra,
    };
}

// ─── BUSCAR PACIENTES ─────────────────────────────────────────────────────────
// Endpoint confirmado: GET /patients/search.json?query=NOME
export async function searchPatients(name) {
    const hdrs = await headers();
    const url = `${APP_BASE}/patients/search.json?query=${encodeURIComponent(name)}`;

    const res = await fetch(url, { headers: hdrs });
    if (!res.ok) {
        console.warn(`⚠️ searchPatients ${res.status} para "${name}"`);
        return [];
    }

    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.patients || data.data || []);
    console.log(`🔍 "${name}": ${list.length} resultado(s)`);
    return list;
}

// ─── LISTAR UPLOADS DO PACIENTE ───────────────────────────────────────────────
export async function listUploads(patientId) {
    const hdrs = await headers();
    const res = await fetch(`${APP_BASE}/patients/${patientId}/uploads.json`, { headers: hdrs });
    if (!res.ok) {
        console.warn(`⚠️ listUploads ${res.status} para paciente ${patientId}`);
        return [];
    }
    const data = await res.json();
    return Array.isArray(data) ? data : (data.uploads || data.data || []);
}

// ─── VERIFICAR DUPLICATA ──────────────────────────────────────────────────────
export async function isDuplicate(patientId, filename) {
    try {
        const uploads = await listUploads(patientId);
        const target = filename.toLowerCase();
        return uploads.some(u =>
            (u.name || u.filename || u.file_name || '').toLowerCase() === target
        );
    } catch {
        return false;
    }
}

// ─── UPLOAD (Rails Active Storage) ───────────────────────────────────────────
export async function uploadFile(patientId, buffer, filename, mimeType) {
    const s = await getSession();
    const baseHdrs = {
        'Cookie': s.cookie,
        'X-CSRF-Token': s.csrf,
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };

    const checksum = md5b64(buffer);

    // 1. Registrar blob no Active Storage
    const directRes = await fetch(`${APP_BASE}/rails/active_storage/direct_uploads`, {
        method: 'POST',
        headers: { ...baseHdrs, 'Content-Type': 'application/json', 'Accept': 'application/json' },
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

    // 2. Upload para S3 se necessário
    if (direct_upload?.url) {
        const s3 = await fetch(direct_upload.url, {
            method: 'PUT',
            headers: direct_upload.headers || {},
            body: buffer,
        });
        if (!s3.ok) throw new Error(`S3 upload falhou: ${s3.status}`);
        console.log('☁️ Arquivo enviado para S3');
    }

    // 3. Criar registro no prontuário do paciente
    const form = new FormData();
    form.append('upload[name]', filename);
    form.append('upload[notes]', 'Importado automaticamente via monitor de email');
    form.append('upload[file]', signed_id);

    const uploadRes = await fetch(`${APP_BASE}/patients/${patientId}/uploads`, {
        method: 'POST',
        headers: baseHdrs,
        body: form,
    });

    if (!uploadRes.ok) throw new Error(`Criação do upload falhou: ${uploadRes.status}`);

    const location = uploadRes.headers.get('location') || '';
    const idMatch = location.match(/uploads\/(\d+)/);
    console.log(`✅ Upload concluído — paciente ${patientId}, arquivo: ${filename}`);
    return { signedId: signed_id, uploadId: idMatch?.[1] || null };
}

// ─── MD5 BASE64 ───────────────────────────────────────────────────────────────
function md5b64(buffer) {
    return crypto.createHash('md5').update(buffer).digest('base64');
}