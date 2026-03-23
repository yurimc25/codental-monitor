// lib/codental.js — Codental: autenticação + uploads
import crypto from 'crypto';

const APP_BASE   = process.env.CODENTAL_BASE_URL || 'https://app.codental.com.br';
const LOGIN_BASE = 'https://app.codental.com.br';
const LOGIN_URL  = LOGIN_BASE + '/login';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// ─── FETCH COM TIMEOUT ────────────────────────────────────────────────────────
async function fetchWithTimeout(url, options = {}, timeout = 8000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch (e) {
        clearTimeout(id);
        throw e;
    }
}

// ─── MERGE DE COOKIES ─────────────────────────────────────────────────────────
function mergeCookies(...cookieStrings) {
    const map = new Map();
    for (const str of cookieStrings) {
        if (!str) continue;
        for (const part of str.split('; ')) {
            const eq = part.indexOf('=');
            if (eq > 0) {
                const key = part.slice(0, eq).trim();
                if (key) map.set(key, part);
            }
        }
    }
    return [...map.values()].join('; ');
}

// ─── SESSION CACHE ─────────────────────────────────────────────────────────────
let _memSession = null;
let _memSessionAt = 0;
const SESSION_TTL = 45 * 60 * 1000; // 45 min

async function saveSessionToDb(session) {
    try {
        const { db } = await import('./db.js');
        const col = (await db()).collection('settings');
        await col.updateOne(
            { _id: 'codental_session' },
            { $set: { cookie: session.cookie, csrf: session.csrf, saved_at: new Date() } },
            { upsert: true }
        );
        console.log('💾 Sessão Codental salva no banco');
    } catch (e) { console.warn('⚠️ Não foi possível salvar sessão no DB:', e.message); }
}

async function loadSessionFromDb() {
    try {
        const { db } = await import('./db.js');
        const col = (await db()).collection('settings');
        const doc = await col.findOne({ _id: 'codental_session' });
        if (!doc?.cookie) return null;
        const age = Date.now() - new Date(doc.saved_at).getTime();
        if (age > SESSION_TTL) return null;
        return { cookie: doc.cookie, csrf: doc.csrf };
    } catch (e) { return null; }
}

export function invalidateSession() {
    _memSession = null;
    _memSessionAt = 0;
}

async function getSession() {
    // 1. Memória
    if (_memSession && Date.now() - _memSessionAt < SESSION_TTL) return _memSession;
    // 2. Banco
    const dbSession = await loadSessionFromDb();
    if (dbSession) {
        _memSession = dbSession;
        _memSessionAt = Date.now();
        console.log('🔑 Sessão Codental carregada do banco');
        return _memSession;
    }
    // 3. Novo login
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            _memSession = await authenticate();
            _memSessionAt = Date.now();
            await saveSessionToDb(_memSession);
            return _memSession;
        } catch (err) {
            lastErr = err;
            if (attempt < 3) {
                const wait = attempt * 15000;
                console.warn(`⚠️ Login Codental falhou (tentativa ${attempt}/3), aguardando ${wait/1000}s... [${err.message?.slice(0,60)}]`);
                await new Promise(r => setTimeout(r, wait));
            }
        }
    }
    throw lastErr;
}

