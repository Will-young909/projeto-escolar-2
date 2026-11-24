const express = require('express');
const router = express.Router();
const TrailController = require('../controllers/TrailController');
const AlunoModel = require('../models/AlunoModel');
const Solvers = require('../services/ProblemSolverService');

require('dotenv').config();

// 🔐 validação
const USE_GEMINI = process.env.USE_GEMINI === 'true';

if (!USE_GEMINI && !process.env.MISTRAL_API_KEY) {
  throw new Error('MISTRAL_API_KEY não definida');
}
if (USE_GEMINI && !process.env.GEMINI_API_KEY) {
  throw new Error('GEMINI_API_KEY não definida');
}

let mistralClientPromise;
let geminiClientPromise;

function getMistralClient() {
  if (!mistralClientPromise) {
    mistralClientPromise = import('@mistralai/mistralai').then(({ Mistral }) => new Mistral({
      apiKey: process.env.MISTRAL_API_KEY
    }));
  }
  return mistralClientPromise;
}

function getGeminiClient() {
  if (!geminiClientPromise) {
    geminiClientPromise = import('@google/generative-ai').then(({ GoogleGenerativeAI }) => {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      return genAI.getGenerativeModel({ model: 'gemini-3.5-flash-lite' });
    });
  }
  return geminiClientPromise;
}

// 🔁 geração com Mistral
async function generateWithMistral(prompt, retries = 3) {
  const client = await getMistralClient();
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await client.chat.complete({
        model: 'mistral-small-latest',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7
      });
      return response.choices[0].message.content;
    } catch (error) {
      if (error.status === 429 && attempt < retries) {
        const waitMs = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
        console.warn(`Rate limited. Retrying in ${Math.round(waitMs)}ms (attempt ${attempt}/${retries})`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      throw error;
    }
  }
}

// 🔁 geração com Gemini
async function generateWithGemini(prompt, retries = 3) {
  const model = await getGeminiClient();
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7 }
      });
      return result.response.text();
    } catch (error) {
      if (error.status === 429 && attempt < retries) {
        const waitMs = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
        console.warn(`Rate limited. Retrying in ${Math.round(waitMs)}ms (attempt ${attempt}/${retries})`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      throw error;
    }
  }
}

// 🔀 selector
async function generateWithAI(prompt) {
  if (USE_GEMINI) {
    return generateWithGemini(prompt);
  }
  return generateWithMistral(prompt);
}

// 🔍 parser robusto
function extractJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw new Error('JSON inválido retornado pela IA');
  }
}

router.post('/generate-exercise', async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({
        error: 'Prompt é obrigatório'
      });
    }

    const fullPrompt = `
Crie um exercício de matemática com base na descrição: \"${prompt}\".

REGRAS OBRIGATÓRIAS DE CORREÇÃO MATEMÁTICA (o sistema vai recalcular e descartar a questão se houver erro):
1. RESOLVA a questão ANTES de escrever as alternativas. Faça a conta passo a passo e confirme o resultado.
2. A resposta correta DEVE aparecer, escrita da mesma forma, em UMA das quatro alternativas.
3. Somente UMA alternativa pode ser correta. As outras três devem ser incorretas.
4. Confira cada cálculo novamente, especialmente a soma, subtração, multiplicação, divisão, porcentagem ou fração pedida.
5. O campo \"correct\" deve ser o número (1 a 4) da alternativa que contém a resposta calculada.
6. Evite arredondamentos: se a divisão não for exata, prefira enunciados de resultado inteiro ou fração exata.
7. Use o formato brasileiro de números: milhar com ponto e decimal com vírgula (ex.: 1.234,56).
8. Todas as alternativas devem ser diferentes entre si, mesmo que sejam próximos.
9. A questão precisa ser matematicamente solucionável apenas com os dados do enunciado.

RESPONDA SOMENTE COM JSON VÁLIDO.
NÃO use markdown, nem escreva explicações fora do JSON.

Formato esperado:
{
  \"title\": \"Título do Exercício\",
  \"description\": \"Descrição do Exercício\",
  \"questions\": [
    {
      \"title\": \"Enunciado da Pergunta 1\",
      \"habilidade\": \"Habilidade matemática (ex: 'Soma', 'Geometria', 'Frações')\",
      \"dificuldade\": \"facil\",
      \"options\": {
        \"1\": \"Opção A\",
        \"2\": \"Opção B\",
        \"3\": \"Opção C\",
        \"4\": \"Opção D\"
      },
      \"correct\": \"1\"
    },
    {
      \"title\": \"Enunciado da Pergunta 2\",
      \"habilidade\": \"Habilidade matemática (ex: 'Subtração', 'Álgebra')\",
      \"dificuldade\": \"medio\",
      \"options\": {
        \"1\": \"Opção A\",
        \"2\": \"Opção B\",
        \"3\": \"Opção C\",
        \"4\": \"Opção D\"
      },
      \"correct\": \"3\"
    }
  ]
}
`;

    const rawText = await generateWithAI(fullPrompt);

    console.log('Resposta IA:', rawText);

    let jsonResponse;

    try {
      jsonResponse = extractJSON(rawText);
    } catch (err) {
      return res.status(500).json({
        error: 'IA retornou JSON inválido',
        raw: rawText
      });
    }

    return res.json(jsonResponse);

  } catch (error) {
    console.error('Erro geral:', error.message);

    return res.status(500).json({
      error: 'Falha ao gerar exercício',
      details: error.message
    });
  }
});

/**
 * Geração de PROBLEMA estruturado (pipeline determinístico).
 *
 * Diferente de `/generate-exercise`, aqui a IA devolve APENAS o problema
 * (`type` + `data` + enunciado). Sem alternativas e sem `correct`: quem
 * resolve e quem monta o gabarito é o backend.
 */
