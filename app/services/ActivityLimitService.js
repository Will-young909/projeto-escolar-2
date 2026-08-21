const pool = require('../../config/pool');

// Define o limite diário de atividades que um aluno pode realizar.
const DAILY_LIMIT = 5;

const ActivityLimitService = {
    /**
     * Verifica quantas atividades gratuitas (checkpoint) um aluno completou na data atual.
     * @param {string} alunoId - O ID do aluno a ser verificado.
     * @returns {Promise<{contagem: number, limite: number, limiteAtingido: boolean}>}
     */
    async getContagemAtividadesHoje(alunoId) {
        if (!alunoId) {
            return { contagem: 0, limite: DAILY_LIMIT, limiteAtingido: false };
        }

        try {
            const hoje = new Date().toISOString().slice(0, 10);

            // Conta apenas as tentativas de 'checkpoint' que NÃO foram feitas com um passe.
            const [rows] = await pool.query(
                `SELECT COUNT(id) as contagem 
                 FROM tentativas_teste 
                 WHERE aluno_id = ? AND tipo = 'checkpoint' AND DATE(data_conclusao) = ? AND usou_passe = FALSE`,
                [alunoId, hoje]
            );

            const contagem = rows[0].contagem || 0;
            
            return {
                contagem,
                limite: DAILY_LIMIT,
                limiteAtingido: contagem >= DAILY_LIMIT,
            };
        } catch (error) {
            console.error('Erro ao verificar o limite de atividades diárias:', error);
            return { contagem: 0, limite: DAILY_LIMIT, limiteAtingido: false };
        }
    }
};

module.exports = ActivityLimitService;
