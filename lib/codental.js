// lib/codental.js — Codental: autenticação via cookie _domain_session + uploads

import crypto from 'crypto';

const APP_BASE  = process.env.CODENTAL_BASE_URL || 'https://app.codental.com.br';
const LOGIN_URL = (process.env.CODENTAL_BASE_URL || 'https://app.codental.com.br') + '/login';

// ─── SESSION CACHE ────────────────────────────────────────────────────────────
// Sessão em memória (válida enquanto o container serverless estiver ativo)
let _memSession = null;
let _memSessionAt = 0;
const SESSION_TTL = 25 * 60 * 1000; // 25 min — sessão Rails dura ~30min

async function saveSessionToDb(session) {
    try {
        const { db } = await import('./db.js');
        const col = (await db()).collection('settings');
        await col.updateOne(
            { _id: 'codental_session' },
            { $set: { cookie: session.cookie, csrf: session.csrf, saved_at: new Date() } },
            { upsert: true }
        );
    } catch (e) { console.warn('⚠️ Não foi possível salvar sessão no DB:', e.message); }
}

async function loadSessionFromDb() {
    try {
        const { db } = await import('./db.js');
        const col = (await db()).collection('settings');
        const doc = await col.findOne({ _id: 'codental_session' });
        if (!doc?.cookie) return null;
        const age = Date.now() - new Date(doc.saved_at).getTime();
        if (age > SESSION_TTL) return null; // sessão expirada
        return { cookie: doc.cookie, csrf: doc.csrf };
    } catch (e) { return null; }
}

async function getSession() {
    // 1. Tenta memória (mesmo container)
    if (_memSession && Date.now() - _memSessionAt < SESSION_TTL) return _memSession;

    // 2. Tenta MongoDB (outro container ou reinício)
    const dbSession = await loadSessionFromDb();
    if (dbSession) {
        _memSession = dbSession;
        _memSessionAt = Date.now();
        console.log('🔑 Sessão Codental carregada do banco');
        return _memSession;
    }

    // 3. Novo login com retry e backoff
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
                // Backoff maior para erro 500 (servidor sobrecarregado)
                const is500 = err.message?.includes('500') || err.message?.includes('servidor');
                const wait = is500 ? attempt * 30000 : attempt * 15000; // 30s/60s para 500, 15s/30s para outros
                console.warn(`⚠️ Login Codental falhou (tentativa ${attempt}/3), aguardando ${wait/1000}s... [${err.message?.slice(0,60)}]`);
                await new Promise(r => setTimeout(r, wait));
            }
        }
    }
    throw lastErr;
}

