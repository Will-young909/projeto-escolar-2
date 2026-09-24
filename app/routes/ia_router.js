const express = require('express');
const router = express.Router();
const TrailController = require('../controllers/TrailController');
const AlunoModel = require('../models/AlunoModel');

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

RESPONDA SOMENTE COM JSON VÁLIDO.
NÃO use markdown, nem escreva explicações.

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