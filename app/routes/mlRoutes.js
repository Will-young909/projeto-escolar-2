
const express = require('express');
const router = express.Router();
const { pedagogicalQueue } = require('../lib/queue'); // Importa a nossa fila

/**
 * @swagger
 * /api/ml/train:
 *   post:
 *     summary: Adiciona uma tarefa para treinar o modelo de Machine Learning.
 *     description: >
 *       Esta rota adiciona uma tarefa 'train-ml-model' à fila de processamento em segundo plano.
 *       A API responde imediatamente, confirmando que a tarefa foi agendada.
 *       O processo "worker" irá executar o treinamento de forma assíncrona.
 *     tags:
 *       - Machine Learning
 *     responses:
 *       202:
 *         description: >
 *           Tarefa de treinamento agendada com sucesso.
 *       500:
 *         description: Erro ao agendar a tarefa de treinamento.
 */
router.post('/train', async (req, res) => {
    try {
        // Adiciona a tarefa à fila. O worker fará o resto.
        await pedagogicalQueue.add('train-ml-model', {});
        
        res.status(202).json({ message: 'Tarefa de treinamento do modelo foi agendada e será executada em segundo plano.' });
    } catch (error) {
        console.error('Erro ao agendar a tarefa de treinamento:', error);
        res.status(500).json({ error: 'Erro ao agendar a tarefa.' });
    }
});

module.exports = router;
