const express = require('express');
const router = express.Router();
const TrailController = require('../controllers/TrailController');
const AlunoModel = require('../models/AlunoModel');

require('dotenv').config();

const { Mistral } = require('@mistralai/mistralai');

// 🔐 validação
if (!process.env.MISTRAL_API_KEY) {
  throw new Error('MISTRAL_API_KEY não definida');
}

const client = new Mistral({
  apiKey: process.env.MISTRAL_API_KEY
});

// 🔁 geração com Mistral
async function generateWithMistral(prompt) {
  const response = await client.chat.complete({
    model: 'mistral-small-latest', // rápido e gratuito
    messages: [
      {
        role: 'user',
        content: prompt
      }
    ],
    temperature: 0.7
  });

  return response.choices[0].message.content;
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
Crie um exercício com base na seguinte descrição: \"${prompt}\".

RESPONDA SOMENTE COM JSON VÁLIDO.
NÃO use markdown.
NÃO escreva explicações.
Se a resposta não for JSON válido, corrija antes de enviar.

Formato:
{
  \"title\": \"Título\",
  \"description\": \"Descrição\",
  \"questions\": [
    {
      \"title\": \"Pergunta\",
      \"type\": \"multiple_choice\",
      \"options\": {
        \"1\": \"Opção 1\",
        \"2\": \"Opção 2\",
        \"3\": \"Opção 3\",
        \"4\": \"Opção 4\"
      },
      \"correct\": \"1\"
    }
  ]
}
`;

    const rawText = await generateWithMistral(fullPrompt);

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
  
      if (!testResults || !alunoId) {
        return res.status(400).json({
          error: 'testResults and alunoId are required'
        });
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