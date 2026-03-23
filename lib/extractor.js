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
    // palavras de rodapé de email que aparecem como falsos positivos
    'estara','estará','disponivel','disponível','sempre','finalizado',
    'diagnosticos','diagnósticos','odontologicos','odontológicos','imagem',
    'arquivo','arquivos','for','sera','será','enviado','enviados',
    'acessado','acessar','plataforma','sistema','portal',
    'site','nosso','nossa','atraves','através','qualquer','duvida','dúvida',
    'contato','suporte','acesse','clique','link','aqui','abaixo',
    'registrado','requerimento','protocolo','pendencia','pendência',
    'renegociacao','renegociação','tabela','microscopio','microscópio',
    // laboratórios e fornecedores que aparecem como falsos positivos de nomes
    'safe','carneiro','safecarneiro','laboratorio','laboratório','lab',
    'sanctus','voxclin','imagiodonto','imaginologia','radiologia',
    'alfa','alfaradiologia',
    // palavras do corpo de emails clínicos que não são nomes de pacientes
    'computadorizada','computadorizado','tomografias','radiografias',
    'resultado','resultados','historico','histórico','disponivel','disponível',
    'prezado','prezada','atenciosamente','equipe','clinica','clínica',
    'paciente','pacientes','exame','exames','segue','serao','serão',
    'acesso','acessar','cadastrado','cadastrar','senha','login',
    'fenelon','radiomaster','voxels','laudo','laudos',
]);

const PREPOSITIONS = new Set(['de','da','do','dos','das','e']);

