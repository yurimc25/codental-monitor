// api/gmail/callback.js — Recebe code, salva tokens, redireciona
import { exchangeCode } from '../../lib/gmail.js';
import { updateSettings } from '../../lib/db.js';

export default async function handler(req, res) {
    const { code, error } = req.query;
    if (error) return res.redirect(`/?error=${encodeURIComponent(error)}`);
    if (!code) return res.status(400).send('Parâmetro code ausente');

    try {
        const tokens = await exchangeCode(code);
        await updateSettings({
            gmail_access_token: tokens.access_token,
            gmail_refresh_token: tokens.refresh_token,
            gmail_token_expiry: tokens.expiry_date,
        });
        return res.redirect('/?connected=1');
    } catch (err) {
        return res.redirect(`/?error=${encodeURIComponent(err.message)}`);
    }
}
