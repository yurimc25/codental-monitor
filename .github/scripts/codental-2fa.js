// .github/scripts/codental-2fa.js
// Verificação em duas etapas do Codental (out/2026): depois da senha ele pede o celular e manda um código por SMS.
// O SMS não chega ao runner, então o código é pedido por WhatsApp (Evolution API, a mesma instância do CRM)
// ao próprio número e a resposta é lida da conversa.

const PHONE = (process.env.CODENTAL_2FA_PHONE || '6199611055').replace(/\D/g, '');
const EVO_URL = (process.env.EVOLUTION_URL || '').replace(/\/+$/, '');
const EVO_KEY = process.env.EVOLUTION_KEY || '';
const EVO_INSTANCE = encodeURIComponent(process.env.EVOLUTION_INSTANCE || '');
const WAIT_MS = 8 * 60 * 1000;

const PHONE_SEL = 'input[type="tel"], input[name*="phone" i], input[name*="cellphone" i], input[name*="celular" i]';
const CODE_SEL = 'input[autocomplete="one-time-code"], input[name*="code" i], input[name*="token" i]:not([type="hidden"]), input[name*="otp" i], input[name*="codigo" i]';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function evo(method, path, body) {
    if (!EVO_URL || !EVO_KEY || !EVO_INSTANCE) throw new Error('Evolution API não configurada (EVOLUTION_URL, EVOLUTION_KEY, EVOLUTION_INSTANCE)');
    const r = await fetch(EVO_URL + path, {
        method,
        headers: { apikey: EVO_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`Evolution API HTTP ${r.status}: ${JSON.stringify(j?.response || j?.message || j).slice(0, 200)}`);
    return j;
}

const visible = async (page, sel) => {
    const l = page.locator(sel).first();
    return (await l.count()) > 0 && await l.isVisible().catch(() => false);
};

/** Envia o formulário do campo e espera a página reagir (navegação comum ou Turbo). */
async function submitFrom(page, sel) {
    await Promise.all([
        page.waitForLoadState('domcontentloaded').catch(() => {}),
        page.locator(sel).first().evaluate(el => el.form ? el.form.requestSubmit() : el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))),
    ]);
    await page.waitForTimeout(2500);
}

/** Pede o código no WhatsApp e espera a resposta (só dígitos, 4 a 8). */
async function askCodeOnWhatsApp(label) {
    const chk = await evo('POST', `/chat/whatsappNumbers/${EVO_INSTANCE}`, { numbers: ['55' + PHONE] });
    const jid = chk?.[0]?.jid || `55${PHONE}@s.whatsapp.net`;
    const since = Math.floor(Date.now() / 1000) - 5;
    // Sem dígitos no texto: a resposta é achada procurando um número de 4 a 8 dígitos
    const sent = await evo('POST', `/message/sendText/${EVO_INSTANCE}`, {
        number: jid.split('@')[0],
        text: `🔐 Codental (conta ${label}): chegou um código por SMS para renovar o login automático. Responda esta mensagem só com o código.`,
    });
    const sentId = sent?.key?.id;
    console.log(`📲 [${label}] código pedido no WhatsApp, aguardando resposta...`);

    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
        await sleep(5000);
        const r = await evo('POST', `/chat/findMessages/${EVO_INSTANCE}`, { where: { key: { remoteJid: jid } }, limit: 20 }).catch(e => {
            console.warn(`⚠️ [${label}] findMessages: ${e.message}`);
            return null;
        });
        const list = Array.isArray(r) ? r : (r?.messages?.records || r?.records || []);
        for (const m of list) {
            if (m.key?.id === sentId || Number(m.messageTimestamp) < since) continue;
            const text = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
            const hit = text.match(/\b(\d{4,8})\b/);
            if (hit) return { code: hit[1], jid };
        }
    }
    throw new Error(`Ninguém respondeu o código no WhatsApp em ${WAIT_MS / 60000} min`);
}

/**
 * Se a página pede o celular e/ou o código da verificação em duas etapas, resolve.
 * @returns {Promise<boolean>} true se havia verificação
 */
export async function handleTwoFactor(page, label) {
    // Página logada tem <meta current-professional>: nada a fazer
    if (await page.locator('meta[name="current-professional"]').count()) return false;
    let handled = false;

    if (await visible(page, PHONE_SEL) && !(await visible(page, CODE_SEL))) {
        console.log(`📱 [${label}] Codental pediu o celular, preenchendo ${PHONE}`);
        await page.locator(PHONE_SEL).first().fill(PHONE);
        await submitFrom(page, PHONE_SEL);
        handled = true;
    }

    const boxes = page.locator('input[maxlength="1"]:visible');
    const split = (await boxes.count()) >= 4; // código em caixinhas de 1 dígito
    if (!split && !(await visible(page, CODE_SEL))) return handled;

    const { code, jid } = await askCodeOnWhatsApp(label);
    console.log(`🔑 [${label}] código recebido, enviando ao Codental`);
    if (split) {
        await boxes.first().click();
        await page.keyboard.type(code, { delay: 80 });
        await page.waitForTimeout(800);
        if (await page.locator('input[maxlength="1"]:visible').count()) await submitFrom(page, 'input[maxlength="1"]');
    } else {
        await page.locator(CODE_SEL).first().fill(code);
        await submitFrom(page, CODE_SEL);
    }

    const ok = !!(await page.locator('meta[name="current-professional"]').count()) || page.url().includes('/establishments');
    await evo('POST', `/message/sendText/${EVO_INSTANCE}`, {
        number: jid.split('@')[0],
        text: ok ? `✅ Codental (conta ${label}) logado.` : `❌ Codental (conta ${label}) recusou o código.`,
    }).catch(() => {});
    if (!ok) throw new Error('Codental não aceitou o código da verificação em duas etapas');
    return true;
}