// ─── AUTENTICAÇÃO ─────────────────────────────────────────────────────────────
async function authenticate() {
    console.log('🔐 Autenticando no Codental...');

    // 1. Página de login → CSRF inicial
    const loginPageRes = await fetch(LOGIN_URL, {
        headers: {
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'pt-BR,pt;q=0.9',
        },
        redirect: 'follow',
    });
    const loginHtml = await loginPageRes.text();
    const csrfMatch = loginHtml.match(/name="authenticity_token"[^>]+value="([^"]+)"/i)
        || loginHtml.match(/value="([^"]+)"[^>]+name="authenticity_token"/i);
    if (!csrfMatch) throw new Error('CSRF token não encontrado na página de login');
    const csrf = csrfMatch[1];

    let cookies = '';
    if (typeof loginPageRes.headers.getSetCookie === 'function') {
        cookies = loginPageRes.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    } else {
        cookies = (loginPageRes.headers.get('set-cookie') || '').split(';')[0];
    }

    console.log('🔍 Login page status:', loginPageRes.status, '| URL:', loginPageRes.url || LOGIN_URL);
    console.log('🔍 CSRF:', csrf ? csrf.slice(0,30)+'...' : 'NÃO ENCONTRADO');
    console.log('🔍 HTML title:', (loginHtml.match(/<title>([^<]+)/) || [])[1] || 'sem title');

    // 2. POST de login
    const loginRes = await fetch(LOGIN_URL, {
        method: 'POST',
        redirect: 'manual',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': cookies,
            'User-Agent': UA,
            'Referer': LOGIN_URL,
            'Origin': LOGIN_BASE,
        },
        body: new URLSearchParams({
            'authenticity_token': csrf,
            'professional[email]': process.env.CODENTAL_EMAIL,
            'professional[password]': process.env.CODENTAL_PASSWORD,
            'professional[remember_me]': '1',
            'commit': 'Entrar',
        }).toString(),
    });

    let loginCookies = '';
    if (typeof loginRes.headers.getSetCookie === 'function') {
        loginCookies = loginRes.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    } else {
        loginCookies = (loginRes.headers.get('set-cookie') || '').split(';')[0];
    }
    console.log('🍪 Set-Cookie recebido:', loginCookies.slice(0, 200));
    console.log('📊 Status login:', loginRes.status, loginRes.headers.get('location'));

    if (loginRes.status === 500) throw new Error('Codental retornou HTTP 500 — servidor com erro interno.');
    if (loginRes.status === 200) throw new Error('Login falhou — credenciais incorretas ou conta bloqueada.');

    const loginLocation = loginRes.headers.get('location') || '';
    // Login bem-sucedido redireciona para /establishments ou /patients (nunca para /login)
    if (loginRes.status === 302 && loginLocation.includes('/login')) {
        throw new Error('Login falhou — redirecionou de volta para /login. Verifique CODENTAL_EMAIL e CODENTAL_PASSWORD.');
    }
    console.log('✅ Login aceito → redirect para:', loginLocation);

    cookies = mergeCookies(cookies, loginCookies);

    // Segue o redirect do login para pegar CSRF da sessão ativa
    // HAR confirma: redirect do login vai para /establishments → / 
    // O CSRF da sessão está disponível em / (mais leve que /patients)
    // Tenta na ordem: redirect destino → / → /patients
    const redirectTarget = loginRes.headers.get('location') || `${APP_BASE}/`;
    const csrfTargets = [redirectTarget, `${APP_BASE}/`, `${APP_BASE}/patients`];
    console.log('🔀 Buscando CSRF de sessão...');

    let activeCsrf = null;
    for (const target of csrfTargets) {
        if (activeCsrf) break;
        for (let i = 0; i < 2; i++) {
            try {
                const sessionRes = await fetchWithTimeout(target, {
                    headers: { 'Cookie': cookies, 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
                    redirect: 'follow',
                }, 6000);

                console.log(`🏠 ${target.replace(APP_BASE,'')||'/'}: HTTP ${sessionRes.status}`);

                if (typeof sessionRes.headers.getSetCookie === 'function') {
                    const sc = sessionRes.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
                    if (sc) cookies = mergeCookies(cookies, sc);
                }

                const sessionHtml = await sessionRes.text();
                const m = sessionHtml.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)/i)
                    || sessionHtml.match(/content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i);
                if (m) { activeCsrf = m[1]; break; }
                else console.warn(`⚠️ CSRF não encontrado em ${target}, tentativa ${i+1}`);
            } catch(e) {
                console.warn(`⚠️ ${target.replace(APP_BASE,'')||'/'} tentativa ${i+1} falhou: ${e.message}`);
                if (i === 0) await new Promise(r => setTimeout(r, 1000));
            }
        }
    }

    if (!activeCsrf) throw new Error('Falha ao capturar CSRF de sessão em todas as páginas tentadas');
    console.log('🔑 CSRF sessão:', activeCsrf.slice(0,20)+'... (', activeCsrf === csrf ? 'igual ao login ⚠️' : 'diferente ✅', ')');

    const finalCookies = mergeCookies(cookies, 'logged_in=1', 'selected_establishment=13226');
    const cookieKeys = finalCookies.split('; ').map(c => c.split('=')[0]);
    console.log('🍪 Cookies presentes:', cookieKeys.join(', '));
    console.log('✅ Autenticado no Codental');
    return { cookie: finalCookies, csrf: activeCsrf };
}

