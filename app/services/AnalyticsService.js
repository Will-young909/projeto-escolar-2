const AlunoModel = require('../models/AlunoModel');
const pool = require('../../config/pool');
const { xpParaNivel } = require('./GamificationService'); // Importa a função para cálculo de XP

const AnalyticsService = {

    /**
     * Agrega todos os dados necessários para o dashboard de progresso do aluno.
     * @param {string} alunoId - O ID do aluno.
     * @returns {Promise<object>} Um objeto contendo os dados para o dashboard.
     */
    async getDashboardData(alunoId) {
        try {
            // 1. Buscar dados primários do aluno (nível, xp, streak)
            const aluno = await AlunoModel.findById(alunoId);
            if (!aluno) {
                throw new Error(`Aluno com ID ${alunoId} não encontrado.`);
            }

            // 2. Calcular progresso de XP para o nível atual
            const xpNivelAtual = xpParaNivel(aluno.nivel || 1);
            const xpProximoNivel = xpParaNivel((aluno.nivel || 1) + 1);
            const progressoNivel = {
                xpAtual: aluno.xp_total || 0,
                xpNivelAtual: xpNivelAtual,
                xpProximoNivel: xpProximoNivel,
                percentual: Math.floor(((aluno.xp_total - xpNivelAtual) / (xpProximoNivel - xpNivelAtual)) * 100),
            };

            // 3. Buscar resumo de habilidades (pontos fortes e a melhorar)
            const [habilidades] = await pool.query(
                `SELECT habilidade, AVG(percentual) as mediaPercentual
                 FROM resultado_habilidade
                 WHERE aluno_id = ?
                 GROUP BY habilidade
                 ORDER BY mediaPercentual DESC`,
                [alunoId]
            );

            const pontosFortes = habilidades.slice(0, 3);
            const pontosAMelhorar = habilidades.slice(-3).reverse();

            // 4. Buscar histórico recente de atividades (placeholder)
            // Esta parte pode ser expandida para buscar um histórico mais detalhado
            const [historico] = await pool.query(
                `SELECT q.habilidade, i.acertou, i.concluido_em
                 FROM trilha_itens i
                 JOIN questoes q ON i.questao_id = q.id
                 JOIN trilhas t ON i.trilha_id = t.id
                 WHERE t.aluno_id = ? AND i.status = 'concluido'
                 ORDER BY i.concluido_em DESC
                 LIMIT 10`,
                [alunoId]
            );

            return {
                aluno: {
                    nome: aluno.nome,
                    nivel: aluno.nivel || 1,
                    streak: aluno.streak_atual || 0,
                },
                progressoNivel,
                resumoHabilidades: {
                    pontosFortes,
                    pontosAMelhorar,
                },
                historicoAtividades: historico
            };

        } catch (error) {
            console.error(`[AnalyticsService] Erro ao buscar dados do dashboard para o aluno ${alunoId}:`, error);
            // Retorna um objeto de fallback em caso de erro para não quebrar a view
            return {
                aluno: { nome: 'Aluno', nivel: 1, streak: 0 },
                progressoNivel: { xpAtual: 0, xpNivelAtual: 0, xpProximoNivel: 100, percentual: 0 },
                resumoHabilidades: { pontosFortes: [], pontosAMelhorar: [] },
                historicoAtividades: []
            };
        }
    }
};

module.exports = AnalyticsService;
