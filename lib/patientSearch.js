// lib/patientSearch.js — Busca fuzzy local na base de pacientes importada do Codental
// Usa a collection patients_cache no MongoDB

import { db } from './db.js';

function norm(s) {
    return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

function levenshtein(a, b) {
    if (a === b) return 0;
    if (a.length > 25 || b.length > 25) return 99;
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m+1 }, (_,i) =>
        Array.from({ length: n+1 }, (_,j) => i===0 ? j : j===0 ? i : 0));
    for (let i=1;i<=m;i++) for (let j=1;j<=n;j++)
        dp[i][j] = a[i-1]===b[j-1] ? dp[i-1][j-1] : 1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
    return dp[m][n];
}

const PREP = new Set(['de','da','do','dos','das','e']);

function scorePair(a, b) {
    const na = norm(a), nb = norm(b);
    if (na === nb) return 1.0;
    if (nb.includes(na) || na.includes(nb)) return 0.92;

    const tokA = na.split(/\s+/).filter(t => t.length > 1 && !PREP.has(t));
    const tokB = nb.split(/\s+/).filter(t => t.length > 1 && !PREP.has(t));
    const setB = new Set(tokB);

    let matched = 0;
    for (const ta of tokA) {
        if (setB.has(ta)) { matched++; continue; }
        for (const tb of tokB) {
            if (Math.abs(ta.length - tb.length) <= 2 && levenshtein(ta, tb) <= 2) {
                matched += 0.7; break;
            }
        }
    }
    const minLen = Math.min(tokA.length, tokB.length);
    return minLen > 0 ? Math.min(0.99, matched / minLen) : 0;
}

/**
 * Busca pacientes na base local.
 * Mais rápido e mais preciso que a API do Codental para nomes com erros de digitação.
 *
 * @param {string} name — nome extraído do email
 * @param {number} limit — máximo de resultados (padrão 10)
 * @returns {{ id, name, phone, score }[]} ordenado por score desc
 */
export async function searchPatientsLocal(name, limit = 10) {
    const col = (await db()).collection('patients_cache');
    const count = await col.countDocuments();

    if (count === 0) {
        console.warn('⚠️ patients_cache vazia — use /api/sync-patients para importar');
        return [];
    }

    const na = norm(name);
    const tokens = na.split(/\s+/).filter(t => t.length > 2 && !PREP.has(t));

    if (tokens.length === 0) return [];

    // Busca candidatos pelo primeiro token (índice de texto simples)
    // Em vez de varrer todos os 7000+ pacientes, pré-filtra por primeiro nome
    const firstToken = tokens[0];
    const lastToken  = tokens[tokens.length - 1];
    // Também tenta sem acentos para garantir match mesmo se name_norm tiver variação
    const firstNorm  = norm(firstToken);
    const lastNorm   = norm(lastToken);

    // Busca candidatos pelo primeiro OU último token no name ou name_norm
    const candidates = await col.find({
        $or: [
            { name_norm: { $regex: firstNorm, $options: 'i' } },
            { name_norm: { $regex: lastNorm,  $options: 'i' } },
            { name:      { $regex: firstToken, $options: 'i' } },
            { name:      { $regex: lastToken,  $options: 'i' } },
        ]
    }).limit(300).toArray();

    // Score fuzzy em todos os candidatos
    const scored = candidates
        .map(p => ({ ...p, score: scorePair(name, p.name) }))
        .filter(p => p.score >= 0.45)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

    if (scored.length > 0) {
        console.log(`🏠 Cache local "${name}": ${candidates.length} candidatos → top: ${scored[0].name} (${scored[0].score.toFixed(2)})`);
    } else {
        console.log(`🏠 Cache local "${name}": ${candidates.length} candidatos, nenhum acima do threshold`);
        // Log top 3 mesmo abaixo do threshold para debug
        const all = candidates.map(p => ({ name: p.name, score: scorePair(name, p.name) }))
            .sort((a,b) => b.score - a.score).slice(0,3);
        if (all.length) console.log(`   Melhores abaixo do threshold: ${all.map(p => p.name+'('+p.score.toFixed(2)+')').join(', ')}`);
    }

    return scored;
}

/**
 * Verifica se a base local está disponível e atualizada.
 */
export async function getCacheStatus() {
    const col  = (await db()).collection('patients_cache');
    const meta = await (await db()).collection('settings').findOne({ _id: 'patients_sync' });
    const total = await col.countDocuments();
    return {
        available: total > 0,
        total,
        last_sync: meta?.synced_at || null,
        stale: !meta?.synced_at || (Date.now() - new Date(meta.synced_at).getTime()) > 7 * 24 * 60 * 60 * 1000,
    };
}