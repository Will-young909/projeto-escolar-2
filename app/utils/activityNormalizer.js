function normalizeActivityQuestions(activity) {
    const rawQuestions = Array.isArray(activity.questions) ? activity.questions : Object.values(activity.questions || {});

    return rawQuestions.map((question) => {
        let options = null;
        let correctKey = question.correct;

        if (Array.isArray(question.options) && question.options.length > 0) {
            options = question.options.reduce((acc, value, index) => {
                const letter = String.fromCharCode(65 + index);
                acc[letter] = value;
                return acc;
            }, {});
            const correctIndex = parseInt(question.correct, 10);
            if (!isNaN(correctIndex) && correctIndex >= 1 && correctIndex <= question.options.length) {
                correctKey = String.fromCharCode(65 + correctIndex - 1);
            }
        } else if (question.options && Object.keys(question.options).length > 0) {
            options = Object.fromEntries(Object.entries(question.options).filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== ''));
            const correctIndex = parseInt(question.correct, 10);
            if (!isNaN(correctIndex) && correctIndex >= 1 && Object.keys(options).length >= correctIndex) {
                correctKey = String.fromCharCode(65 + correctIndex - 1);
            }
        }

        // Se o objeto de opções ficar vazio (ex.: "options": []), trata a questão como escrita
        if (options && Object.keys(options).length === 0) {
            options = null;
        }

        const correctAnswer = question.correctAnswer || (options ? (options[correctKey] || correctKey) : '');
        const keywords = !options
            ? (Array.isArray(question.keywords) && question.keywords.length
                ? question.keywords.map(k => ({ text: String(k.text || '').trim(), required: !!k.required, peso: Math.max(0.1, Number(k.peso) || 1) })).filter(k => k.text)
                : parseKeywords(correctAnswer))
            : [];

        return {
            ...question,
            title: question.title || question.text || question.enunciado || 'Questão',
            text: question.text || question.title || question.enunciado || 'Questão',
            type: question.type || (options ? 'multiple_choice' : 'short_text'),
            options,
            correct: correctKey,
            correctAnswer,
            keywords
        };
    });
}

const norm = (valor) => String(valor === null || valor === undefined ? '' : valor).trim().toLowerCase();

function normalizeForKeywordMatch(text) {
    return String(text === null || text === undefined ? '' : text)
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9s]/g, ' ')
        .replace(/s+/g, ' ')
        .trim();
}

function parseKeywords(correctAnswer) {
    if (correctAnswer === null || correctAnswer === undefined) return [];
    const raw = String(correctAnswer).trim();
    if (!raw) return [];

    // Formato estruturado: palavra(obrigatoria|opcional|peso=N)
    if (/(([^)]*(obrigatoria|obrigat[oó]ria|opcional|required|optional|pesos*=)s*[^)]*))/i.test(raw) || raw.includes(';')) {
        return raw.split(/[;,]+/).map(part => part.trim()).filter(Boolean).map(part => {
            const m = part.match(/^(.*?)(?:(([^)]*)))?s*$/);
            const text = (m ? m[1] : part).trim();
            const meta = (m && m[2] ? m[2] : '').toLowerCase();
            const required = /obrigat|required/.test(meta);
            const pesoMatch = meta.match(/pesos*=s*(d+(?:[.,]d+)?)/i);
            const peso = pesoMatch ? Math.max(0.1, Number(pesoMatch[1].replace(',', '.')) || 1) : 1;
            return text ? { text, required, peso } : null;
        }).filter(Boolean);
    }

    // Formato simples: separadas por vírgula, * marca obrigatória
    return raw.split(/[\,\n]+/).map(part => part.trim()).filter(Boolean).map(part => {
        const required = /\*$/.test(part) || /^\*/.test(part);
        const text = part.replace(/^\*+|\*+$/g, '').trim();
        return text ? { text, required, peso: 1 } : null;
    }).filter(Boolean);
}

