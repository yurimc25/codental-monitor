// api/gmail/auth.js — Retorna URL OAuth
import { authUrl } from '../../lib/gmail.js';
export default (req, res) => res.json({ url: authUrl() });