router.post('/generate-problem', async (req, res) => {
  try {
    const { prompt, tipo, dificuldade } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt é obrigatório' });
    }

    const catalogo = tipo
      ? Solvers.catalogoTipos([tipo])
      : Solvers.catalogoTipos(Solvers.tiposParaHabilidade(req.body.habilidade));

    const fullPrompt = `
${prompt}

${dificuldade ? `Dificuldade: ${dificuldade}. A dificuldade muda a COMPLEXIDADE dos números, nunca o tipo de problema.\n` : ''}
TIPOS DE PROBLEMA PERMITIDOS (use apenas um):
${JSON.stringify(catalogo, null, 2)}

FORMATO OBRIGATÓRIO DA RESPOSTA (apenas JSON, sem markdown, sem texto extra):
{
  "title": "Título curto",
  "description": "Uma frase de contexto",
  "habilidade": "Habilidade",
  "dificuldade": "facil | medio | dificil",
  "unit": "litros | cm | cm² | m³ | reais | null",
  "problem": {
    "type": "tipo_escolhido_da_lista",
    "data": { }
  },
  "question": "Enunciado completo em português do Brasil, coerente com problem.data"
}

REGRAS INEGOCIÁVEIS:
1. NÃO inclua o campo "options".
2. NÃO inclua o campo "correct".
3. NÃO calcule a resposta: o sistema calcula e descarta o que for errado.
4. Todo número citado no enunciado precisa estar exatamente em "problem.data".
5. Escreva frações no formato "3/5" (sem LaTeX).
`;

    const rawText = await generateWithAI(fullPrompt);
    const jsonResponse = extractJSON(rawText);

    console.log('[IA][PROBLEMA] tipo recebido:', jsonResponse?.problem?.type);

    return res.json(jsonResponse);
  } catch (error) {
    console.error('[IA][PROBLEMA_FAILED]', error.message);
    return res.status(500).json({
      error: 'Falha ao gerar problema estruturado',
      details: error.message
    });
  }
});

/**
 * Tutor de texto livre para a TRILHA ADAPTATIVA.
 *
 * Diferente de `/generate-exercise` e `/generate-problem`, aqui a IA devolve
 * apenas TEXTO pedagógico — nenhuma questão, nenhum gabarito. Existe porque os
 * endpoints de tutor em `router.js` (explicação/dica) foram escritos para o
 * fluxo de `atividades`: dependem de `activityStore` e de
 * `tentativas_teste.usou_passe`, dos quais a trilha não dispõe.
 *
 * Quem decide o QUE pedir (dica vs. explicação) é o `TutorIAService`; aqui só
 * executamos o prompt. A conferência de integridade do gabarito
 * (`GabaritoConferenceService`) roda ANTES, no serviço — não geramos texto
 * pedagógico a partir de gabarito falso.
 *
 * @param {{instrucao: string}} req.body Instrução de sistema já montada, com a
 *   política de não-revelação adequada ao recurso pedido.
 */
router.post('/tutor/texto', async (req, res) => {
  try {
    const { instrucao } = req.body;

    if (!instrucao || typeof instrucao !== 'string' || instrucao.trim().length < 20) {
      return res.status(400).json({ error: 'Instrução do tutor é obrigatória.' });
    }

    // `extractJSON` é reaproveitado porque a resposta é envelopada em
    // {"description": "..."} — mesmo contrato dos outros endpoints de IA, para
    // o cliente não precisar de um parser diferente.
    const fullPrompt = `${instrucao.trim()}

FORMATO OBRIGATÓRIO DA RESPOSTA (apenas JSON, sem markdown, sem texto extra):
{
  "description": "texto pedagógico aqui"
}

REGRAS INEGOCIÁVEIS:
1. NÃO crie exercícios, títulos nem listas de alternativas.
2. NÃO escreva nada fora do JSON.
3. Escreva em português do Brasil.`;

    const rawText = await generateWithAI(fullPrompt);
    const jsonResponse = extractJSON(rawText);

    // `description` é a única chave que o cliente consome. Se a IA devolveu
    // outra forma, caímos no texto cru em vez de perder a resposta.
    const texto = typeof jsonResponse?.description === 'string'
      ? jsonResponse.description
      : (typeof rawText === 'string' ? rawText.trim() : '');

    if (!texto) {
      return res.status(502).json({ error: 'IA não retornou texto utilizável' });
    }

    console.log('[IA][TUTOR] texto gerado |', texto.length, 'caracteres');
    return res.json({ description: texto });

  } catch (error) {
    console.error('[IA][TUTOR_FAILED]', error.message);
    return res.status(500).json({ error: 'Falha ao gerar o conteúdo do tutor', details: error.message });
  }
});

router.post('/generate-trail', async (req, res) => {
    try {
      const { testResults, alunoId } = req.body;
  
      if (!testResults && !alunoId) {
        return res.status(400).json({
          error: 'testResults and alunoId are required'
        }),
        res.send('/nivel_escolar');
      }
  
      const aluno = await AlunoModel.findById(alunoId);
      if (!aluno) {
        return res.status(404).json({ error: 'Aluno not found' });
      }
  
      const trailController = new TrailController(aluno);
      const trail = await trailController.generateTrail(testResults);
  
      // Instead of returning JSON, we now render the trilha page
      return res.render('pages/trilha', { trail });
  
    } catch (error) {
      console.error('Error generating trail:', error.message);
      return res.status(500).json({
        error: 'Failed to generate trail',
        details: error.message
      });
    }
  });

module.exports = router;