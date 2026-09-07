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
const SESSION_TTL = 40 * 60 * 1000; // 40 min (GitHub Actions renova a cada 30min)

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
        if (!doc?.cookie || !doc?.csrf) return null;
        // GitHub Actions renova a sessão — não rejeitamos por idade
        // só logamos se estiver velha demais
        const age = Date.now() - new Date(doc.saved_at).getTime();
        const ageMin = Math.round(age / 60000);
        if (ageMin > 35) console.warn(`⚠️ Sessão do banco tem ${ageMin}min — GitHub Actions pode não estar rodando`);
        return { cookie: doc.cookie, csrf: doc.csrf };
    } catch (e) { return null; }
}

export function invalidateSession() {
    _memSession = null;
    _memSessionAt = 0;
}

async function getSession() {
    // 1. Banco sempre primeiro — GitHub Actions renova a cada 30min
    const dbSession = await loadSessionFromDb();
    if (dbSession) {
        // Usa cache de memória só se CSRF for idêntico (sessão não foi renovada)
        if (_memSession?.csrf === dbSession.csrf) return _memSession;
        _memSession = dbSession;
        _memSessionAt = Date.now();
        console.log('🔑 Sessão Codental carregada do banco');
        return _memSession;
    }
    // 2. Sem sessão no banco — faz login próprio como fallback
    console.warn('⚠️ Sem sessão no banco — GitHub Actions não rodou ainda?');
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            _memSession = await authenticate();
            _memSessionAt = Date.now();
            // Não salva no banco — sessão é gerenciada pelo GitHub Actions
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
async function authenticate(email = process.env.CODENTAL_EMAIL, password = process.env.CODENTAL_PASSWORD, establishmentId = '13226') {
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
            'professional[email]': email,
            'professional[password]': password,
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

    cookies = mergeCookies(cookies, loginCookies, 'logged_in=1');

    // Se a conta tem mais de uma clínica, o login redireciona para /establishments
    // e é preciso selecionar explicitamente uma — só forjar o cookie
    // selected_establishment não funciona, o Rails guarda a seleção real
    // dentro do _domain_session (criptografado), trocado por
    // POST /establishments/:id/select (descoberto via DevTools em produção).
    if (loginLocation.includes('/establishments') && establishmentId) {
        console.log(`🏥 Login caiu em /establishments — selecionando clínica ${establishmentId}...`);
        cookies = await selectEstablishment(cookies, csrf, establishmentId);
    }

    console.log('🔑 Usando CSRF do login para sessão (GET bloqueado pelo WAF para páginas HTML)');
    const activeCsrf = csrf;

    const cookieKeys = cookies.split('; ').map(c => c.split('=')[0]);
    console.log('🍪 Cookies presentes:', cookieKeys.join(', '));
    console.log('✅ Autenticado no Codental');
    return { cookie: cookies, csrf: activeCsrf };
}

// ─── SELECIONAR CLÍNICA (multi-establishment) ────────────────────────────────
// POST /establishments/:id/select troca o _domain_session real (não basta
// forjar o cookie selected_establishment) — descoberto via captura de rede
// numa seleção manual real. Body é multipart/form-data só com authenticity_token.
async function selectEstablishment(cookies, csrf, establishmentId) {
    const boundary = '----RaiosXBoundary' + crypto.randomBytes(12).toString('hex');
    const body =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="authenticity_token"\r\n\r\n${csrf}\r\n` +
        `--${boundary}--\r\n`;

    const url = `${LOGIN_BASE}/establishments/${establishmentId}/select`;
    const res = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Cookie': cookies,
            'User-Agent': UA,
            'Accept': 'text/html',
            'Origin': LOGIN_BASE,
            'Referer': `${LOGIN_BASE}/establishments`,
        },
        body,
    });

    let selectCookies = '';
    if (typeof res.headers.getSetCookie === 'function') {
        selectCookies = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    } else {
        selectCookies = (res.headers.get('set-cookie') || '').split(';')[0];
    }

    console.log('📊 Status seleção de clínica:', res.status, '| cookies novos:', selectCookies.split('; ').map(c => c.split('=')[0]).join(', '));

    if (![200, 302, 303].includes(res.status)) {
        const text = await res.text().catch(() => '');
        throw new Error(`Seleção de clínica ${establishmentId} falhou: HTTP ${res.status} ${text.slice(0, 150)}`);
    }
    if (!selectCookies) {
        throw new Error(`Seleção de clínica ${establishmentId} não retornou cookies novos — provável ID inválido ou sem permissão.`);
    }

    return mergeCookies(cookies, selectCookies);
}

// ─── LOGIN AVULSO COM CREDENCIAIS ESPECÍFICAS (não usa/altera a sessão do banco) ──
// Usado para consultar uma conta Codental diferente da conta principal
// (ex.: conta antiga de outra clínica), sem mexer na sessão gerenciada pelo
// GitHub Actions. Nunca é salvo no banco nem no cache de memória.
export async function authenticateWithCredentials(email, password, establishmentId = null) {
    if (!email || !password) throw new Error('Credenciais não informadas para login avulso no Codental');
    return authenticate(email, password, establishmentId);
}

// ─── HEADERS BASE ─────────────────────────────────────────────────────────────
// sessionOverride permite usar uma sessão avulsa (ex.: outra conta Codental)
// em vez da sessão principal salva no banco pelo GitHub Actions.
async function headers(extra = {}, sessionOverride = null) {
    const s = sessionOverride || await loadSessionFromDb() || await getSession();
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
export async function searchPatients(name, session = null, { strict = false } = {}) {
    const hdrs = await headers({}, session);
    const url = `${APP_BASE}/patients/search.json?query=${encodeURIComponent(name)}`;
    const res = await fetch(url, { headers: hdrs });
    if (!res.ok) {
        console.warn(`⚠️ searchPatients ${res.status} para "${name}"`);
        // 422 aqui costuma indicar que a sessão não tem uma clínica selecionada
        // (cookie selected_establishment ausente/errado) — não é "sem resultados".
        if (strict) {
            const err = new Error(`searchPatients falhou com HTTP ${res.status}` +
                (res.status === 422 ? ' — provável falta do cookie selected_establishment (clínica não selecionada)' : ''));
            err.status = res.status;
            throw err;
        }
        return [];
    }
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.patients || data.data || []);
    list.forEach(p => { if (!p.name && p.fullName) p.name = p.fullName; });
    return list;
}

// ─── LISTAR UPLOADS DO PACIENTE ───────────────────────────────────────────────
export async function listUploads(patientId, session = null) {
    const hdrs = await headers({}, session);
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
    // Busca sessão direto do banco a cada upload — GitHub Actions renova a cada 30min
    // Nunca usa cache de memória para garantir CSRF sempre fresco
    const s = await loadSessionFromDb();
    if (!s) throw new Error('Sem sessão no banco — rode o refresh-session.js primeiro');
    console.log(`🔑 Sessão do banco | CSRF: ${s.csrf.slice(0,20)}... | cookies: ${s.cookie.split('; ').map(c=>c.split('=')[0]).join(', ')}`);

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
    const s = await loadSessionFromDb() || await getSession();

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
export async function listUploadsWithMeta(patientId, session = null) {
    const hdrs = await headers({}, session);
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

// ─── BAIXAR BINÁRIO DE UM UPLOAD JÁ EXISTENTE (cadastro duplicado do paciente) ──
// A forma exata do JSON de uploads.json não é documentada; tenta os campos de
// URL mais prováveis em ordem. Lança erro descritivo (com o item bruto) se
// nenhum candidato funcionar, para facilitar ajuste rápido depois de um teste real.
export async function downloadUploadBinary(uploadItem, session = null) {
    const s = session || await loadSessionFromDb() || await getSession();
    const candidates = [
        uploadItem.url,
        uploadItem.file_url,
        uploadItem.download_url,
        uploadItem.blob_url,
        uploadItem.file?.url,
        uploadItem.blob?.url,
        uploadItem.attachment?.url,
        uploadItem.direct_upload?.url,
    ].filter(Boolean);

    for (const rawUrl of candidates) {
        try {
            const url = rawUrl.startsWith('http') ? rawUrl : `${APP_BASE}${rawUrl}`;
            const res = await fetch(url, {
                headers: { 'Cookie': s.cookie, 'User-Agent': UA },
                redirect: 'follow',
            });
            if (!res.ok) continue;
            const buffer = Buffer.from(await res.arrayBuffer());
            if (buffer.length > 0) return buffer;
        } catch (_) { /* tenta o próximo candidato */ }
    }

    throw new Error(`Não foi possível baixar o arquivo — nenhuma URL reconhecida no item: ${JSON.stringify(uploadItem).slice(0, 300)}`);
}

// ─── MD5 BASE64 ───────────────────────────────────────────────────────────────
function md5b64(buffer) {
    return crypto.createHash('md5').update(buffer).digest('base64');
}