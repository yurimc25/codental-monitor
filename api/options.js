// api/options.js — endpoint dedicado para preflight CORS
// Chame diretamente: OPTIONS https://gmailcodental-monitor.vercel.app/api/options
export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-api-key, Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.status(204).end();
}