// lib/extractor.js — Extrai nomes de pacientes de assunto + corpo de emails

const DENTAL_WORDS = new Set([
    'tomografia', 'voxels', 'voxel', 'fenelon', 'radiomaster', 'documentacao',
    'documentação', 'cbct', 'radiografia', 'laudo', 'exame', 'resultado',
    'rx', 'tc', 'imagem', 'imagens', 'odontologico', 'odontológico',
    'dentista', 'clinica', 'clínica', 'encaminhamento', 'ref', 'referente',
    'paciente', 'nome', 'envio', 'anexo', 'arquivo', 'arquivos',
    'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado', 'domingo',
    'janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho',
    'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
    'odonto', 'face', 'codental', 'hospital', 'anchieta', 'taguatinga',
    'guara', 'brasilia', 'df', 'alta', 'baixa', 'media',
]);

const PREPOSITIONS = new Set(['de', 'da', 'do', 'dos', 'das', 'e']);

function norm(s) {
    return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Padrões explícitos: captura o grupo 1 como nome
const PATTERNS = [
    // "Paciente: João Silva" / "Paciente - João Silva"
    /paciente[:\s\-–]+([A-ZÁÉÍÓÚÀÂÊÔÃÕÜÇ][a-záéíóúàâêôãõüç]+(?:\s+(?:de|da|do|dos|das|e|[A-ZÁÉÍÓÚÀÂÊÔÃÕÜÇ][a-záéíóúàâêôãõüç]+))*)/g,

    // "Keyword - Nome Sobrenome" ou "Keyword | Nome"
    /(?:tomografia|cbct|voxels?|fenelon|radiomaster|documentaç[aã]o|laudo|exame|radiografia)[:\s\-–|\/]+([A-ZÁÉÍÓÚÀÂÊÔÃÕÜÇ][a-záéíóúàâêôãõüç]+(?:\s+(?:de|da|do|dos|das|e|[A-ZÁÉÍÓÚÀÂÊÔÃÕÜÇ][a-záéíóúàâêôãõüç]+))*)/g,

    // "Nome Sobrenome - Keyword" (nome antes do separador)
    /([A-ZÁÉÍÓÚÀÂÊÔÃÕÜÇ][a-záéíóúàâêôãõüç]+(?:\s+(?:de|da|do|dos|das|e|[A-ZÁÉÍÓÚÀÂÊÔÃÕÜÇ][a-záéíóúàâêôãõüç]+))+)\s*[\-–|]\s*(?:tomografia|cbct|voxels?|fenelon|radiomaster|documentaç[aã]o|laudo|exame)/g,

    // "nome: João Silva"
    /\bnome[:\s\-–]+([A-ZÁÉÍÓÚÀÂÊÔÃÕÜÇ][a-záéíóúàâêôãõüç]+(?:\s+(?:de|da|do|dos|das|e|[A-ZÁÉÍÓÚÀÂÊÔÃÕÜÇ][a-záéíóúàâêôãõüç]+))*)/g,
];

function cleanName(s) {
    return s.replace(/[^\wÁÉÍÓÚÀÂÊÔÃÕÜÇáéíóúàâêôãõüç\s]/g, '').replace(/\s+/g, ' ').trim();
}

function isValidName(s) {
    if (!s || s.length < 5) return false;
    const words = s.split(/\s+/);
    // Pelo menos 2 palavras, nenhuma sendo stopword
    const significant = words.filter(w => w.length > 2 && !DENTAL_WORDS.has(norm(w)) && !PREPOSITIONS.has(norm(w)));
    return significant.length >= 2;
}

// Heurística: sequências de palavras capitalizadas
function extractCapitalized(text) {
    const results = [];
    const tokens = text.split(/[\s,;:|–\-\/\\()\[\]]+/);
    let seq = [];

    const flush = () => {
        // Remove preposições nas pontas
        while (seq.length && PREPOSITIONS.has(norm(seq[0]))) seq.shift();
        while (seq.length && PREPOSITIONS.has(norm(seq[seq.length - 1]))) seq.pop();
        if (seq.length >= 2) results.push(seq.join(' '));
        seq = [];
    };

    for (const tok of tokens) {
        const isCapitalized = /^[A-ZÁÉÍÓÚÀÂÊÔÃÕÜÇ][a-záéíóúàâêôãõüç]{1,}$/.test(tok);
        const isPrepIn = PREPOSITIONS.has(norm(tok)) && seq.length > 0;
        const isStop = DENTAL_WORDS.has(norm(tok));

        if ((isCapitalized && !isStop) || isPrepIn) {
            seq.push(tok);
        } else {
            flush();
        }
    }
    flush();
    return results;
}

/**
 * Retorna candidatos de nome ordenados por confiança.
 * @returns {{ name: string, confidence: 'high'|'medium'|'low' }[]}
 */
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

    const tokA = new Set(na.split(/\s+/).filter(t => t.length > 2 && !PREPOSITIONS.has(t)));
    const tokB = new Set(nb.split(/\s+/).filter(t => t.length > 2 && !PREPOSITIONS.has(t)));
    const inter = [...tokA].filter(t => tokB.has(t)).length;
    const union = new Set([...tokA, ...tokB]).size;
    return union > 0 ? inter / union : 0;
}

/**
 * Encontra o melhor paciente dentre os retornados pelo Codental.
 * Threshold 0.75 para aceitar o match.
 */
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
    return bestScore >= 0.75 ? best : null;
}
