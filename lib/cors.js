// lib/cors.js — Middleware CORS para todos os endpoints
// Chame no topo de cada handler: if (cors(req, res)) return;

export function cors(req, res) {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'x-api-key, Content-Type, Authorization');

    // Preflight OPTIONS — responde 204 e encerra
    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return true; // sinaliza que o handler deve parar aqui
    }
    return false;
}