export function invalidateSession() {
    _memSession = null;
    _memSessionAt = 0;
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
    // Coleta todos os cookies da página de login
    let allInitCookies = '';
    if (typeof loginPageRes.headers.getSetCookie === 'function') {
        allInitCookies = loginPageRes.headers.getSetCookie().join('; ');
    } else {
        allInitCookies = rawCookie;
    }
    const initCookie = (allInitCookies.match(/_domain_session=[^;,]+/) || [])[0]
        || (allInitCookies.match(/_session=[^;,]+/) || [])[0]
        || allInitCookies.split(';')[0]
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

    // O cookie _domain_session pode vir em múltiplos Set-Cookie headers
    // Node.js fetch só retorna o primeiro com .get() — usa getSetCookie() se disponível
    let allCookies = '';
    if (typeof loginRes.headers.getSetCookie === 'function') {
        allCookies = loginRes.headers.getSetCookie().join('; ');
    } else {
        allCookies = loginRes.headers.get('set-cookie') || '';
    }
    console.log('🍪 Set-Cookie recebido:', allCookies.slice(0, 200));
    console.log('📊 Status login:', loginRes.status, loginRes.headers.get('location'));

    const domainSession = (allCookies.match(/_domain_session=[^;,]+/) || [])[0]
        || (allCookies.match(/remember_professional_token=[^;,]+/) || [])[0]
        || (allCookies.match(/_session=[^;,]+/) || [])[0];

    if (!domainSession) {
        console.error('❌ Cookies disponíveis:', allCookies.slice(0, 500));
        console.error('❌ Status HTTP:', loginRes.status);
        console.error('❌ Location:', loginRes.headers.get('location'));
        if (loginRes.status === 500) {
            throw new Error(`Codental retornou HTTP 500 — servidor deles com erro interno. Tente novamente mais tarde.`);
        }
        if (loginRes.status === 200) {
            throw new Error(`Login Codental falhou — credenciais incorretas ou conta bloqueada. Verifique CODENTAL_EMAIL e CODENTAL_PASSWORD.`);
        }
        throw new Error(
            `Login Codental falhou (HTTP ${loginRes.status}) — _domain_session não retornado.`
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
    if (list.length > 0) {
        const sample = list[0];
        console.log(`🔍 "${name}": ${list.length} resultado(s) | campos: ${Object.keys(sample).slice(0,8).join(",")} | amostra: ${JSON.stringify(sample).slice(0,150)}`);
    } else {
        console.log(`🔍 "${name}": 0 resultado(s)`);
    }
    // Normaliza fullName → name para compatibilidade com o restante do sistema
    list.forEach(p => { if (!p.name && p.fullName) p.name = p.fullName; });
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
    const list = Array.isArray(data) ? data : (data.uploads || data.data || []);
    if (list.length > 0) {
        console.log(`  📋 listUploads paciente ${patientId}: ${list.length} upload(s), campos: ${Object.keys(list[0]).join(',')}`);
        console.log(`  📋 Amostra: ${JSON.stringify(list[0]).slice(0, 200)}`);
    } else {
        console.log(`  📋 listUploads paciente ${patientId}: vazio`);
    }
    return list;
}

// ─── VERIFICAR DUPLICATA ──────────────────────────────────────────────────────
// Estratégia em camadas:
// 1. Hash MD5 do conteúdo (mais confiável — detecta mesmo nome diferente)
// 2. Nome do arquivo (fallback rápido)
// 3. Tamanho em bytes (fallback adicional)

export async function isDuplicate(patientId, filename, buffer = null) {
    try {
        const uploads = await listUploads(patientId);
        if (!uploads.length) return false;

        const targetName = filename.toLowerCase();
        const targetSize = buffer ? buffer.length : null;
        const targetHash = buffer ? md5b64(buffer) : null;

        for (const u of uploads) {
            const existingName = (u.name || u.filename || u.file_name || '').toLowerCase();

            // 1. Nome idêntico → duplicata
            if (existingName === targetName) {
                console.log(`  ≡ Duplicata por nome: ${filename}`);
                return true;
            }

            // 2. Hash MD5 do conteúdo (se o upload armazenou checksum)
            if (targetHash && u.checksum && u.checksum === targetHash) {
                console.log(`  ≡ Duplicata por hash MD5: ${filename} == ${existingName}`);
                return true;
            }

            // 3. Mesmo tamanho + extensão igual → provável duplicata
            // (arquivos de raio-x do mesmo equipamento têm tamanho muito consistente)
            if (targetSize && u.byte_size && u.byte_size === targetSize) {
                const extTarget = targetName.split('.').pop();
                const extExist  = existingName.split('.').pop();
                if (extTarget === extExist) {
                    console.log(`  ≡ Duplicata por tamanho+extensão: ${filename} (${targetSize}B) == ${existingName}`);
                    return true;
                }
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
    console.log(`🔑 signed_id: ${signed_id?.slice(0,30)}... | direct_upload url: ${direct_upload?.url ? 'sim' : 'não'}`);

    // 2. Upload para S3/storage
    if (direct_upload?.url) {
        const s3 = await fetch(direct_upload.url, {
            method: 'PUT',
            headers: direct_upload.headers || {},
            body: buffer,
        });
        if (!s3.ok) throw new Error(`S3 upload falhou: ${s3.status}`);
        console.log('☁️ Arquivo enviado para S3');
    } else {
        console.log('ℹ️ Sem URL de direct_upload — usando signed_id direto');
    }

    // 3. Criar registro no prontuário do paciente
    const form = new FormData();
    form.append('upload[name]', filename);
    form.append('upload[notes]', 'Importado automaticamente via monitor de email');
    form.append('upload[file]', signed_id);

    const uploadRes = await fetch(`${APP_BASE}/patients/${patientId}/uploads`, {
        method: 'POST',
        headers: {
            ...baseHdrs,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Referer': `${APP_BASE}/patients/${patientId}`,
            'Origin': APP_BASE,
        },
        body: form,
        redirect: 'manual',
    });

    console.log(`📤 Upload response: HTTP ${uploadRes.status}, Location: ${uploadRes.headers.get('location')||'none'}`);

    // Sucesso = 302 redirect para o prontuário ou 200/201
    if (uploadRes.status !== 302 && uploadRes.status !== 200 && uploadRes.status !== 201) {
        const body = await uploadRes.text().catch(()=>'');
        console.error(`❌ Upload falhou: HTTP ${uploadRes.status}`, body.slice(0,300));
        throw new Error(`Criação do upload falhou: HTTP ${uploadRes.status}`);
    }

    const location = uploadRes.headers.get('location') || '';
    const idMatch = location.match(/uploads\/(\d+)/);
    console.log(`✅ Upload concluído — paciente ${patientId}, arquivo: ${filename}, uploadId: ${idMatch?.[1]||'?'}`);
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
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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