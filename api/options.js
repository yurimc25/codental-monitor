// api/options.js — Responde a requisições OPTIONS (CORS preflight) para todas as rotas /api/*
// O vercel.json roteia OPTIONS /api/(.*) para cá via rewrite

export default function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST,PUT,DELETE,PATCH');
    res.setHeader('Access-Control-Allow-Headers', 'x-api-key, Content-Type, Authorization, X-Requested-With, Accept');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).end();
}
