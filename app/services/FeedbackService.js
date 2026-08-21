const pool = require('../../config/pool');

const FeedbackService = {
    /**
     * Salva a resposta de um professor a um feedback e notifica o aluno.
     * @param {object} dados - Os dados para a resposta.
     * @param {string} dados.feedbackId - O ID do comentário/feedback original.
     * @param {string} dados.alunoId - O ID do aluno que receberá a resposta.
     * @param {string} dados.professorId - O ID do professor que está respondendo.
     * @param {string} dados.professorNome - O nome do professor para usar na notificação.
     * @param {string} dados.responseText - O conteúdo da resposta.
     */
    async responderFeedback({ feedbackId, alunoId, professorId, professorNome, responseText }) {
        if (!feedbackId || !alunoId || !professorId || !responseText) {
            throw new Error('Dados insuficientes para enviar a resposta.');
        }

        try {
            await pool.query('START TRANSACTION');

            // Etapa 1: Inserir a resposta em uma nova tabela `respostas_feedback`
            // Esta tabela precisa ser criada no banco de dados.
            // Estrutura sugerida: id, feedback_id, professor_id, texto_resposta, criado_em
            const [result] = await pool.query(
                'INSERT INTO respostas_feedback (feedback_id, professor_id, texto_resposta) VALUES (?, ?, ?)',
                [feedbackId, professorId, responseText]
            );
            const respostaId = result.insertId;

            // Etapa 2: Marcar o feedback original como respondido para evitar múltiplas respostas
            await pool.query('UPDATE comentarios SET respondido = 1 WHERE id = ?', [feedbackId]);

            // Etapa 3: Criar uma notificação para o aluno
            const mensagem = `**${professorNome}** respondeu ao seu feedback.\n\n` +
                             `Resposta: ${responseText}`;
            const link = `/feedbacks_aluno#feedback-${feedbackId}`;
            await pool.query(
                'INSERT INTO notificacoes (usuario_id, usuario_tipo, tipo, mensagem, link_relacionado) VALUES (?, ?, ?, ?, ?)',
                [alunoId, 'aluno', 'feedback_respondido', mensagem, link]
            );

            await pool.query('COMMIT');

            return { success: true, respostaId };

        } catch (error) {
            await pool.query('ROLLBACK');
            console.error('Erro no serviço ao responder feedback:', error);
            // Lançar o erro permite que a rota o capture e envie uma resposta 500
            throw new Error('Não foi possível salvar a resposta no banco de dados.');
        }
    }
};

module.exports = FeedbackService;
