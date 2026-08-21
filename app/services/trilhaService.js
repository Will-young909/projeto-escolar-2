const pool = require('../../config/pool');
const MotorAdaptativoService = require('./MotorAdaptativoService');
const AnalisePedagogicaService = require('./AnalisePedagogicaService');
const GamificationService = require('./GamificationService');

const getExplicacaoPersonalizada = (questao, acertou, respostaDada) => {
    if (acertou) return questao.explicacao || "Parabéns, resposta correta!";
    const distratorKey = `distrator_${respostaDada.toLowerCase()}`;
    return questao[distratorKey] || questao.explicacao || "Tente analisar a questão novamente.";
};

const TrilhaService = {

    async gerarTrilhaDaTentativa({ alunoId, tentativaId }) {
        await pool.query('START TRANSACTION');
        try {
            const [respostasErradas] = await pool.query(
                'SELECT DISTINCT q.habilidade_id FROM respostas_teste rt JOIN questoes q ON rt.questao_id = q.id WHERE rt.tentativa_id = ? AND rt.acertou = 0 AND q.habilidade_id IS NOT NULL',
                [tentativaId]
            );

            if (respostasErradas.length > 0) {
                const [trilha] = await pool.query(
                    "INSERT INTO trilhas (aluno_id, tipo, status, tentativa_origem_id) VALUES (?, 'diagnostico', 'ativa', ?)",
                    [alunoId, tentativaId]
                );
                const trilhaId = trilha.insertId;
                let ordemCounter = 1;

                for (const { habilidade_id } of respostasErradas) {
                    await AnalisePedagogicaService.reforcarHabilidade(pool, alunoId, habilidade_id, trilhaId, ordemCounter);
                    ordemCounter += 2; // Assumindo que reforçar adiciona 2 itens
                }
            }
            await pool.query('UPDATE tentativas_teste SET trilha_gerada = 1 WHERE id = ?', [tentativaId]);
            await pool.query('COMMIT');
        } catch (error) {
            await pool.query('ROLLBACK');
            console.error('Erro ao gerar trilha da tentativa:', error);
            throw error;
        }
    },

    async iniciarTrilhaParaAluno(alunoId) {
        const [diagnosticoPendente] = await pool.query(
            'SELECT id FROM tentativas_teste WHERE aluno_id = ? AND tipo = \'diagnostico\' AND trilha_gerada = 0 ORDER BY criado_em DESC LIMIT 1',
            [alunoId]
        );

        if (diagnosticoPendente.length > 0) {
            await this.gerarTrilhaDaTentativa({ alunoId, tentativaId: diagnosticoPendente[0].id });
        }

        const [activeTrilha] = await pool.query(
            "SELECT id FROM trilhas WHERE aluno_id = ? AND status = 'ativa' ORDER BY criado_em DESC LIMIT 1",
            [alunoId]
        );

        if (activeTrilha.length > 0) {
            const trilhaId = activeTrilha[0].id;
            const [itens] = await pool.query(
                `SELECT q.*, ti.id as item_id FROM trilha_itens ti JOIN questoes q ON ti.questao_id = q.id WHERE ti.trilha_id = ? AND ti.status = 'pendente' ORDER BY ti.ordem ASC LIMIT 1`,
                [trilhaId]
            );

            if (itens.length === 0) {
                await pool.query("UPDATE trilhas SET status = 'concluida' WHERE id = ?", [trilhaId]);
                return { tarefaTipo: 'CONCLUIDO' };
            }
            return { tarefaTipo: 'DIAGNOSTICO', proximaQuestao: itens[0] };
        }

        const proximaTarefa = await MotorAdaptativoService.selecionarProximaQuestao(alunoId);
        return proximaTarefa || { tarefaTipo: 'CONCLUIDO' };
    },

    async processarRespostaEProximaQuestao(alunoId, itemId, respostaDada, tempoResposta) {
        const [rows] = await pool.query(
            `SELECT ti.id, ti.questao_id, q.habilidade_id, q.resposta, q.explicacao, q.distrator_a, q.distrator_b, q.distrator_c, q.distrator_d FROM trilha_itens ti JOIN questoes q ON ti.questao_id = q.id WHERE ti.id = ?`,
            [itemId]
        );
        
        if (rows.length === 0) throw new Error('Item da trilha não encontrado.');
        const item = rows[0];

        const acertou = respostaDada.toLowerCase() === item.resposta.toLowerCase();
        await pool.query("UPDATE trilha_itens SET status = 'concluido', resposta_aluno = ?, acertou = ?, concluido_em = NOW() WHERE id = ?", [respostaDada, acertou, itemId]);

        if (item.habilidade_id) {
            AnalisePedagogicaService.analisarAposResposta(alunoId, item.habilidade_id, item.questao_id, { acertou, tempo_resposta_seg: tempoResposta }).catch(console.error);
        }

        const gamificationResult = await GamificationService.registrarResultado(alunoId, acertou);
        const feedback = {
            acertou,
            gabarito: item.resposta,
            explicacao: getExplicacaoPersonalizada(item, acertou, respostaDada),
            ...gamificationResult
        };
        
        const proximaTarefa = await this.iniciarTrilhaParaAluno(alunoId);
        return { feedback, proximaTarefa };
    },

    gerarDicaComBaseEmMotivos(motivos) {
        if (motivos.includes('Sequência de erros recentes na habilidade')) {
            return "Opa, parece que este tópico está um pouco difícil. Respire fundo e vamos tentar de novo, com atenção redobrada!";
        }
        if (motivos.includes('Baixo domínio na habilidade')) {
            return "Lembre-se de revisar os conceitos básicos desta habilidade antes de responder. Você consegue!";
        }
        return "Atenção aos detalhes nesta questão! Uma leitura cuidadosa faz toda a diferença.";
    }
};

module.exports = TrilhaService;
