// lib/codental.js — Codental: autenticação via cookie _domain_session + uploads

import crypto from 'crypto';

// Login sempre em app.codental.com.br (novo domínio unificado)
const LOGIN_BASE = 'https://app.codental.com.br';
const LOGIN_URL  = LOGIN_BASE + '/login';
// Dados dos pacientes ficam no subdomínio da clínica (multi-tenant)
// CODENTAL_BASE_URL deve ser https://odonto-on-face.codental.com.br
const APP_BASE   = process.env.CODENTAL_BASE_URL || 'https://odonto-on-face.codental.com.br';

// ─── SESSION CACHE ────────────────────────────────────────────────────────────
// Merge de cookies por chave — último valor vence, sem duplicatas
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

// Sessão em memória (válida enquanto o container serverless estiver ativo)
let _memSession = null;
let _memSessionAt = 0;
const SESSION_TTL = 60 * 60 * 1000; // 1 hora

async function saveSessionToDb(session) {
    try {
        const { db } = await import('./db.js');
        const col = (await db()).collection('settings');
        // Limita tamanho do cookie para evitar erros no MongoDB (max 16MB por doc)
        const cookieToSave = session.cookie || '';
        await col.updateOne(
            { _id: 'codental_session' },
            { $set: { cookie: cookieToSave, csrf: session.csrf, saved_at: new Date() } },
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
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Upgrade-Insecure-Requests': '1',
        },
        redirect: 'follow',
    });

    const loginHtml = await loginPageRes.text();
    const rawCookie = loginPageRes.headers.get('set-cookie') || '';

    // CSRF está no input hidden do form (não no meta tag)
    // <input type="hidden" name="authenticity_token" value="..." autocomplete="off" />
    const csrfMatch = loginHtml.match(/name="authenticity_token"[^>]+value="([^"]+)"/i)
        || loginHtml.match(/value="([^"]+)"[^>]+name="authenticity_token"/i)
        || loginHtml.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)/i)
        || loginHtml.match(/content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i);

    console.log('🔍 Login page status:', loginPageRes.status);
    console.log('🔍 CSRF:', csrfMatch ? csrfMatch[1].slice(0,30)+'...' : 'NÃO ENCONTRADO');

    if (!csrfMatch) {
        console.error('🔍 HTML primeiros 1000 chars:', loginHtml.slice(0, 1000));
        throw new Error('CSRF token não encontrado na página de login do Codental');
    }
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
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
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
    let allCookies = '';
    if (typeof loginRes.headers.getSetCookie === 'function') {
        allCookies = loginRes.headers.getSetCookie().join('; ');
    } else {
        allCookies = loginRes.headers.get('set-cookie') || '';
    }
    const loginLocation = loginRes.headers.get('location') || '';
    console.log('🍪 Set-Cookie recebido:', allCookies.slice(0, 200));
    console.log('📊 Status login:', loginRes.status, loginLocation);
    // Login bem-sucedido redireciona para /patients ou /dashboard (não para /login)
    // Se redireciona para /login novamente, credenciais erradas ou CSRF inválido
    if (loginRes.status === 302 && loginLocation.includes('/login')) {
        console.warn('⚠️ Redirect voltou para /login — possível CSRF inválido ou credenciais erradas');
    }

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

    // 3. Busca CSRF do app acessando diretamente a página de uploads
    // Não seguimos redirects do login — usamos o cookie diretamente
    // O _domain_session retornado já é suficiente para autenticar

    // Acumula todos os cookies do login response
    let allLoginCookies = '';
    if (typeof loginRes.headers.getSetCookie === 'function') {
        allLoginCookies = loginRes.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    } else {
        allLoginCookies = (loginRes.headers.get('set-cookie') || '').split(',').map(c => c.split(';')[0].trim()).join('; ');
    }
    const initDomainSession = (allInitCookies.match(/_domain_session=[^;,]+/) || [])[0] || '';
    let appCookie = mergeCookies(initDomainSession, allLoginCookies);

    // Acessa /patients no subdomínio da clínica para pegar CSRF válido
    const appPageUrl = `${APP_BASE}/patients`;
    console.log('🔑 Buscando CSRF do app em:', appPageUrl);
    const appPageRes = await fetch(appPageUrl, {
        headers: {
            'Cookie': appCookie,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'pt-BR,pt;q=0.9',
        },
        redirect: 'follow', // deixa o fetch seguir automaticamente
    });

    // Acumula cookies da resposta do app
    if (typeof appPageRes.headers.getSetCookie === 'function') {
        const newCookies = appPageRes.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
        appCookie = mergeCookies(appCookie, newCookies);
    }

    const appHtml = await appPageRes.text();
    console.log('🏠 App response:', appPageRes.status, appPageRes.url || appPageUrl);

    const appCsrfMatch = appHtml.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)/i)
        || appHtml.match(/content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i);
    const appCsrf = appCsrfMatch ? appCsrfMatch[1] : csrf;
    console.log('🔑 App CSRF:', appCsrf ? appCsrf.slice(0,20)+'...' : 'usando CSRF do login');

    // Salva TODOS os cookies — o subdomínio da clínica precisa de remember_professional_token
    // além de _domain_session para autenticar. Mantém todos os cookies acumulados.
    // Merge final — garante cookies de estado obrigatórios sem duplicatas
    const finalCookie = mergeCookies(appCookie, 'logged_in=1', 'selected_establishment=13226');
    const cookieKeys = finalCookie.split('; ').map(c => c.split('=')[0]);
    console.log('🍪 Cookies presentes:', cookieKeys.join(', '));
    console.log('✅ Autenticado no Codental');
    return { cookie: finalCookie, csrf: appCsrf };
}

