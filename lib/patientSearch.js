// lib/patientSearch.js — Busca fuzzy de pacientes (base local + API Codental)

import { db } from './db.js';
import { searchPatients } from './codental.js';

const PREP = new Set(['de','da','do','dos','das','e']);

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
            if (Math.abs(ta.length - tb.length) <= 2 && levenshtein(ta, tb) <= 2) { matched += 0.7; break; }
        }
    }
    const minLen = Math.min(tokA.length, tokB.length);
    return minLen > 0 ? Math.min(0.99, matched / minLen) : 0;
}

// ─── BUSCA NA BASE LOCAL (CSV importado) ──────────────────────────────────────
export async function searchPatientsLocal(name, limit = 20) {
    const col = (await db()).collection('patients_cache');
    const count = await col.countDocuments();
    if (count === 0) return [];

    const na = norm(name);
    const tokens = na.split(/\s+/).filter(t => t.length > 1 && !PREP.has(t));
    if (tokens.length === 0) return [];

    const firstToken = tokens[0];
    const lastToken  = tokens[tokens.length - 1];

    const candidates = await col.find({
        $or: [
            { name_norm: { $regex: firstToken, $options: 'i' } },
            { name_norm: { $regex: lastToken,  $options: 'i' } },
            { name:      { $regex: firstToken, $options: 'i' } },
            { name:      { $regex: lastToken,  $options: 'i' } },
        ]
    }).limit(300).toArray();

    const scored = candidates
        .map(p => ({ ...p, score: scorePair(name, p.name) }))
        .filter(p => p.score >= 0.45)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

    if (scored.length > 0) {
        console.log(`  🏠 Local "${name}": ${candidates.length} candidatos → ${scored[0].name} (${scored[0].score.toFixed(2)})`);
    } else {
        console.log(`  🏠 Local "${name}": ${candidates.length} candidatos, nenhum acima do threshold`);
        const top3 = candidates.map(p => ({ name: p.name, score: scorePair(name, p.name) }))
            .sort((a,b) => b.score-a.score).slice(0,3);
        if (top3.length) console.log(`     Top: ${top3.map(p=>`${p.name}(${p.score.toFixed(2)})`).join(', ')}`);
    }

    return scored;
}

// ─── BUSCA NA API DO CODENTAL (progressiva com fuzzy local) ───────────────────
// Estratégia: busca nome completo → primeiro+último → primeiro+segundo → só primeiro
// Cada busca retorna até 50 candidatos → score Levenshtein decide o melhor
export async function searchPatientsViaAPI(name) {
    const tokens = norm(name).split(/\s+/).filter(t => t.length > 1 && !PREP.has(t));
    if (tokens.length === 0) return [];

    // Variantes da mais específica para a mais ampla
    const variants = new Set();
    variants.add(name);
    if (tokens.length >= 2) variants.add(`${tokens[0]} ${tokens[tokens.length - 1]}`);
    if (tokens.length >= 3) variants.add(`${tokens[0]} ${tokens[1]}`);
    variants.add(tokens[0]);

    const seenIds = new Set();
    const allCandidates = [];

    for (const variant of variants) {
        try {
            const pts = await searchPatients(variant);
            for (const p of pts) {
                const pid = String(p.id || '');
                if (!pid || seenIds.has(pid)) continue;
                seenIds.add(pid);
                // Normaliza fullName → name
                if (!p.name && p.fullName) p.name = p.fullName;
                p.score = scorePair(name, p.name);
                allCandidates.push(p);
            }
            // Se já temos um match excelente, para de buscar
            if (allCandidates.some(p => p.score >= 0.95)) break;
        } catch (err) {
            console.warn(`  ⚠️ API "${variant}" falhou: ${err.message}`);
        }
    }

    // Ordena por score e loga
    allCandidates.sort((a, b) => b.score - a.score);
    if (allCandidates.length > 0) {
        console.log(`  🌐 API "${name}": ${allCandidates.length} candidatos únicos → ${allCandidates[0].name} (${allCandidates[0].score.toFixed(2)})`);
    } else {
        console.log(`  🌐 API "${name}": 0 candidatos`);
    }

    return allCandidates;
}

// ─── BUSCA COM FALLBACK: local → API ─────────────────────────────────────────
export async function searchPatientsWithFallback(name) {
    const cacheStatus = await getCacheStatus();

    if (cacheStatus.available) {
        const local = await searchPatientsLocal(name, 20);
        if (local.length > 0) return { patients: local, source: 'local' };
        console.log(`  ⚠️ Não achado na base local — tentando API do Codental`);
    }

    const apiResults = await searchPatientsViaAPI(name);
    if (apiResults.length > 0) return { patients: apiResults, source: 'api' };

    return { patients: [], source: 'none' };
}

// ─── STATUS DO CACHE ──────────────────────────────────────────────────────────
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