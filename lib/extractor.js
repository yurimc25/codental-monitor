// lib/extractor.js — Extrai nomes de pacientes de assunto + corpo de emails

const DENTAL_WORDS = new Set([
    'tomografia', 'voxels', 'voxel', 'fenelon', 'radiomaster', 'documentacao',
    'documentacao', 'cbct', 'radiografia', 'laudo', 'exame', 'resultado',
    'rx', 'tc', 'imagem', 'imagens', 'odontologico', 'odontologico',
    'dentista', 'clinica', 'clinica', 'encaminhamento', 'ref', 'referente',
    'paciente', 'nome', 'envio', 'anexo', 'arquivo', 'arquivos',
    'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado', 'domingo',
    'janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho',
    'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
    'odonto', 'face', 'codental', 'hospital', 'anchieta', 'taguatinga',
    'guara', 'brasilia', 'df', 'alta', 'baixa', 'media', 'radiografias',
    'do', 'da', 'de', 'dos', 'das',
]);

const PREPOSITIONS = new Set(['de', 'da', 'do', 'dos', 'das', 'e']);

function norm(s) {
    return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Padrões explícitos — regex literais, sem geração dinâmica
// Captura grupo 1 como nome (Capitalizado OU TUDO MAIÚSCULO)
const PATTERNS = [
    // "paciente: NOME SOBRENOME" ou "paciente - NOME"
    /paciente[:\s\-\u2013]+([A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+(?:\s+(?:de|da|do|dos|das|e|[A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+))*)/gi,

    // "radiografias do paciente: NOME"
    /(?:radiografias?|exames?)\s+do\s+paciente[:\s\-\u2013]*([A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+(?:\s+[A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+)*)/gi,

    // "Keyword - NOME SOBRENOME" ou "Keyword: NOME"
    /(?:tomografia|cbct|voxels?|fenelon|radiomaster|laudo|exame|radiografia)[:\s\-\u2013|\/]+([A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+(?:\s+(?:de|da|do|dos|das|e|[A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+))*)/gi,

    // "NOME SOBRENOME - Keyword"
    /([A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+(?:\s+(?:de|da|do|dos|das|e|[A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+))+)\s*[\-\u2013|]\s*(?:tomografia|cbct|voxels?|fenelon|radiomaster|laudo|exame|radiografia)/gi,

    // "nome: NOME SOBRENOME"
    /\bnome[:\s\-\u2013]+([A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+(?:\s+(?:de|da|do|dos|das|e|[A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+))*)/gi,
];

function cleanName(s) {
    return s.replace(/[^\w\u00C0-\u00FF\s]/g, '').replace(/\s+/g, ' ').trim();
}

function isValidName(s) {
    if (!s || s.length < 4) return false;
    const words = s.split(/\s+/);
    const significant = words.filter(w =>
        w.length > 1 &&
        !DENTAL_WORDS.has(norm(w)) &&
        !PREPOSITIONS.has(norm(w))
    );
    return significant.length >= 2;
}

// Heurística: sequências de palavras capitalizadas OU TUDO MAIÚSCULO
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
        const isCapitalized = /^[A-Z\u00C0-\u00FF][a-z\u00C0-\u00FF]{1,}$/.test(tok);
        const isAllCaps = /^[A-Z\u00C0-\u00FF]{2,}$/.test(tok);
        const isPrepIn = PREPOSITIONS.has(norm(tok)) && seq.length > 0;
        const isStop = DENTAL_WORDS.has(norm(tok));

        if (((isCapitalized || isAllCaps) && !isStop) || isPrepIn) {
            seq.push(tok);
        } else {
            flush();
        }
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

    // Alta confiança: padrões explícitos no assunto
    for (const pat of PATTERNS) {
        pat.lastIndex = 0;
        let m;
        while ((m = pat.exec(subject)) !== null) add(m[1], 'high');
    }

    // Alta confiança: padrões explícitos no corpo
    for (const pat of PATTERNS) {
        pat.lastIndex = 0;
        let m;
        while ((m = pat.exec(body)) !== null) add(m[1], 'high');
    }

    // Confiança média: heurística no assunto
    for (const name of extractCapitalized(subject)) add(name, 'medium');

    // Baixa confiança: heurística nas primeiras 8 linhas do corpo
    if (candidates.length === 0) {
        const lines = body.split('\n').slice(0, 8);
        for (const line of lines)
            for (const name of extractCapitalized(line)) add(name, 'low');
    }

    return candidates;
}

// ─── MATCH PACIENTE ───────────────────────────────────────────────────────────

function similarity(a, b) {
    const na = norm(a), nb = norm(b);
    if (na === nb) return 1.0;
    if (nb.includes(na) || na.includes(nb)) return 0.9;

    const tokA = new Set(na.split(/\s+/).filter(t => t.length > 1 && !PREPOSITIONS.has(t)));
    const tokB = new Set(nb.split(/\s+/).filter(t => t.length > 1 && !PREPOSITIONS.has(t)));
    const inter = [...tokA].filter(t => tokB.has(t)).length;
    const union = new Set([...tokA, ...tokB]).size;
    return union > 0 ? inter / union : 0;
}

export function bestMatch(candidates, patients) {
    let best = null, bestScore = 0;
    for (const cand of candidates) {
        for (const p of patients) {
            const pName = p.name || p.full_name || p.nome || '';
            const score = similarity(cand.name, pName) + (cand.confidence === 'high' ? 0.05 : 0);
            if (score > bestScore) {
                bestScore = score;
                best = { patient: p, score, candidateName: cand.name };
            }
        }
    }
    return bestScore >= 0.70 ? best : null;
}