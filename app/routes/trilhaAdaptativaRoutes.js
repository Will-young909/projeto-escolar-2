const express = require('express');
const router = express.Router();
const TrilhaAdaptativaController = require('../controllers/TrilhaAdaptativaController');

// Rota para iniciar a trilha e obter a primeira tarefa (seja questão, vídeo, etc.)
// Ex: GET /api/trilha-adaptativa/iniciar/123
router.get('/iniciar/:alunoId', TrilhaAdaptativaController.iniciarTrilha);

// Rota para processar a resposta de um aluno a uma QUESTÃO
// Ex: POST /api/trilha-adaptativa/responder
router.post('/responder', TrilhaAdaptativaController.processarResposta);

// Rota para o aluno sinalizar que consumiu um CONTEÚDO DE APOIO (vídeo, artigo)
// Ex: POST /api/trilha-adaptativa/marcar-consumido
router.post('/marcar-consumido', TrilhaAdaptativaController.marcarConteudoConsumido);


module.exports = router;
