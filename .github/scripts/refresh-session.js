// .github/scripts/refresh-session.js
// Roda no GitHub Actions — faz login real no Codental com Playwright
// e salva a sessão (cookie + CSRF) no MongoDB para o Vercel usar.
// Duas contas: a principal (obrigatória) e a antiga (CODENTAL_OLD_*, opcional — falha dela não derruba o job).

import { chromium } from 'playwright';
import { MongoClient } from 'mongodb';
import os from 'os';

const MONGO = process.env.MONGODB_URI;
const ACCOUNTS = [
    { id: 'codental_session', label: 'principal', required: true,
      email: process.env.CODENTAL_EMAIL, password: process.env.CODENTAL_PASSWORD, establishment: null },
    { id: 'codental_old_session', label: 'antiga', required: false,
      email: process.env.CODENTAL_OLD_EMAIL, password: process.env.CODENTAL_OLD_PASSWORD,
      establishment: process.env.CODENTAL_OLD_ESTABLISHMENT_ID || null },
];

if (!ACCOUNTS[0].email || !ACCOUNTS[0].password || !MONGO) {
    console.error('❌ Variáveis de ambiente faltando: CODENTAL_EMAIL, CODENTAL_PASSWORD, MONGODB_URI');
    process.exit(1);
}

// Garante que conecta no banco correto mesmo se a URI não especificar
const mongoUri = MONGO.includes('/codental_monitor') ? MONGO : MONGO.replace('/?', '/codental_monitor?');
const client = new MongoClient(mongoUri);
const essential = ['_domain_session', 'remember_professional_token', 'logged_in', 'selected_establishment'];

// Turnstile (Codental, out/2026) só libera o token para navegador com janela e sem a marca de automação:
// headless=false (no Actions roda sob xvfb-run), AutomationControlled desligado e o User-Agent real do
// Chromium (um UA de Windows rodando em Linux é sinal de bot, por isso não é mais forçado).

const hasToken = page => page.evaluate(() => !!document.querySelector('input[name="cf-turnstile-response"]')?.value);

/** Espera o Turnstile liberar o token. Quando a Cloudflare reprova o navegador ela mostra o erro 600010 (sem checkbox),
 *  então não há clique que resolva: guarda uma captura para o artefato do workflow e falha. */
async function solveTurnstile(page, label) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
        if (await hasToken(page)) return;
        await page.waitForTimeout(500);
    }
    await page.screenshot({ path: `turnstile-falhou-${label}.png`, fullPage: true }).catch(() => {});
    throw new Error('Turnstile não liberou o login (a Cloudflare reprovou o navegador, erro 600010). Renove a sessão por um navegador real.');
}

async function loginAccount(browser, acc) {
    const context = await browser.newContext({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', viewport: { width: 1366, height: 768 } });
    try {
        const page = await context.newPage();
        console.log(`🔐 [${acc.label}] Abrindo login...`);
        await page.goto('https://app.codental.com.br/login', { waitUntil: 'domcontentloaded' });
        await page.fill('input[name="professional[email]"]', acc.email);
        await page.fill('input[name="professional[password]"]', acc.password);

        if (await page.locator('[data-turnstile-form], input[name="cf-turnstile-response"]').count()) {
            await solveTurnstile(page, acc.label);
        }

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }),
            page.click('input[type="submit"], button[type="submit"]'),
        ]);
        console.log(`📍 [${acc.label}] URL após login:`, page.url());
        if (page.url().includes('/login')) throw new Error('Login falhou — ainda na página de login (senha recusada?)');

        // Conta com mais de uma clínica: o login cai em /establishments e é preciso escolher (POST /establishments/:id/select)
        if (page.url().includes('/establishments')) {
            const sel = acc.establishment
                ? `form[action$="/establishments/${acc.establishment}/select"]`
                : 'form[action$="/select"]';
            if (!(await page.locator(sel).count())) throw new Error(`Clínica ${acc.establishment || '(primeira)'} não encontrada na seleção de clínicas`);
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }),
                page.locator(sel).first().evaluate(f => f.requestSubmit()),
            ]);
            console.log(`🏥 [${acc.label}] Clínica selecionada:`, page.url());
        }

        const csrf = await page.evaluate(() => document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '');
        if (!csrf) throw new Error('CSRF não encontrado no HTML após login');

        const cookies = await context.cookies();
        const cookie = cookies
            .filter(c => essential.some(name => c.name === name) || c.domain.includes('codental'))
            .map(c => `${c.name}=${c.value}`)
            .join('; ');
        console.log(`🍪 [${acc.label}] Cookies:`, cookies.map(c => c.name).filter(n => essential.includes(n)).join(', '));
        return { cookie, csrf };
    } finally {
        await context.close();
    }
}

// Entrega a sessão da conta principal ao Sistema de Gestão pela MESMA API que a extensão do Chrome usa
// (POST /api/v1/session, autenticado por X-Gestao-Token). Só roda se GESTAO_URL e GESTAO_TOKEN existirem;
// falha aqui não derruba o job (o Mongo já foi gravado e a extensão continua como reserva).
async function pushToGestao(s) {
    const url = (process.env.GESTAO_URL || '').replace(/\/+$/, ''), token = process.env.GESTAO_TOKEN || '';
    if (!url || !token) return;
    try {
        const r = await fetch(`${url}/api/v1/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Gestao-Token': token },
            body: JSON.stringify({ provider: 'codental', data: { cookie: s.cookie, csrf: s.csrf }, meta: `refresh-session ${os.hostname()}` }),
        });
        console.log(r.ok ? '🔁 [principal] sessão enviada ao gestão' : `⚠️ gestão recusou a sessão (HTTP ${r.status})`);
    } catch (e) {
        console.warn('⚠️ não consegui enviar a sessão ao gestão:', e.message);
    }
}

let browser;
let failed = false;
try {
    console.log('🌐 Iniciando browser...');
    browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
    await client.connect();
    const col = client.db('codental_monitor').collection('settings');

    for (const acc of ACCOUNTS) {
        if (!acc.email || !acc.password) { console.log(`⏭️  [${acc.label}] sem credenciais, pulando`); continue; }
        try {
            const s = await loginAccount(browser, acc);
            if (!/_domain_session=/.test(s.cookie)) throw new Error('cookie sem _domain_session (login não concluiu)');
            const now = new Date(), account = acc.id === 'codental_old_session' ? 'old' : 'main';
            const src = process.env.GITHUB_ACTIONS ? 'actions' : `local-${os.hostname()}`.replace(/[^\w.-]/g, '');
            const pool = client.db('codental_monitor').collection('codental_sessions');
            await pool.updateOne({ _id: `${account}:${src}` }, { $set: { account, src, cookie: s.cookie, csrf: s.csrf, saved_at: now, last_ok_at: now } }, { upsert: true });
            await col.updateOne({ _id: acc.id }, { $set: { cookie: s.cookie, csrf: s.csrf, saved_at: now } }, { upsert: true }); // CRM WhatsApp lê este
            console.log(`💾 [${acc.label}] sessão salva no pool (${src})`);
            if (account === 'main') await pushToGestao(s); // mesma porta da extensão: POST /api/v1/session
        } catch (err) {
            console.error(`❌ [${acc.label}] ${err.message}`);
            if (acc.required) failed = true;
        }
    }
} catch (err) {
    console.error('❌ Erro:', err.message);
    failed = true;
} finally {
    await browser?.close();
    await client.close();
}
process.exit(failed ? 1 : 0);
