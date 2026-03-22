// api/gmail/auth.js — Status OAuth + redirect para autorização
import { authUrl } from '../../lib/gmail.js';
import { getSettings } from '../../lib/db.js';
import { cors } from '../../lib/cors.js';

export default async function handler(req, res) {
    if (cors(req, res)) return;

    // GET → verifica status ou redireciona para OAuth
    if (req.method === 'GET') {
        const force = req.query?.force === '1';

        // Sem ?force=1: só verifica se está autenticado (usado pelo dashboard)
        if (!force) {
            try {
                const settings = await getSettings();
                const hasToken = !!(settings?.gmail_refresh_token || settings?.refresh_token);
                if (hasToken) {
                    return res.status(200).json({ authorized: true });
                }
            } catch (e) {}
        }

        // Com ?force=1 ou sem token: redireciona para OAuth (force re-consent)
        return res.redirect(authUrl());
    }

    return res.status(405).end();
}