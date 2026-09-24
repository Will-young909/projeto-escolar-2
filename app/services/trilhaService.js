const pool = require('../../config/pool');
const MotorAdaptativoService = require('./MotorAdaptativoService');
const AnalisePedagogicaService = require('./AnalisePedagogicaService');
const GamificationService = require('./GamificationService');
const RevisaoService = require('./RevisaoService');
const C = require('../constants/trilha');
const { normalizeForComparison, feedbackFor } = require('../utils/trilhaHelpers');

const TrilhaService = {
  async gerarTrilhaDaTentativa({ alunoId, tentativaId }) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [already] = await connection.query('SELECT id FROM trilhas WHERE tentativa_origem_id = ? AND aluno_id = ? LIMIT 1', [tentativaId, alunoId]);
      if (already[0]) { await connection.commit(); return already[0].id; }
      const [attemptRows] = await connection.query('SELECT pontuacao_total FROM tentativas_teste WHERE id = ? AND aluno_id = ? FOR UPDATE', [tentativaId, alunoId]);
      if (!attemptRows[0]) throw new Error('Diagnóstico não encontrado para este aluno.');
      const [trilha] = await connection.query(`INSERT INTO trilhas (aluno_id, tipo, status, tentativa_origem_id, pontuacao_diagnostico, nome)
        VALUES (?, ?, ?, ?, ?, 'Trilha adaptativa de matemática')`, [alunoId, C.TRILHA_TIPOS.DIAGNOSTICO, C.TRILHA_STATUS.ATIVA, tentativaId, attemptRows[0].pontuacao_total]);
      const trilhaId = trilha.insertId;
      const [results] = await connection.query(`SELECT q.habilidade_id, SUM(rt.acertou = 1) AS acertos, SUM(rt.acertou = 0) AS erros
        FROM respostas_teste rt
        JOIN questoes q ON q.id = rt.questao_id
        JOIN tentativas_teste tt ON rt.tentativa_id = tt.id
        WHERE rt.tentativa_id = ? AND tt.aluno_id = ? AND q.habilidade_id IS NOT NULL GROUP BY q.habilidade_id`, [tentativaId, alunoId]);
      for (const result of results) {
        const total = Number(result.acertos) + Number(result.erros);
        const percentage = total ? (Number(result.acertos) / total) * 100 : 0;
        const status = percentage < 50 ? C.DOMINIO_STATUS.PRECISA_REFORCO : percentage < 70 ? C.DOMINIO_STATUS.EM_DESENVOLVIMENTO : percentage < 85 ? C.DOMINIO_STATUS.PROFICIENTE : C.DOMINIO_STATUS.EM_DESENVOLVIMENTO;
        await connection.query(`INSERT INTO usuario_habilidades (aluno_id, habilidade_id, percentual_dominio, status_dominio, n_tentativas, n_acertos_consecutivos, n_erros_consecutivos)
          VALUES (?, ?, ?, ?, ?, 0, 0) ON DUPLICATE KEY UPDATE percentual_dominio = VALUES(percentual_dominio), status_dominio = VALUES(status_dominio), n_tentativas = n_tentativas + VALUES(n_tentativas)`,
          [alunoId, result.habilidade_id, percentage, status, total]);
      }
      await connection.query('UPDATE tentativas_teste SET trilha_gerada = 1 WHERE id = ? AND aluno_id = ?', [tentativaId, alunoId]);
      await connection.commit();
      return trilhaId;
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  },

  async obterOuCriarTrilhaAtiva(alunoId) {
    const [active] = await pool.query("SELECT * FROM trilhas WHERE aluno_id = ? AND status = ? ORDER BY atualizado_em DESC LIMIT 1", [alunoId, C.TRILHA_STATUS.ATIVA]);
    if (active[0]) return active[0];
    const [diagnostic] = await pool.query("SELECT id FROM tentativas_teste WHERE aluno_id = ? AND tipo = ? AND trilha_gerada = 0 ORDER BY criado_em DESC LIMIT 1", [alunoId, C.TRILHA_TIPOS.DIAGNOSTICO]);
    if (diagnostic[0]) {
      const id = await this.gerarTrilhaDaTentativa({ alunoId, tentativaId: diagnostic[0].id });
      const [created] = await pool.query('SELECT * FROM trilhas WHERE id = ? AND aluno_id = ?', [id, alunoId]);
      return created[0];
    }
    const [created] = await pool.query("INSERT INTO trilhas (aluno_id, tipo, status, nome) VALUES (?, ?, ?, 'Trilha adaptativa de matemática')", [alunoId, C.TRILHA_TIPOS.APRENDIZAGEM, C.TRILHA_STATUS.ATIVA]);
    return { id: created.insertId, aluno_id: alunoId };
  },

  async criarItemDaDecisao(trilha, alunoId, item, decisao, sessao = null) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const tipoSessao = decisao.etapa === C.ITEM_BLOCO.REFORCO ? C.SESSAO_TIPO.REFORCO : decisao.etapa === C.TRILHA_TIPOS.DIAGNOSTICO ? C.SESSAO_TIPO.AVALIACAO : C.SESSAO_TIPO.PRATICA;
      const sessaoId = sessao ? sessao.id : null;
      let session = sessao;
      if (!session) {
        const [newSession] = await connection.query(`INSERT INTO sessoes_adaptativas (aluno_id, habilidade_foco_id, tipo_sessao)
          VALUES (?, ?, ?)`, [alunoId, item.habilidade_id, tipoSessao]);
        session = { id: newSession.insertId, aluno_id: alunoId, habilidade_foco_id: item.habilidade_id, tipo_sessao: tipoSessao };
      }
      const [order] = await connection.query('SELECT COALESCE(MAX(ordem), 0) + 1 AS nextOrder FROM trilha_itens WHERE trilha_id = ?', [trilha.id]);

      const atividadeTipo = item.material_id ? 'material' : 'questao';
      const [result] = await connection.query(`INSERT INTO trilha_itens (sessao_id, trilha_id, ordem, questao_id, material_aprendizagem_id, bloco, decisao_motor, atividade_tipo, meta_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        session.id, trilha.id, order[0].nextOrder, item.questao_id || null, item.material_id || null,
        decisao.etapa, decisao.action, atividadeTipo,
        JSON.stringify({ origem: 'atividade_dinamica', habilidade_id: item.habilidade_id, dificuldade: item.dificuldade || null })
      ]);

      await connection.query(`INSERT INTO trilha_decisoes (trilha_id, aluno_id, habilidade_id, acao, etapa, dificuldade, motivo, contexto_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [trilha.id, alunoId, item.habilidade_id, decisao.action, decisao.etapa, item.dificuldade, decisao.reason, JSON.stringify({ percentual: decisao.mastery?.percentual ?? null, sessao_id: session.id })]);
      await connection.query('UPDATE trilhas SET habilidade_atual_id = ? WHERE id = ? AND aluno_id = ?', [item.habilidade_id, trilha.id, alunoId]);
      await connection.commit();
      return { ...result, sessao_id: session.id };
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  },

  async encerrarSessaoAtividade(sessaoId, statusTermino = null) {
    const connection = await pool.getConnection();
    try {
      try {
        await connection.query(`UPDATE sessoes_adaptativas SET status = ?, status_termino = ?, fim_em = NOW() WHERE id = ?`, [C.SESSAO_STATUS.CONCLUIDA, statusTermino, sessaoId]);
      } catch (error) {
        await connection.query(`UPDATE sessoes_adaptativas SET status = ? WHERE id = ?`, [C.SESSAO_STATUS.CONCLUIDA, sessaoId]);
      }
    } finally { connection.release(); }
  },

  async iniciarTrilhaParaAluno(alunoId) {
    const trilha = await this.obterOuCriarTrilhaAtiva(alunoId);
    const [pending] = await pool.query(`SELECT ti.id AS item_id, ti.bloco, ti.decisao_motor, q.*, h.descricao AS habilidade_nome,
      ma.id AS material_id, ma.titulo AS material_titulo, ma.descricao AS material_descricao, ma.url AS material_url, ma.tipo AS material_tipo
      FROM trilha_itens ti
      LEFT JOIN questoes q ON q.id = ti.questao_id
      LEFT JOIN materiais_aprendizagem ma ON ma.id = ti.material_aprendizagem_id
      LEFT JOIN habilidades h ON h.id = q.habilidade_id OR h.id = ma.habilidade_id
      WHERE ti.trilha_id = ? AND ti.status = ? ORDER BY ti.ordem ASC LIMIT 1`, [trilha.id, C.ITEM_STATUS.PENDENTE]);
    if (pending[0]) {
        if (pending[0].material_id) {
            return this.formatarTarefaMaterial(pending[0], trilha.id, pending[0].bloco);
        }
        return { tarefaTipo: pending[0].bloco === C.ITEM_BLOCO.REVISAO ? 'REVISAO' : 'QUESTAO', proximaQuestao: pending[0], trilhaId: trilha.id, etapa: pending[0].bloco };
    }

    const dueQuestionId = await RevisaoService.getQuestaoParaRevisar(alunoId);
    if (dueQuestionId) {
      const [review] = await pool.query(`SELECT q.*, h.descricao AS habilidade_nome FROM questoes q LEFT JOIN habilidades h ON h.id = q.habilidade_id WHERE q.id = ?`, [dueQuestionId]);
      if (review[0]) {
        const itemId = await this.criarItemDaDecisao(trilha, alunoId, { questao_id: review[0].id, habilidade_id: review[0].habilidade_id, dificuldade: review[0].dificuldade }, { action: C.DECISAO_ACAO.REVISAO, etapa: C.ITEM_BLOCO.REVISAO, reason: 'revisao_pendente' });
        return { tarefaTipo: 'REVISAO', proximaQuestao: { ...review[0], item_id: itemId }, trilhaId: trilha.id, etapa: C.ITEM_BLOCO.REVISAO };
      }
    }
    const next = await MotorAdaptativoService.selecionarProximaQuestao(alunoId);
    if (!next) {
      await pool.query("UPDATE trilhas SET status = ? WHERE id = ? AND aluno_id = ?", [C.TRILHA_STATUS.CONCLUIDA, trilha.id, alunoId]);
      return { tarefaTipo: 'CONCLUIDO', trilhaId: trilha.id };
    }

    if (next.material) {
      const itemId = await this.criarItemDaDecisao(trilha, alunoId, { material_id: next.material.id, habilidade_id: next.decisao.skillId }, next.decisao, next.sessao);
      return this.formatarTarefaMaterial({
        item_id: itemId,
        material_id: next.material.id,
        material_titulo: next.material.titulo,
        material_descricao: next.material.descricao,
        material_url: next.material.url,
        material_tipo: next.material.tipo
      }, trilha.id, next.decisao.etapa);
    }

    const itemId = await this.criarItemDaDecisao(trilha, alunoId, { questao_id: next.questao.id, habilidade_id: next.questao.habilidade_id, dificuldade: next.questao.dificuldade }, next.decisao, next.sessao);
    return { tarefaTipo: 'QUESTAO', proximaQuestao: { ...next.questao, item_id: itemId }, trilhaId: trilha.id, etapa: next.decisao.etapa, dificuldade: next.questao.dificuldade, sessao_id: next.sessao?.id };
  },

  async processarRespostaEProximaQuestao(alunoId, itemId, respostaDada, tempoResposta = null) {
    const connection = await pool.getConnection();
    let result;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query(`SELECT ti.*, t.aluno_id, q.habilidade_id, q.resposta, q.explicacao, q.distrator_a, q.distrator_b, q.distrator_c, q.distrator_d, q.dificuldade
        FROM trilha_itens ti JOIN trilhas t ON t.id = ti.trilha_id JOIN questoes q ON q.id = ti.questao_id WHERE ti.id = ? AND t.aluno_id = ? FOR UPDATE`, [itemId, alunoId]);
      const item = rows[0];
      if (!item) throw new Error('Item da trilha não encontrado para este aluno.');
      if (item.status !== C.ITEM_STATUS.PENDENTE) throw new Error('Esta resposta já foi registrada.');
      const acertou = normalizeForComparison(respostaDada) === normalizeForComparison(item.resposta);
      await connection.query(`UPDATE trilha_itens SET status = ?, resposta_aluno = ?, acertou = ?, concluido_em = NOW() WHERE id = ?`, [C.ITEM_STATUS.CONCLUIDO, String(respostaDada), acertou, itemId]);
      if (item.habilidade_id) await connection.query(`INSERT INTO historico_questoes (aluno_id, questao_id, habilidade_id, resposta_dada, acertou, tempo_resposta_seg)
        VALUES (?, ?, ?, ?, ?, ?)`, [alunoId, item.questao_id, item.habilidade_id, String(respostaDada), acertou, tempoResposta]);
      await connection.commit();
      result = { item, acertou };
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    const mastery = result.item.habilidade_id ? await MotorAdaptativoService.atualizarProficiencia(alunoId, result.item.habilidade_id) : null;
    await RevisaoService.agendarProximaRevisao(alunoId, result.item.questao_id, result.acertou);
    if (result.item.habilidade_id) await AnalisePedagogicaService.analisarAposResposta(alunoId, result.item.habilidade_id, result.item.questao_id, { acertou: result.acertou, tempo_resposta_seg: tempoResposta });
    const gamification = await GamificationService.registrarResultado(alunoId, result.acertou);

    const deveEncerrarPorEvidencia = mastery?.atividadeConcluida || mastery?.status === C.DOMINIO_STATUS.DOMINADA;
    if (deveEncerrarPorEvidencia && result.item.sessao_id) {
      await this.encerrarSessaoAtividade(result.item.sessao_id, mastery.status);
    }
    const proximaTarefa = await this.iniciarTrilhaParaAluno(alunoId);
    const deveEncerrarAtividade = !deveEncerrarPorEvidencia && proximaTarefa.etapa !== result.item.bloco && result.item.sessao_id;
    if (deveEncerrarAtividade) {
      await this.encerrarSessaoAtividade(result.item.sessao_id, mastery?.status || 'concluida');
    }

    return {
      feedback: { acertou: result.acertou, gabarito: normalizeForComparison(result.item.resposta), explicacao: feedbackFor(result.item, result.acertou, respostaDada), habilidadeReforcada: mastery?.status === C.DOMINIO_STATUS.PRECISA_REFORCO, ...gamification },
      proximaTarefa
    };
  },

  async marcarConteudoConsumido(alunoId, itemId, tempoConsumido = null) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query(`SELECT ti.*, t.aluno_id, ti.material_aprendizagem_id FROM trilha_itens ti JOIN trilhas t ON t.id = ti.trilha_id WHERE ti.id = ? AND t.aluno_id = ? FOR UPDATE`, [itemId, alunoId]);
      if (rows.length === 0) throw new Error('Item da trilha não encontrado.');
      if (rows[0].status !== C.ITEM_STATUS.PENDENTE) throw new Error('Conteúdo já marcado como consumido.');

      await connection.query('UPDATE trilha_itens SET status = ?, concluido_em = NOW() WHERE id = ?', [C.ITEM_STATUS.CONCLUIDO, itemId]);
      
      const materialItem = rows[0];
      if (materialItem.material_aprendizagem_id) {
        const [microcheck] = await connection.query(`SELECT q.*, h.descricao AS habilidade_nome FROM questoes q JOIN habilidades h ON h.id = q.habilidade_id
          WHERE q.habilidade_id = (SELECT habilidade_id FROM materiais_aprendizagem WHERE id = ?)
          AND NOT EXISTS (SELECT 1 FROM historico_questoes hq WHERE hq.aluno_id = ? AND hq.questao_id = q.id)
          AND NOT EXISTS (
            SELECT 1 FROM respostas_teste rt JOIN tentativas_teste tt ON tt.id = rt.tentativa_id
            WHERE tt.aluno_id = ? AND rt.questao_id = q.id
          )
          ORDER BY q.id ASC LIMIT 1`, [materialItem.material_aprendizagem_id, alunoId, alunoId]);
        if (microcheck[0]) {
          const [session] = await connection.query(`INSERT INTO sessoes_adaptativas (aluno_id, habilidade_foco_id, tipo_sessao)
            VALUES (?, ?, ?)`, [alunoId, microcheck[0].habilidade_id, C.SESSAO_TIPO.PRATICA]);
          const [order] = await connection.query('SELECT COALESCE(MAX(ordem), 0) + 1 AS nextOrder FROM trilha_itens WHERE trilha_id = ?', [materialItem.trilha_id]);
          const [result] = await connection.query(`INSERT INTO trilha_itens (sessao_id, trilha_id, ordem, questao_id, bloco, decisao_motor)
            VALUES (?, ?, ?, ?, ?, ?)`, [session.insertId, materialItem.trilha_id, order[0].nextOrder, microcheck[0].id, C.ITEM_BLOCO.CHECKPOINT, 'microcheck_pos_consumo']);
          await connection.query(`INSERT INTO trilha_decisoes (trilha_id, aluno_id, habilidade_id, acao, etapa, dificuldade, motivo, contexto_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [materialItem.trilha_id, alunoId, microcheck[0].habilidade_id, C.DECISAO_ACAO.PRATICAR, C.ITEM_BLOCO.CHECKPOINT, microcheck[0].dificuldade, 'microcheck_consumo', JSON.stringify({ item_pai_id: itemId, tempo_consumo_seg: tempoConsumido })]);
          await connection.commit();
          return { tarefaTipo: 'MICROCHECK', proximaQuestao: { ...microcheck[0], item_id: result.insertId }, trilhaId: materialItem.trilha_id, etapa: C.ITEM_BLOCO.CHECKPOINT };
        }
      }
      await connection.commit();
      return await this.iniciarTrilhaParaAluno(alunoId);
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  },

  formatarTarefaMaterial(material, trilhaId, etapa = C.ITEM_BLOCO.APRENDIZAGEM) {
    const proximoConteudo = {
      id: material.material_id,
      item_id: material.item_id,
      titulo: material.material_titulo,
      descricao: material.material_descricao,
      tipo: material.material_tipo,
      url_ou_conteudo: material.material_url
    };
    return {
      tarefaTipo: material.material_tipo === 'video' ? 'VIDEO_APOIO' : 'ARTIGO_APOIO',
      proximoConteudo,
      trilhaId,
      etapa
    };
  },

  async obterProgresso(alunoId) {
    const [trilha] = await pool.query("SELECT * FROM trilhas WHERE aluno_id = ? AND status = ? ORDER BY atualizado_em DESC LIMIT 1", [alunoId, C.TRILHA_STATUS.ATIVA]);
    const [reviews] = await pool.query('SELECT COUNT(*) AS pendentes FROM revisao_agendada WHERE aluno_id = ? AND data_revisao <= CURDATE()', [alunoId]);
    const [skills] = await pool.query(`SELECT h.id AS habilidade_id, h.descricao AS habilidade_nome,
      COALESCE(uh.percentual_dominio, 0) AS percentual_dominio, COALESCE(uh.status_dominio, ?) AS status_dominio
      FROM habilidades h LEFT JOIN usuario_habilidades uh ON uh.habilidade_id = h.id AND uh.aluno_id = ?`,
      [C.DOMINIO_STATUS.NAO_INICIADO, alunoId]);
    const totalSkills = skills.length;
    const mastered = skills.filter(s => s.status_dominio === C.DOMINIO_STATUS.DOMINADO || s.status_dominio === C.DOMINIO_STATUS.DOMINADA).length;
    const needsReinforcement = skills.filter(s => s.status_dominio === C.DOMINIO_STATUS.PRECISA_REFORCO || s.status_dominio === C.DOMINIO_STATUS.REFORCO).length;
    const progressoGeral = totalSkills > 0 ? Number(((mastered / totalSkills) * 100).toFixed(1)) : 0;
    return {
      trilha,
      progressoGeral,
      totalSkills,
      mastered,
      needsReinforcement,
      habilidades: skills,
      revisoesPendentes: reviews[0].pendentes
    };
  }
};

module.exports = TrilhaService;