// ─── HEADERS BASE ─────────────────────────────────────────────────────────────
async function headers(extra = {}) {
    const s = await getSession();
    return {
        'Cookie': s.cookie,
        'X-CSRF-Token': s.csrf,
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json',
        'User-Agent': UA,
        ...extra,
    };
}

// ─── BUSCAR PACIENTES ─────────────────────────────────────────────────────────
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
    list.forEach(p => { if (!p.name && p.fullName) p.name = p.fullName; });
    return list;
}

// ─── LISTAR UPLOADS DO PACIENTE ───────────────────────────────────────────────
export async function listUploads(patientId) {
    const hdrs = await headers();
    const res = await fetch(`${APP_BASE}/patients/${patientId}/uploads.json`, { headers: hdrs });
    if (!res.ok) { console.warn(`⚠️ listUploads ${res.status} para paciente ${patientId}`); return []; }
    const data = await res.json();
    return Array.isArray(data) ? data : (data.uploads || data.data || []);
}

// ─── VERIFICAR DUPLICATA ──────────────────────────────────────────────────────
export async function isDuplicate(patientId, filename, buffer = null) {
    try {
        const uploads = await listUploads(patientId);
        if (!uploads.length) return false;
        const targetName = filename.toLowerCase();
        const targetSize = buffer ? buffer.length : null;
        const targetHash = buffer ? md5b64(buffer) : null;
        for (const u of uploads) {
            const existingName = (u.name || u.filename || u.file_name || '').toLowerCase();
            if (existingName === targetName) return true;
            if (targetHash && u.checksum && u.checksum === targetHash) return true;
            if (targetSize && u.byte_size && u.byte_size === targetSize) {
                if (targetName.split('.').pop() === existingName.split('.').pop()) return true;
            }
        }
        return false;
    } catch (err) {
        console.warn(`⚠️ Erro ao verificar duplicata: ${err.message}`);
        return false;
    }
}

// ─── UPLOAD (Rails Active Storage) ───────────────────────────────────────────
export async function uploadFile(patientId, buffer, filename, mimeType) {
    // Sempre login fresh para CSRF válido
    invalidateSession();
    try {
        const { db } = await import('./db.js');
        await (await db()).collection('settings').deleteOne({ _id: 'codental_session' });
    } catch(_) {}
    const s = await getSession();
    console.log(`🔑 Login fresh | CSRF: ${s.csrf.slice(0,20)}... | cookies: ${s.cookie.split('; ').map(c=>c.split('=')[0]).join(', ')}`);

    const uploadCsrf = s.csrf;
    const checksum = md5b64(buffer);

    // 1. Registrar blob no Active Storage
    const directRes = await fetch(`${APP_BASE}/rails/active_storage/direct_uploads`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-CSRF-Token': uploadCsrf,
            'X-Requested-With': 'XMLHttpRequest',
            'Cookie': s.cookie,
            'Origin': APP_BASE,
            'Referer': `${APP_BASE}/patients/${patientId}/uploads`,
            'User-Agent': UA,
        },
        body: JSON.stringify({ blob: { filename, content_type: mimeType, byte_size: buffer.length, checksum } }),
    });

    if (!directRes.ok) {
        const err = await directRes.text();
        if (directRes.status === 422) { invalidateSession(); }
        throw new Error(`direct_uploads falhou (${directRes.status}): ${err.slice(0, 200)}`);
    }

    const blob = await directRes.json();
    const { signed_id, direct_upload } = blob;
    console.log(`🔑 signed_id: ${signed_id?.slice(0,30)}... | direct_upload url: ${direct_upload?.url ? 'sim' : 'não'}`);

    // 2. Upload para S3
    if (direct_upload?.url) {
        const s3 = await fetch(direct_upload.url, {
            method: 'PUT',
            headers: direct_upload.headers || {},
            body: buffer,
        });
        if (!s3.ok) throw new Error(`S3 upload falhou: ${s3.status}`);
        console.log('☁️ Arquivo enviado para S3');
    }

    // 3. Associar ao prontuário
    const uploadUrl = `${APP_BASE}/patients/${patientId}/uploads`;
    console.log(`📤 POST ${uploadUrl} | CSRF: ${uploadCsrf.slice(0,20)}...`);

    const uploadRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-CSRF-Token': uploadCsrf,
            'X-Requested-With': 'XMLHttpRequest',
            'Cookie': s.cookie,
            'Accept': 'text/vnd.turbo-stream.html, text/html, */*',
            'Origin': APP_BASE,
            'Referer': uploadUrl,
            'User-Agent': UA,
        },
        body: new URLSearchParams({
            'upload[name]': filename,
            'upload[file]': signed_id,
        }).toString(),
        redirect: 'follow',
    });

    const ct = uploadRes.headers.get('content-type') || '';
    console.log(`📤 Upload response: HTTP ${uploadRes.status}, CT: ${ct.slice(0,50)}`);

    if (![200, 201, 302].includes(uploadRes.status)) {
        const body = await uploadRes.text().catch(()=>'');
        console.error(`❌ Upload falhou: HTTP ${uploadRes.status}`, body.slice(0, 200));
        if (uploadRes.status === 401) { invalidateSession(); }
        throw new Error(`Criação do upload falhou: HTTP ${uploadRes.status}`);
    }

    const respBody = await uploadRes.text().catch(()=>'');
    const idMatch = respBody.match(/upload_(\d+)/) || respBody.match(/"id":(\d+)/);
    console.log(`✅ Upload concluído — paciente ${patientId}, arquivo: ${filename}`);
    return { signedId: signed_id, uploadId: idMatch?.[1] || null };
}