function evaluateKeywordAnswer(question, answer) {
    const keywords = Array.isArray(question.keywords) && question.keywords.length
        ? question.keywords.map(k => ({ text: String(k.text || '').trim(), required: !!k.required, peso: Math.max(0.1, Number(k.peso) || 1) })).filter(k => k.text)
        : parseKeywords(question.correctAnswer || question.correct || '');
    const normalizedAnswer = normalizeForKeywordMatch(answer);
    const details = keywords.map(k => {
        const found = !!k.text && normalizedAnswer.includes(normalizeForKeywordMatch(k.text));
        return { ...k, found };
    });
    const totalWeight = details.reduce((s, k) => s + k.peso, 0);
    const matchedWeight = details.reduce((s, k) => s + (k.found ? k.peso : 0), 0);
    const missingRequired = details.some(k => k.required && !k.found);
    let scorePercent = 0;
    if (details.length === 0) {
        scorePercent = normalizedAnswer && normalizedAnswer === normalizeForKeywordMatch(question.correctAnswer) ? 100 : 0;
    } else if (!missingRequired) {
        scorePercent = totalWeight > 0 ? (matchedWeight / totalWeight) * 100 : 0;
    }
    return {
        scorePercent: Math.round(scorePercent * 100) / 100,
        isCorrect: scorePercent >= 99.999,
        details,
        missingRequired,
        normalizedAnswer
    };
}

/**
 * Resolve a posição (0-based) de um gabarito dentro das opções.
 * Aceita índice numérico 1-based ("3"), letra ("C") ou a própria chave do objeto.
 */
function indiceDoGabarito(entries, correct) {
    const alvo = norm(correct);
    if (/^\d+$/.test(alvo)) return parseInt(alvo, 10) - 1;
    if (/^[a-z]$/.test(alvo)) return alvo.charCodeAt(0) - 97;
    return entries.findIndex(([chave]) => norm(chave) === alvo);
}

/** Resolve a posição (0-based) do que o aluno marcou, aceitando chave, letra ou texto. */
function indiceDaResposta(entries, marked) {
    const alvo = norm(marked);
    const porChave = entries.findIndex(([chave]) => norm(chave) === alvo);
    if (porChave >= 0) return porChave;
    const porTexto = entries.findIndex(([, texto]) => norm(texto) === alvo);
    if (porTexto >= 0) return porTexto;
    if (/^[a-z]$/.test(alvo)) {
        const p = alvo.charCodeAt(0) - 97;
        if (p < entries.length) return p;
    }
    if (/^\d+$/.test(alvo)) {
        const p = parseInt(alvo, 10) - 1;
        if (p < entries.length) return p;
    }
    return -1;
}

/**
 * Confere a resposta marcada contra o gabarito.
 *
 * Compara as DUAS pontas como posição na lista de alternativas. Isso é
 * necessário porque o formulário posta a CHAVE da alternativa ("1", "2"...,
 * como a IA envia) enquanto o gabarito é normalizado para LETRA ("C"). Comparar
 * os dois textos diretamente dava sempre falso e zerava a pontuação.
 */
function isAnswerCorrect(question, answer) {
    if (answer === undefined || answer === null || String(answer).trim() === '') return false;
    const marked = String(answer).trim().toLowerCase();

    // Questão escrita: avalia por palavras-chave (com normalização/obrigatoriedade/peso).
    if (!question.options) {
        return evaluateKeywordAnswer(question, answer).isCorrect;
    }

    const entries = Object.entries(question.options);
    const idxCorreta = indiceDoGabarito(entries, question.correct);
    if (idxCorreta < 0 || idxCorreta >= entries.length) return false;

    return indiceDaResposta(entries, marked) === idxCorreta;
}

module.exports = {
    normalizeActivityQuestions,
    isAnswerCorrect,
    normalizeForKeywordMatch,
    parseKeywords,
    evaluateKeywordAnswer
};