// ─── HEADERS BASE ─────────────────────────────────────────────────────────────
async function headers(extra = {}) {
    const s = await getSession();
    return {
        'Cookie': s.cookie,
        'X-CSRF-Token': s.csrf,
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
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

    // CSRF expira rapidamente — busca um CSRF fresco da página de uploads do paciente
    // antes de cada upload para evitar 422 Unprocessable Entity
    let freshCsrf = s.csrf;
    try {
        const csrfPageRes = await fetch(`${APP_BASE}/patients/${patientId}/uploads`, {
            headers: {
                'Cookie': s.cookie,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
            },
            redirect: 'follow',
        });
        // Acumula novos cookies da resposta
        if (typeof csrfPageRes.headers.getSetCookie === 'function') {
            const newCookies = csrfPageRes.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
            if (newCookies) {
                s.cookie = mergeCookies(s.cookie, newCookies);
                await saveSessionToDb(s);
            }
        }
        const csrfHtml = await csrfPageRes.text();
        const csrfMatch = csrfHtml.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)/i)
            || csrfHtml.match(/content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i);
        if (csrfMatch) {
            freshCsrf = csrfMatch[1];
            // Salva CSRF atualizado na sessão
            s.csrf = freshCsrf;
            await saveSessionToDb(s);
            console.log('🔑 CSRF atualizado para upload');
        }
    } catch (e) {
        console.warn('⚠️ Não foi possível atualizar CSRF, usando salvo:', e.message);
    }

    const baseHdrs = {
        'Cookie': s.cookie,
        'X-CSRF-Token': freshCsrf,
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
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
    // Confirmado via DevTools: multipart/form-data com X-CSRF-Token header separado
    // Accept: text/vnd.turbo-stream.html (Turbo Rails)
    // Campos confirmados via DevTools: upload[name], upload[notes], upload[file]
    const form = new FormData();
    form.append('upload[name]', filename);
    form.append('upload[notes]', '');
    form.append('upload[file]', signed_id);

    const uploadUrl = `${APP_BASE}/patients/${patientId}/uploads`;
    // Extrai só o _domain_session para diagnóstico (não loga o valor completo)
    const cookieKeys = s.cookie.split('; ').map(c => c.split('=')[0]).filter(Boolean);
    console.log(`📤 POST ${uploadUrl} | CSRF: ${freshCsrf.slice(0,20)}... | cookies presentes: ${cookieKeys.join(', ')}`);

    const uploadRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
            'Cookie': s.cookie,
            'X-CSRF-Token': freshCsrf,
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'text/vnd.turbo-stream.html',
            'Referer': uploadUrl,
            'Origin': APP_BASE,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
        },
        body: form,
        redirect: 'follow',
    });

    const ct = uploadRes.headers.get('content-type') || '';
    console.log(`📤 Upload response: HTTP ${uploadRes.status}, CT: ${ct.slice(0,50)}`);

    // Sucesso = 200 turbo-stream ou 201/302
    if (![200, 201, 302].includes(uploadRes.status)) {
        const body = await uploadRes.text().catch(()=>'');
        console.error(`❌ Upload falhou: HTTP ${uploadRes.status}`, body.slice(0, 200));
        // 401 = sessão expirada → invalida para forçar novo login na próxima tentativa
        if (uploadRes.status === 401) {
            _memSession = null;
            _memSessionAt = 0;
            try {
                const { db } = await import('./db.js');
                await (await db()).collection('settings').deleteOne({ _id: 'codental_session' });
                console.log('🔑 Sessão invalidada no banco — próximo upload fará novo login');
            } catch(_) {}
        }
        throw new Error(`Criação do upload falhou: HTTP ${uploadRes.status}`);
    }

    const respBody = await uploadRes.text().catch(()=>'');
    const idMatch = respBody.match(/upload_(\d+)/) || respBody.match(/"id":(\d+)/) || uploadRes.headers.get('location')?.match(/uploads\/(\d+)/);
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