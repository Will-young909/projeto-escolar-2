const HistoricoQuestoesModel = require('../models/HistoricoQuestoesModel');
const QuestaoModel = require('../models/QuestaoModel');
const HabilidadeModel = require('../models/HabilidadeModel');
const MotorAdaptativoService = require('./MotorAdaptativoService');
const AnalisePedagogicaService = require('./AnalisePedagogicaService');
const RevisaoService = require('./RevisaoService');
const GamificationService = require('./GamificationService');
const pool = require('../../config/pool');

const CHANCE_DE_ERRO_THRESHOLD_PARA_DICA = 65;

// Função auxiliar para fornecer feedback com base no erro específico (distrator)
const getExplicacaoPersonalizada = (questao, acertou, respostaDada) => {
    if (acertou) {
        return questao.explicacao || "Parabéns, resposta correta!";
    }

    const distratorKey = `distrator_${respostaDada.toLowerCase()}`;
    // Retorna a explicação do distrator, se existir; senão, a explicação geral.
    return questao[distratorKey] || questao.explicacao || "Tente analisar a questão novamente, você está quase lá.";
};

const TrilhaService = {

    async gerarTrilhaDaTentativa({ alunoId, tentativaId }) {
        const connection = await pool.query('START TRANSACTION');
        try {
            const [respostasErradas] = await pool.query(
                'SELECT DISTINCT q.habilidade_id FROM respostas_teste rt JOIN questoes q ON rt.questao_id = q.id WHERE rt.tentativa_id = ? AND rt.acertou = 0',
                [tentativaId]
            );

            if (respostasErradas.length === 0) {
                console.log(`[Trilha Service] Nenhuma habilidade com erro para o aluno ${alunoId} na tentativa ${tentativaId}. Trilha não gerada.`);
                await pool.query('COMMIT');
                return;
            }

            const [trilha] = await pool.query(
                "INSERT INTO trilhas (aluno_id, tipo, status, tentativa_origem_id, pontuacao_diagnostico) SELECT ?, 'diagnostico', 'ativa', id, pontuacao_total FROM tentativas_teste WHERE id = ?",
                [alunoId, tentativaId]
            );
            const trilhaId = trilha.insertId;
            let ordemCounter = 1;

            for (const { habilidade_id } of respostasErradas) {
                const [sessaoResult] = await pool.query(
                    'INSERT INTO sessoes_adaptativas (aluno_id, habilidade_foco_id, tipo_sessao) VALUES (?, ?, ?)',
                    [alunoId, habilidade_id, 'reforco']
                );
                const sessaoId = sessaoResult.insertId;

                const dificuldade = 'facil';
                const [questoes] = await pool.query(
                    'SELECT id FROM questoes WHERE habilidade_id = ? AND dificuldade = ? ORDER BY RAND() LIMIT 2',
                    [habilidade_id, dificuldade]
                );

                for (const questao of questoes) {
                    await pool.query(
                        'INSERT INTO trilha_itens (trilha_id, sessao_id, questao_id, status, ordem, bloco) VALUES (?, ?, ?, ?, ?, ?)',
                        [trilhaId, sessaoId, questao.id, 'pendente', ordemCounter, 'revisao']
                    );
                    ordemCounter++;
                }
            }

            console.log(`[Trilha Service] Trilha ${trilhaId} gerada com ${ordemCounter - 1} itens para o aluno ${alunoId}.`);
            await pool.query('COMMIT');
        } catch (error) {
            await pool.query('ROLLBACK');
            console.error('Erro ao gerar trilha da tentativa:', error);
            throw error;
        }
    },

    async iniciarTrilhaParaAluno(alunoId) {
        try {
            const intervencao = await AnalisePedagogicaService.verificarIntervencaoNecessaria(alunoId);

            if (intervencao.necessitaIntervencao) {
                console.log(`[Trilha Service] Intervenção para Aluno ${alunoId} no pré-requisito ${intervencao.prerequisitoId}`);
                
                const [conteudosApoio] = await pool.query(
                    `SELECT ca.* 
                     FROM conteudos_apoio ca
                     JOIN prerequisito_conteudos_apoio pca ON ca.id = pca.conteudo_id
                     WHERE pca.prerequisito_id = ?
                       AND ca.id NOT IN (SELECT conteudo_id FROM aluno_conteudo_consumido WHERE aluno_id = ?)
                     ORDER BY RAND() 
                     LIMIT 1`,
                    [intervencao.prerequisitoId, alunoId]
                );

                if (conteudosApoio.length > 0) {
                    const conteudo = conteudosApoio[0];
                    const tarefaTipo = `${conteudo.tipo.toUpperCase()}_APOIO`;
                    console.log(`[Trilha Service] Oferecendo conteúdo de apoio (${tarefaTipo}) ID ${conteudo.id}`);
                    return {
                        tarefaTipo: tarefaTipo,
                        proximoConteudo: conteudo
                    };
                }

                const [questoesNivelamento] = await pool.query(
                    `SELECT q.* 
                     FROM questoes q
                     JOIN questoes_prerequisitos qp ON q.id = qp.questao_id
                     WHERE qp.prerequisito_id = ? AND q.dificuldade = 'facil'
                       AND q.id NOT IN (SELECT questao_id FROM historico_questoes WHERE aluno_id = ?)
                     ORDER BY RAND() 
                     LIMIT 1`,
                    [intervencao.prerequisitoId, alunoId]
                );

                if (questoesNivelamento.length > 0) {
                    console.log(`[Trilha Service] Questão de nivelamento ${questoesNivelamento[0].id} selecionada.`);
                    return {
                        tarefaTipo: 'NIVELAMENTO',
                        proximaQuestao: questoesNivelamento[0]
                    };
                }
                console.warn(`[Trilha Service] Nenhuma intervenção encontrada. Prosseguindo com a trilha normal.`);
            }

            const [activeTrilha] = await pool.query(
                "SELECT id FROM trilhas WHERE aluno_id = ? AND status = 'ativa' AND tipo = 'diagnostico' ORDER BY criado_em DESC LIMIT 1",
                [alunoId]
            );

            if (activeTrilha.length > 0) {
                const trilhaId = activeTrilha[0].id;
                const [itens] = await pool.query(
                    `SELECT q.*, ti.id as item_id 
                     FROM trilha_itens ti 
                     JOIN questoes q ON ti.questao_id = q.id 
                     WHERE ti.trilha_id = ? AND ti.status = 'pendente' 
                     ORDER BY ti.ordem ASC LIMIT 1`,
                    [trilhaId]
                );

                if (itens.length === 0) {
                    await pool.query("UPDATE trilhas SET status = 'concluida' WHERE id = ?", [trilhaId]);
                    return { tarefaTipo: 'CONCLUIDO', proximaQuestao: null };
                }

                return {
                    tarefaTipo: 'DIAGNOSTICO',
                    proximaQuestao: itens[0]
                };
            }

            const proximaTarefa = await MotorAdaptativoService.selecionarProximaQuestao(alunoId);

            if (!proximaTarefa || !proximaTarefa.questao) {
                return { tarefaTipo: 'CONCLUIDO', proximaQuestao: null };
            }

            return { 
                tarefaTipo: proximaTarefa.tipo,
                proximaQuestao: proximaTarefa.questao
            };

        } catch (error) {
            console.error('Erro ao iniciar a trilha do aluno:', error);
            throw error;
        }
    },

    async marcarConteudoComoConsumido(alunoId, conteudoId) {
        try {
            await pool.query(
                'INSERT IGNORE INTO aluno_conteudo_consumido (aluno_id, conteudo_id) VALUES (?, ?)',
                [alunoId, conteudoId]
            );
            console.log(`[Trilha Service] Conteúdo ${conteudoId} marcado como consumido para o aluno ${alunoId}`);
            return { success: true };
        } catch (error) {
            console.error('Erro ao marcar conteúdo como consumido:', error);
            return { success: false, error: error.message };
        }
    },

    async processarRespostaEProximaQuestao(alunoId, submittedId, respostaDada, tempoResposta) {
        let feedback = {};
        try {
            let questaoProcessada;
            let habilidadeId;

            const [activeItem] = await pool.query(
                `SELECT ti.id, ti.questao_id, q.habilidade_id, q.resposta, q.explicacao, q.distrator_a, q.distrator_b, q.distrator_c, q.distrator_d
                 FROM trilha_itens ti JOIN trilhas t ON ti.trilha_id = t.id JOIN questoes q ON ti.questao_id = q.id
                 WHERE ti.id = ? AND t.aluno_id = ? AND ti.status = 'pendente'`,
                [submittedId, alunoId]
            );

            if (activeItem.length > 0) {
                const item = activeItem[0];
                questaoProcessada = item;
                habilidadeId = item.habilidade_id;
                const acertou = respostaDada.toLowerCase() === item.resposta.toLowerCase();
                await pool.query("UPDATE trilha_itens SET status = 'concluido', resposta_aluno = ?, acertou = ?, concluido_em = NOW() WHERE id = ?", [respostaDada, acertou, item.id]);
                
                if (habilidadeId) {
                    HistoricoQuestoesModel.create({ alunoId, questaoId: item.questao_id, habilidadeId, respostaDada, acertou, tempoResposta }).catch(console.error);
                    AnalisePedagogicaService.analisarAposResposta(alunoId, habilidadeId, item.questao_id, { acertou, tempo_resposta_seg: tempoResposta }).catch(console.error);
                }

                const gamificationResult = await GamificationService.registrarResultado(alunoId, acertou);
                const explicacaoPersonalizada = getExplicacaoPersonalizada(item, acertou, respostaDada);
                feedback = { acertou, gabarito: item.resposta, explicacao: explicacaoPersonalizada, ...gamificationResult };
            } else {
                const questao = await QuestaoModel.findById(submittedId);
                if (!questao) {
                    return { acertou: false, jaRespondido: true };
                }
                questaoProcessada = questao;
                habilidadeId = questao.habilidade_id;
                const acertou = questao.resposta.toLowerCase() === respostaDada.toLowerCase();

                if (habilidadeId) {
                    HistoricoQuestoesModel.create({ alunoId, questaoId: submittedId, habilidadeId, respostaDada, acertou, tempoResposta }).catch(console.error);
                    AnalisePedagogicaService.analisarAposResposta(alunoId, habilidadeId, submittedId, { acertou, tempo_resposta_seg: tempoResposta }).catch(console.error);
                    RevisaoService.agendarProximaRevisao(alunoId, submittedId, acertou).catch(console.error);
                    MotorAdaptativoService.atualizarProficiencia(alunoId, habilidadeId, acertou).catch(console.error);
                }
                
                const gamificationResult = await GamificationService.registrarResultado(alunoId, acertou);
                const explicacaoPersonalizada = getExplicacaoPersonalizada(questao, acertou, respostaDada);
                feedback = { acertou, gabarito: questao.resposta, explicacao: explicacaoPersonalizada, ...gamificationResult };
            }

            const proximaTarefa = await this.iniciarTrilhaParaAluno(alunoId);

            return {
                feedback,
                proximaTarefa
            };
    
        } catch (error) {
            console.error('Erro ao processar resposta e selecionar próxima questão:', error);
            throw error;
        }
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