// ─── DELETAR UPLOAD ──────────────────────────────────────────────────────────
// O Codental usa Rails + Turbo: delete é POST com _method=delete no body
// Endpoint confirmado: POST /patients/:patientId/uploads/:uploadId
// Headers: X-CSRF-Token, X-Turbo-Request-Id, Accept: text/vnd.turbo-stream.html
export async function deleteUpload(patientId, uploadId) {
    const s = await getSession();

    const url = `${APP_BASE}/patients/${patientId}/uploads/${uploadId}`;

    const body = new URLSearchParams({
        '_method': 'delete',
        'authenticity_token': s.csrf,
    }).toString();

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'Cookie': s.cookie,
            'X-CSRF-Token': s.csrf,
            'X-Requested-With': 'XMLHttpRequest',
            'X-Turbo-Request-Id': crypto.randomUUID(),
            'Accept': 'text/vnd.turbo-stream.html, text/html, application/xhtml+xml',
            'Origin': APP_BASE,
            'Referer': `${APP_BASE}/patients/${patientId}/uploads`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        },
        body,
    });

    if (res.ok || res.status === 302 || res.status === 204) {
        console.log(`🗑 Upload ${uploadId} deletado (paciente ${patientId})`);
        return { ok: true, uploadId, patientId };
    }

    const errText = await res.text().catch(() => '');
    throw new Error(`Delete falhou (${res.status}): ${errText.slice(0, 150)}`);
}

// ─── LISTAR UPLOADS COM METADADOS COMPLETOS ───────────────────────────────────
// Retorna id, name, byte_size, checksum para comparação de duplicatas
export async function listUploadsWithMeta(patientId) {
    const hdrs = await headers();
    // Tenta endpoint com mais metadados primeiro
    const urls = [
        `${APP_BASE}/patients/${patientId}/uploads.json`,
        `${APP_BASE}/api/v1/patients/${patientId}/uploads`,
    ];
    for (const url of urls) {
        try {
            const res = await fetch(url, { headers: hdrs });
            if (!res.ok) continue;
            const data = await res.json();
            const list = Array.isArray(data) ? data : (data.uploads || data.data || []);
            if (list.length >= 0) return list;
        } catch (_) {}
    }
    return [];
}

// ─── MD5 BASE64 ───────────────────────────────────────────────────────────────
function md5b64(buffer) {
    return crypto.createHash('md5').update(buffer).digest('base64');
}