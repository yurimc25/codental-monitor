// lib/extractor.js — Extrai nomes de pacientes + matching fuzzy com Levenshtein

const DENTAL_WORDS = new Set([
    'tomografia','voxels','voxel','fenelon','radiomaster','documentacao',
    'cbct','radiografia','laudo','exame','resultado','rx','tc','imagem','imagens',
    'odontologico','dentista','clinica','encaminhamento','ref','referente',
    'paciente','nome','envio','anexo','arquivo','arquivos',
    'segunda','terca','quarta','quinta','sexta','sabado','domingo',
    'janeiro','fevereiro','marco','abril','maio','junho',
    'julho','agosto','setembro','outubro','novembro','dezembro',
    'odonto','face','codental','hospital','anchieta','taguatinga',
    'guara','brasilia','df','alta','baixa','media','radiografias',
]);

const PREPOSITIONS = new Set(['de','da','do','dos','das','e']);

function norm(s) {
    return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

const PATTERNS = [
    /paciente[:\s\-\u2013]+([A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+(?:\s+(?:de|da|do|dos|das|e|[A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+))*)/gi,
    /(?:radiografias?|exames?)\s+do\s+paciente[:\s\-\u2013]*([A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+(?:\s+[A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+)*)/gi,
    /(?:tomografia|cbct|voxels?|fenelon|radiomaster|laudo|exame|radiografia)[:\s\-\u2013|\/]+([A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+(?:\s+(?:de|da|do|dos|das|e|[A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+))*)/gi,
    /([A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+(?:\s+(?:de|da|do|dos|das|e|[A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+))+)\s*[\-\u2013|]\s*(?:tomografia|cbct|voxels?|fenelon|radiomaster|laudo|exame|radiografia)/gi,
    /\bnome[:\s\-\u2013]+([A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+(?:\s+(?:de|da|do|dos|das|e|[A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+))*)/gi,
];

function cleanName(s) {
    return s.replace(/[^\w\u00C0-\u00FF\s]/g, '').replace(/\s+/g, ' ').trim();
}

function isValidName(s) {
    if (!s || s.length < 4) return false;
    const words = s.split(/\s+/);
    const significant = words.filter(w => w.length > 1 && !DENTAL_WORDS.has(norm(w)) && !PREPOSITIONS.has(norm(w)));
    return significant.length >= 2;
}

function extractCapitalized(text) {
    const results = [];
    const tokens = text.split(/[\s,;:|–\-\/\\()\[\]]+/);
    let seq = [];
    const flush = () => {
        while (seq.length && PREPOSITIONS.has(norm(seq[0]))) seq.shift();
        while (seq.length && PREPOSITIONS.has(norm(seq[seq.length - 1]))) seq.pop();
        if (seq.length >= 2) results.push(seq.join(' '));
        seq = [];
    };
    for (const tok of tokens) {
        const isCap   = /^[A-Z\u00C0-\u00FF][a-z\u00C0-\u00FF]{1,}$/.test(tok);
        const isAllCap= /^[A-Z\u00C0-\u00FF]{2,}$/.test(tok);
        const isPrep  = PREPOSITIONS.has(norm(tok)) && seq.length > 0;
        const isStop  = DENTAL_WORDS.has(norm(tok));
        if (((isCap || isAllCap) && !isStop) || isPrep) seq.push(tok);
        else flush();
    }
    flush();
    return results;
}

export function extractNames(subject, body) {
    const seen = new Set();
    const candidates = [];
    const add = (name, confidence) => {
        const cleaned = cleanName(name);
        if (!isValidName(cleaned)) return;
        const key = norm(cleaned);
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push({ name: cleaned, confidence });
    };
    for (const pat of PATTERNS) { pat.lastIndex = 0; let m; while ((m = pat.exec(subject)) !== null) add(m[1], 'high'); }
    for (const pat of PATTERNS) { pat.lastIndex = 0; let m; while ((m = pat.exec(body))    !== null) add(m[1], 'high'); }
    for (const name of extractCapitalized(subject)) add(name, 'medium');
    if (candidates.length === 0) {
        for (const line of body.split('\n').slice(0, 8))
            for (const name of extractCapitalized(line)) add(name, 'low');
    }
    return candidates;
}

// ─── VARIANTES DE BUSCA ───────────────────────────────────────────────────────
// Gera termos para consultar o Codental (busca fuzzy aceita partes do nome)
export function nameSearchVariants(name) {
    const tokens = norm(name).split(/\s+/).filter(t => t.length > 1 && !PREPOSITIONS.has(t));
    if (tokens.length < 2) return [name];
    const v = new Set([name]);
    v.add(`${tokens[0]} ${tokens[tokens.length - 1]}`);   // primeiro + último
    v.add(`${tokens[0]} ${tokens[1]}`);                    // primeiro + segundo
    v.add(tokens[0]);                                       // só primeiro (retorna mais)
    if (tokens.length >= 3) v.add(`${tokens[0]} ${tokens[tokens.length - 2]}`);
    return [...v];
}

// ─── SIMILARIDADE ─────────────────────────────────────────────────────────────
function levenshtein(a, b) {
    if (a === b) return 0;
    if (a.length > 20 || b.length > 20) return 99;
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m+1 }, (_, i) =>
        Array.from({ length: n+1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
    for (let i = 1; i <= m; i++)
        for (let j = 1; j <= n; j++)
            dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    return dp[m][n];
}

function scorePair(a, b) {
    const na = norm(a), nb = norm(b);
    if (na === nb) return 1.0;
    if (nb.includes(na) || na.includes(nb)) return 0.92;

    const tokA = na.split(/\s+/).filter(t => t.length > 1 && !PREPOSITIONS.has(t));
    const tokB = nb.split(/\s+/).filter(t => t.length > 1 && !PREPOSITIONS.has(t));
    const setB = new Set(tokB);

    // Quantos tokens de A estão em B (exato ou fuzzy)
    let matched = 0;
    for (const ta of tokA) {
        if (setB.has(ta)) { matched++; continue; }
        // Fuzzy: Levenshtein <= 2 em tokens de tamanho similar
        for (const tb of tokB) {
            if (Math.abs(ta.length - tb.length) <= 2 && levenshtein(ta, tb) <= 2) { matched += 0.7; break; }
        }
    }

    const minLen = Math.min(tokA.length, tokB.length);
    return minLen > 0 ? Math.min(0.99, matched / minLen) : 0;
}

// AUTO: score >= 0.82 → aceita automaticamente
// SUGESTÃO: score entre 0.45 e 0.82 → guarda para revisão manual
export function bestMatch(candidates, patients, threshold = 0.82) {
    let best = null, bestScore = 0;
    for (const cand of candidates) {
        for (const p of patients) {
            const pName = p.name || p.full_name || p.nome || '';
            if (!pName) continue;
            const score = Math.min(1, scorePair(cand.name, pName) + (cand.confidence === 'high' ? 0.03 : 0));
            if (score > bestScore) { bestScore = score; best = { patient: p, score, candidateName: cand.name }; }
        }
    }
    return bestScore >= threshold ? best : null;
}

export function matchWithSuggestions(candidates, patients) {
    let bestAuto = null, bestAutoScore = 0;
    let bestSugg = null, bestSuggScore = 0;

    for (const cand of candidates) {
        for (const p of patients) {
            const pName = p.name || p.full_name || p.nome || '';
            if (!pName) continue;
            const score = Math.min(1, scorePair(cand.name, pName) + (cand.confidence === 'high' ? 0.03 : 0));
            if (score >= 0.82 && score > bestAutoScore) { bestAutoScore = score; bestAuto = { patient: p, score, candidateName: cand.name }; }
            else if (score >= 0.45 && score > bestSuggScore) { bestSuggScore = score; bestSugg = { patient: p, score, candidateName: cand.name }; }
        }
    }
    return { auto: bestAuto, suggestion: bestSugg };
}