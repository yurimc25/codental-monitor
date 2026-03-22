// api/gmail/auth.js — Status OAuth + redirect para autorização
import { authUrl } from '../../lib/gmail.js';
import { getSettings } from '../../lib/db.js';
import { cors } from '../../lib/cors.js';

export default async function handler(req, res) {
    if (cors(req, res)) return;

    // GET → verifica se já está autenticado
    if (req.method === 'GET') {
        try {
            const settings = await getSettings();
            const hasToken = !!(settings?.gmail_refresh_token || settings?.refresh_token);
            if (hasToken) {
                return res.status(200).json({ authorized: true });
            }
        } catch (e) {}
        // Não autenticado — redireciona para OAuth
        return res.redirect(authUrl());
    }

    return res.status(405).end();
}