function norm(s) {
    return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Bloco de nome: palavra maiúscula ou MAIÚSCULA seguida opcionalmente de mais palavras
// Aceita preposições no meio: "DA", "DE", "DO" etc
// À-ÿ cobre caracteres acentuados
const NAME_PAT = '[A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]{1,}(?:\\s+(?:[Dd][eaoEAO][a-z]*|[A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+))*';

const PATTERNS = [
    // "paciente: NOME" ou "paciente - NOME"
    /paciente[:\s\-\u2013]+([A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+(?:\s+(?:[A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+|[Dd][eaoEAO][a-z]*))*)/gi,
    // "radiografias do paciente: NOME"
    /(?:radiografias?|exames?)\s+do\s+paciente[:\s\-\u2013]*([A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+(?:\s+(?:[A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+|[Dd][eaoEAO][a-z]*))*)/gi,
    // "keyword: NOME"
    /(?:tomografia|cbct|voxels?|fenelon|radiomaster|laudo|exame|radiografia)[:\s\-\u2013|\/]+([A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+(?:\s+(?:[A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+|[Dd][eaoEAO][a-z]*))*)/gi,
    // "NOME - keyword"
    /([A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+(?:\s+(?:[A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+|[Dd][eaoEAO][a-z]*))+)\s*[\-\u2013|]\s*(?:tomografia|cbct|voxels?|fenelon|radiomaster|laudo|exame|radiografia)/gi,
    // "nome: NOME"
    /\bnome[:\s\-\u2013]+([A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+(?:\s+(?:[A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF]+|[Dd][eaoEAO][a-z]*))*)/gi,
];

// ─── CPF ─────────────────────────────────────────────────────────────────────

const CPF_RE = /\b(\d{3}[.\-\s]?\d{3}[.\-\s]?\d{3}[.\-\s]?\d{2})\b/g;

/**
 * Extrai o primeiro CPF válido encontrado em um texto.
 * Aceita formatos: 123.456.789-09 | 123456789-09 | 12345678909 | com espaços
 * Retorna o CPF formatado (xxx.xxx.xxx-xx) ou null.
 */
export function extractCPF(text) {
    if (!text) return null;
    CPF_RE.lastIndex = 0;
    const matches = [...text.matchAll(CPF_RE)];
    for (const m of matches) {
        const digits = m[1].replace(/\D/g, '');
        if (digits.length === 11 && isValidCPF(digits)) {
            return `${digits.slice(0,3)}.${digits.slice(3,6)}.${digits.slice(6,9)}-${digits.slice(9)}`;
        }
    }
    return null;
}

function isValidCPF(d) {
    // Rejeita sequências repetidas (111.111.111-11)
    if (/^(\d)\1{10}$/.test(d)) return false;
    let s = 0;
    for (let i = 0; i < 9; i++) s += parseInt(d[i]) * (10 - i);
    let r = (s * 10) % 11; if (r === 10 || r === 11) r = 0;
    if (r !== parseInt(d[9])) return false;
    s = 0;
    for (let i = 0; i < 10; i++) s += parseInt(d[i]) * (11 - i);
    r = (s * 10) % 11; if (r === 10 || r === 11) r = 0;
    return r === parseInt(d[10]);
}

/**
 * Remove CPFs do texto antes de extrair nomes,
 * evitando que dígitos sejam confundidos com parte do nome.
 * Também retorna os CPFs encontrados separadamente.
 */
export function stripCPF(text) {
    if (!text) return { clean: text, cpf: null };
    CPF_RE.lastIndex = 0;
    let cpf = null;
    const clean = text.replace(CPF_RE, (match) => {
        const digits = match.replace(/\D/g, '');
        if (digits.length === 11 && isValidCPF(digits)) {
            cpf = cpf || `${digits.slice(0,3)}.${digits.slice(3,6)}.${digits.slice(6,9)}-${digits.slice(9)}`;
            return ' '; // remove do texto
        }
        return match;
    });
    return { clean: clean.replace(/\s+/g, ' ').trim(), cpf };
}

// ─────────────────────────────────────────────────────────────────────────────

function cleanName(s) {
    // Remove CPF e caracteres especiais do nome antes de processar
    const { clean } = stripCPF(s);
    return clean.replace(/[^\wÀ-ÿ\s]/g, '').replace(/\s+/g, ' ').trim();
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

/**
 * Valida se dois primeiros nomes são compatíveis.
 * Regras:
 *   - A primeira letra SEMPRE deve ser igual (é=e, ç=c normalizados)
 *   - Nomes com 4+ chars: os 2 primeiros chars devem ser iguais
 *   - Nomes até 5 chars: até 1 erro total permitido
 *   - Nomes com 6+ chars: até 2 erros totais permitidos
 * Retorna false se os primeiros nomes são claramente diferentes.
 * Exemplos bloqueados: EVA vs HEITOR, LILIANE vs ELIANE, HELENA vs SELENA
 * Exemplos permitidos: JAIME vs JAIME, SCHOEDER vs SCHROEDER, CECILIA vs Cecília
 */
function firstNameCompatible(firstA, firstB) {
    if (!firstA || !firstB) return true;
    const fa = norm(firstA), fb = norm(firstB);
    if (fa === fb) return true;
    const dist = levenshtein(fa, fb);
    const minLen = Math.min(fa.length, fb.length);
    const maxErrors = minLen <= 5 ? 1 : 2;
    if (dist > maxErrors) return false;
    // A primeira letra SEMPRE deve ser igual
    if (fa[0] !== fb[0]) return false;
    // Para nomes com 4+ chars: os 2 primeiros chars devem ser iguais
    if (minLen >= 4 && fa.slice(0, 2) !== fb.slice(0, 2)) return false;
    return true;
}

export function scorePair(a, b) {
    const na = norm(a), nb = norm(b);
    if (na === nb) return 1.0;
    if (nb.includes(na) || na.includes(nb)) return 0.92;

    const tokA = na.split(/\s+/).filter(t => t.length > 1 && !PREPOSITIONS.has(t));
    const tokB = nb.split(/\s+/).filter(t => t.length > 1 && !PREPOSITIONS.has(t));

    // ── VALIDAÇÃO OBRIGATÓRIA DO PRIMEIRO NOME ──────────────────────────────
    // O primeiro token significativo de A DEVE ser compatível com o primeiro
    // de B. Se não for, retorna 0 imediatamente — independente dos sobrenomes.
    // Isso evita matches como: EVA Zeidan → HEITOR Zeidan, ou Uniodonto → Pedro
    if (tokA.length > 0 && tokB.length > 0) {
        if (!firstNameCompatible(tokA[0], tokB[0])) {
            return 0;
        }
    }

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
            const pName = p.fullName || p.fullName || p.name || p.full_name || p.nome || '';
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
            const pName = p.fullName || p.fullName || p.name || p.full_name || p.nome || '';
            if (!pName) continue;
            const score = Math.min(1, scorePair(cand.name, pName) + (cand.confidence === 'high' ? 0.03 : 0));
            if (score >= 0.82 && score > bestAutoScore) { bestAutoScore = score; bestAuto = { patient: p, score, candidateName: cand.name }; }
            else if (score >= 0.45 && score > bestSuggScore) { bestSuggScore = score; bestSugg = { patient: p, score, candidateName: cand.name }; }
        }
    }
    return { auto: bestAuto, suggestion: bestSugg };
}