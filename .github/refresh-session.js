// .github/scripts/refresh-session.js
// Roda no GitHub Actions — faz login real no Codental com Playwright
// e salva a sessão (cookie + CSRF) no MongoDB para o Vercel usar

import { chromium } from 'playwright';
import { MongoClient } from 'mongodb';

const EMAIL    = process.env.CODENTAL_EMAIL;
const PASSWORD = process.env.CODENTAL_PASSWORD;
const MONGO    = process.env.MONGODB_URI;

if (!EMAIL || !PASSWORD || !MONGO) {
    console.error('❌ Variáveis de ambiente faltando: CODENTAL_EMAIL, CODENTAL_PASSWORD, MONGODB_URI');
    process.exit(1);
}

let browser;
const client = new MongoClient(MONGO);

try {
    console.log('🌐 Iniciando browser...');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        locale: 'pt-BR',
    });
    const page = await context.newPage();

    // 1. Abre página de login
    console.log('🔐 Abrindo login...');
    await page.goto('https://app.codental.com.br/login', { waitUntil: 'domcontentloaded' });

    // 2. Preenche credenciais
    await page.fill('input[name="professional[email]"]', EMAIL);
    await page.fill('input[name="professional[password]"]', PASSWORD);

    // 3. Submete e aguarda navegação
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
        page.click('input[type="submit"], button[type="submit"]'),
    ]);

    console.log('📍 URL após login:', page.url());

    // 4. Garante que está numa página autenticada
    if (page.url().includes('/login')) {
        throw new Error('Login falhou — ainda na página de login');
    }

    // 5. Captura CSRF do meta tag
    const csrf = await page.evaluate(() => {
        return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
    });

    if (!csrf) throw new Error('CSRF não encontrado no HTML após login');
    console.log('🔑 CSRF capturado:', csrf.slice(0, 20) + '...');

    // 6. Captura todos os cookies
    const cookies = await context.cookies();
    const essential = ['_domain_session', 'remember_professional_token', 'logged_in', 'selected_establishment'];
    const cookieStr = cookies
        .filter(c => essential.some(name => c.name === name) || c.domain.includes('codental'))
        .map(c => `${c.name}=${c.value}`)
        .join('; ');

    console.log('🍪 Cookies capturados:', cookies.map(c => c.name).filter(n => essential.includes(n)).join(', '));

    // 7. Salva no MongoDB
    await client.connect();
    const col = client.db().collection('settings');
    await col.updateOne(
        { _id: 'codental_session' },
        { $set: { cookie: cookieStr, csrf, saved_at: new Date() } },
        { upsert: true }
    );

    console.log('💾 Sessão salva no MongoDB com sucesso!');
    console.log(`✅ Próxima renovação em ~30 minutos`);

} catch (err) {
    console.error('❌ Erro:', err.message);
    process.exit(1);
} finally {
    await browser?.close();
    await client.close();
}
