const pool = require('../../config/pool');
const MotorAdaptativoService = require('./MotorAdaptativoService');
const AnalisePedagogicaService = require('./AnalisePedagogicaService');
const GamificationService = require('./GamificationService');
const RevisaoService = require('./RevisaoService');
const ResultadoHabilidadeService = require('./ResultadoHabilidadeService');
const CurriculoAlunoModel = require('../models/CurriculoAlunoModel');
const C = require('../constants/trilha');
const Engine = require('./AdaptiveTrailEngine');
const { normalizeForComparison, feedbackFor, planoReforcoLegible, anoDoNivel } = require('../utils/trilhaHelpers');

/**
 * `meta_json` é JSON nullable e pode conter lixo de gravações antigas. Uma
 * leitura que estoura aqui derrubaria a tela da trilha inteira, então falha silenciosa.
 */
const safeParseJSON = (bruto) => {
  try { return JSON.parse(bruto); } catch { return {}; }
};

const TrilhaService = {
  /**
   * Grava o currículo do aluno a partir das habilidades do diagnóstico.
   *
   * Sem isso, `selecionarProximaQuestao` não tem como filtrar por série: ele
   * consideraria TODAS as habilidades do banco e a ordenação cairia no menor
   * `id` — um aluno de 1º ano do médio acabava recebendo soma de números
   * naturais. `habilidades.ano_escolar` não serve de filtro: além de ser NULL
   * na prática, é coluna de uma tabela GLOBAL, que não representa "a série" de
   * nada (ver o comentário em `ensureActivityPersisted`).
   *
   * As habilidades do diagnóstico são exatamente o conteúdo que a IA gerou
   * para aquele ano, então elas são a melhor fonte de verdade disponível.
   */
  async sincronizarCurriculoDoDiagnostico(alunoId, tentativaId, nivelEscolar = null) {
    const [rows] = await pool.query(
      `SELECT DISTINCT q.habilidade_id
       FROM respostas_teste rt JOIN questoes q ON q.id = rt.questao_id
       WHERE rt.tentativa_id = ? AND q.habilidade_id IS NOT NULL
       ORDER BY q.habilidade_id ASC`,
      [tentativaId]
    );
    if (!rows.length) return { criado: false, motivo: 'diagnóstico sem habilidades' };

    const ano = anoDoNivel(nivelEscolar) || 10; // sem nível informado, assume 1º ano do médio
    const curriculo = await CurriculoAlunoModel.createOrUpdate(alunoId, {
      disciplina_id: 'MATEMATICA',
      ano_escolar: ano,
      objetivo: `Matemática — ano ${ano}`,
      versao_mapa: 'diagnostico_ia'
    });

    // Recria a lista: `ordem` respeita a ordem em que foram avaliadas.
    await pool.query('DELETE FROM habilidades_curriculo WHERE curriculo_id = ?', [curriculo.id]);
    const linhas = rows.map((row, indice) => [curriculo.id, row.habilidade_id, indice + 1, true]);
    await pool.query('INSERT INTO habilidades_curriculo (curriculo_id, habilidade_id, ordem, obrigatoria) VALUES ?', [linhas]);

    return { criado: true, curriculoId: curriculo.id, ano, habilidades: rows.length };
  },

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
        // Corrección: >=85% → proficiente o dominada (nunca em_desenvolvimento).
        const status = Engine.clasificarDiagnostico(percentage, total);
        await connection.query(`INSERT INTO usuario_habilidades (aluno_id, habilidade_id, percentual_dominio, status_dominio, n_tentativas, n_acertos_consecutivos, n_erros_consecutivos, probabilidade_dominio)
          VALUES (?, ?, ?, ?, ?, 0, 0, ?) ON DUPLICATE KEY UPDATE percentual_dominio = VALUES(percentual_dominio), status_dominio = VALUES(status_dominio),
          n_tentativas = n_tentativas + VALUES(n_tentativas), probabilidade_dominio = VALUES(probabilidade_dominio)`,
          [alunoId, result.habilidade_id, percentage, status, total, total ? percentage / 100 : 0]);
        await connection.query(`INSERT INTO trilha_decisoes (trilha_id, aluno_id, habilidade_id, acao, etapa, dificuldade, motivo, contexto_json)
          VALUES (?, ?, ?, 'diagnostico', 'diagnostico', NULL, 'diagnostico_inicial_clasificado', ?)`,
          [trilhaId, alunoId, result.habilidade_id, JSON.stringify({ acertos: Number(result.acertos), erros: Number(result.erros), percentual: Number(percentage.toFixed(2)), status })]);
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

      const [result] = await connection.query(`INSERT INTO trilha_itens (sessao_id, trilha_id, ordem, questao_id, bloco, decisao_motor, atividade_tipo, meta_json)
        VALUES (?, ?, ?, ?, ?, ?, 'questao', ?)`, [
        session.id, trilha.id, order[0].nextOrder, item.questao_id || null,
        decisao.etapa, decisao.action,
        JSON.stringify({ origem: 'atividade_dinamica', habilidade_id: item.habilidade_id, dificuldade: item.dificuldade || null })
      ]);

      await connection.query(`INSERT INTO trilha_decisoes (trilha_id, aluno_id, habilidade_id, acao, etapa, dificuldade, motivo, contexto_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [trilha.id, alunoId, item.habilidade_id, decisao.action, decisao.etapa, item.dificuldade, decisao.reason, JSON.stringify({
          percentual: decisao.mastery?.percentual ?? null,
          sessao_id: session.id,
          explicacao: decisao.explicacao ?? null,
          planReforco: decisao.planoReforco?.pasos ?? null
        })]);
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

  /**
   * Calcula a cota diária de questões para o aluno nesta trilha.
   *
   * A cota é derivada de:
   *   - revisões devidas hoje (revisao_agendada com data_revisao <= CURDATE())
   *   - 1 nova questão por habilidade ativa não dominada (habilidade_atual_id da trilha)
   *   - piso mínimo de QUESTOES_DIARIAS_MINIMO
   *
   * Reseta automaticamente à meia-noite por conta do DATE/CURDATE nas queries.
   */
  async calcularCotaDiaria(alunoId, trilhaId) {
    // Revisões devidas para hoje (ainda não apresentadas hoje).
    const dueReviews = await RevisaoService.getQuestoesParaRevisar(alunoId, C.REVISAO_LIMITE_DIARIO);

    // Habilidade ativa da trilha, se houver e não estiver dominada.
    let novasPorHabilidade = 0;
    const [trilhaRow] = await pool.query('SELECT habilidade_atual_id FROM trilhas WHERE id = ? AND aluno_id = ?', [trilhaId, alunoId]);
    const habilidadeAtual = trilhaRow[0]?.habilidade_atual_id;
    if (habilidadeAtual) {
      const [uh] = await pool.query('SELECT status_dominio FROM usuario_habilidades WHERE aluno_id = ? AND habilidade_id = ?', [alunoId, habilidadeAtual]);
      const status = uh[0] ? Engine.normalizeStatus(uh[0].status_dominio) : C.DOMINIO_STATUS.NAO_INICIADO;
      if (status !== C.DOMINIO_STATUS.DOMINADA && status !== C.DOMINIO_STATUS.PROFICIENTE) {
        novasPorHabilidade = C.QUESTOES_DIARIAS_POR_HABILIDADE;
      }
    }

    const total = Math.max(dueReviews.length + novasPorHabilidade, C.QUESTOES_DIARIAS_MINIMO);
    return { total, revisoes: dueReviews.length, novas: novasPorHabilidade };
  },

  /**
   * Conta quantas questões o aluno já concluiu HOJE nesta trilha.
   * Reseta à meia-noite via DATE(concluido_em) = CURDATE().
   */
  async contarQuestoesConcluidasHoje(alunoId, trilhaId) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS total FROM trilha_itens ti
       JOIN trilhas t ON t.id = ti.trilha_id
       WHERE ti.trilha_id = ? AND t.aluno_id = ?
         AND ti.status = ? AND DATE(ti.concluido_em) = CURDATE()`,
      [trilhaId, alunoId, C.ITEM_STATUS.CONCLUIDO]
    );
    return Number(rows[0]?.total || 0);
  },

  /**
   * Conta quantos itens (questÕes + revisÕes) jÃ¡ foram criados nesta trilha,
   * independentemente do status (pendente ou concluido). Usado para impor um
   * limite total de questÕes por trilha e evitar que ela seja infinita.
   */
  async contarItensNaTrilha(trilhaId) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS total FROM trilha_itens WHERE trilha_id = ?`,
      [trilhaId]
    );
    return Number(rows[0]?.total || 0);
  },

  async iniciarTrilhaParaAluno(alunoId) {
    const trilha = await this.obterOuCriarTrilhaAtiva(alunoId);

    // Limite total de questÕes por trilha (parada definitiva).
    // Se a trilha jÃ¡ atingiu o total mÃ¡ximo de itens, encerra definitivamente.
    const totalItens = await this.contarItensNaTrilha(trilha.id);
    if (totalItens >= C.QUESTOES_MAX_POR_TRILHA) {
      await pool.query("UPDATE trilhas SET status = ? WHERE id = ? AND aluno_id = ?", [C.TRILHA_STATUS.CONCLUIDA, trilha.id, alunoId]);
      return { tarefaTipo: 'CONCLUIDO', trilhaId: trilha.id, motivo: 'limite_total_trilha' };
    }

    const [pending] = await pool.query(`SELECT ti.id AS item_id, ti.bloco, ti.decisao_motor, q.*, h.descricao AS habilidade_nome
      FROM trilha_itens ti
      LEFT JOIN questoes q ON q.id = ti.questao_id
      LEFT JOIN habilidades h ON h.id = q.habilidade_id
      WHERE ti.trilha_id = ? AND ti.status = ? ORDER BY ti.ordem ASC LIMIT 1`, [trilha.id, C.ITEM_STATUS.PENDENTE]);
    if (pending[0]) {
        return { tarefaTipo: pending[0].bloco === C.ITEM_BLOCO.REVISAO ? 'REVISAO' : 'QUESTAO', proximaQuestao: pending[0], trilhaId: trilha.id, etapa: pending[0].bloco };
    }

    // ---- Revisión espaciada BALANCEADA ----
    // La revisión NO tiene prioridad absoluta: solo interrumpe cuando no hay un
    // objetivo de aprendizaje activo o cuando el atraso es urgente, y nunca
    // supera el tope diario/sesión.
    // Cota diária de questões: se já atingiu o total planejado para hoje
    // (revisões + novas por habilidade ativa), encerra a sessão diária.
    const cotaDiaria = await this.calcularCotaDiaria(alunoId, trilha.id);
    const questoesHoje = await this.contarQuestoesConcluidasHoje(alunoId, trilha.id);
    if (questoesHoje >= cotaDiaria.total) {
      return {
        tarefaTipo: 'COTA_DIARIA',
        trilhaId: trilha.id,
        questoesHoje,
        cotaDiaria: cotaDiaria.total,
        revisoes: cotaDiaria.revisoes,
        novas: cotaDiaria.novas
      };
    }

    // 1) Tenta criar uma questão nova primeiro (prioridade sobre revisões).
    const next = await MotorAdaptativoService.selecionarProximaQuestao(alunoId);
    if (next) {
      const explicacao = next.decisao.explicacao || Engine.explicarDecisao({ decisao: next.decisao, skill: next.habilidade });
      const itemId = await this.criarItemDaDecisao(trilha, alunoId, { questao_id: next.questao.id, habilidade_id: next.questao.habilidade_id, dificuldade: next.questao.dificuldade }, next.decisao, next.sessao);
      return {
        tarefaTipo: 'QUESTAO',
        proximaQuestao: { ...next.questao, item_id: itemId },
        trilhaId: trilha.id,
        etapa: next.decisao.etapa,
        dificuldade: next.questao.dificuldade,
        sessao_id: next.sessao?.id,
        explicacao,
        habilidade: next.questao.habilidade_nome || next.habilidade?.descricao
      };
    }

    // 2) Só oferece revisões quando não há mais questões novas disponíveis.
    const presentadasHoy = await RevisaoService.contarPresentadasHoy(alunoId);
    const dueReviews = presentadasHoy < C.REVISAO_LIMITE_DIARIO
      ? await RevisaoService.getQuestoesParaRevisar(alunoId, C.REVISAO_SESSAO_CAP)
      : [];
    if (dueReviews.length > 0) {
      const [focoRows] = await pool.query(`SELECT h.*, COALESCE(uh.percentual_dominio, 0) AS percentual_dominio,
          COALESCE(uh.status_dominio, ?) AS status_dominio
        FROM trilhas t JOIN habilidades h ON h.id = t.habilidade_atual_id
        LEFT JOIN usuario_habilidades uh ON uh.habilidade_id = h.id AND uh.aluno_id = ?
        WHERE t.id = ? AND t.aluno_id = ?`,
        [C.DOMINIO_STATUS.NAO_INICIADO, alunoId, trilha.id, alunoId]);
      const focoSkill = focoRows[0];
      const historicoFoco = focoSkill ? await MotorAdaptativoService.obterHistorico(alunoId, focoSkill.habilidade_id) : [];
      const revisaoServible = dueReviews.find(rev => Engine.shouldServeReview({ skill: focoSkill || { habilidade_id: null }, history: historicoFoco, dueReview: rev }));
      if (revisaoServible) {
        const [review] = await pool.query("SELECT q.*, h.descricao AS habilidade_nome FROM questoes q LEFT JOIN habilidades h ON h.id = q.habilidade_id WHERE q.id = ?", [revisaoServible.questao_id]);
        if (review[0]) {
          await RevisaoService.marcarPresentada(alunoId, review[0].id);
          const decisaoRevisao = {
            action: C.DECISAO_ACAO.REVISAO,
            etapa: C.ITEM_BLOCO.REVISAO,
            reason: 'revisao_pendente',
            skillId: review[0].habilidade_id,
            questaoId: review[0].id,
            atrasoDias: revisaoServible.atraso_dias,
            explicacao: Engine.explicarDecisao({ decisao: { action: 'revisao', skillId: review[0].habilidade_id, atrasoDias: revisaoServible.atraso_dias }, skill: focoSkill })
          };
          const itemId = await this.criarItemDaDecisao(trilha, alunoId, { questao_id: review[0].id, habilidade_id: review[0].habilidade_id, dificuldade: review[0].dificuldade }, decisaoRevisao);
          return { tarefaTipo: 'REVISAO', proximaQuestao: { ...review[0], item_id: itemId }, trilhaId: trilha.id, etapa: C.ITEM_BLOCO.REVISAO, explicacao: decisaoRevisao.explicacao, habilidade: review[0].habilidade_nome };
        }
      }
    }

    // 3) Sem questões novas nem revisões: encerra a trilha.
    await pool.query("UPDATE trilhas SET status = ? WHERE id = ? AND aluno_id = ?", [C.TRILHA_STATUS.CONCLUIDA, trilha.id, alunoId]);
    return { tarefaTipo: 'CONCLUIDO', trilhaId: trilha.id };
  },

  async processarRespostaEProximaQuestao(alunoId, itemId, respostaDada, tempoResposta = null) {
    const connection = await pool.getConnection();
    let result;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query(`SELECT ti.*, t.aluno_id, t.tentativa_origem_id, q.habilidade_id, q.resposta, q.explicacao, q.distrator_a, q.distrator_b, q.distrator_c, q.distrator_d, q.dificuldade
        FROM trilha_itens ti JOIN trilhas t ON t.id = ti.trilha_id JOIN questoes q ON q.id = ti.questao_id WHERE ti.id = ? AND t.aluno_id = ? FOR UPDATE`, [itemId, alunoId]);
      const item = rows[0];
      if (!item) throw new Error('Item da trilha não encontrado para este aluno.');
      if (item.status !== C.ITEM_STATUS.PENDENTE) throw new Error('Esta resposta já foi registrada.');
      const acertou = normalizeForComparison(respostaDada) === normalizeForComparison(item.resposta);

      // --- Repetição: errar ainda não encerra a questão ---
      // O item segue `pendente` e só registramos que houve uma tentativa. Nenhum
      // efeito colateral (proficiência, streak, revisão, histórico) roda aqui:
      // punir cada tentativa penalizaria um erro que o aluno corrige sozinho na
      // seguinte. O aluno recebe a MESMA questão de volta, sem o gabarito.
      const tentativaAtual = Number(item.tentativa) || 1;
      const aindaPodeTentar = !acertou && tentativaAtual < C.ITEM_MAX_TENTATIVAS;

      if (aindaPodeTentar) {
        await connection.query(`UPDATE trilha_itens SET tentativa = ?, resposta_aluno = ?, acertou = 0 WHERE id = ?`, [tentativaAtual + 1, String(respostaDada), itemId]);
        await connection.commit();

        // Streak de acertos zerado JÁ no erro, mesmo com repetição disponível: a
        // pressão de perder a sequência é o que motiva acertar de primeira.
        //
        // Isso é seguro porque o streak é puramente motivacional — não alimenta
        // proficiência, histórico nem revisão, que seguem esperando a resolução
        // definitiva. Se o aluno acertar na repetição, o streak volta a 1: ele
        // reconquistou.
        //
        // Depois do commit e fora da transação: `registrarResultado` usa o pool e
        // seguraria a conexão da transação aberta à toa.
        const streak = await GamificationService.registrarResultado(alunoId, false);

        return {
          feedback: {
            acertou: false,
            gabarito: null,
            explicacao: feedbackFor(item, false, respostaDada, { ocultarExplicacao: true }),
            podeTentarNovamente: true,
            // Conta quantas respostas AINDA virão: quem errou na 1ª recebe a 2ª
            // e a 3ª (MAX - 1), não MAX - 2.
            tentativasRestantes: C.ITEM_MAX_TENTATIVAS - tentativaAtual,
            dominioEstimado: null,
            sesion: null,
            ...streak
          },
          proximaTarefa: null
        };
      }

      await connection.query(`UPDATE trilha_itens SET status = ?, resposta_aluno = ?, acertou = ?, concluido_em = NOW() WHERE id = ?`, [C.ITEM_STATUS.CONCLUIDO, String(respostaDada), acertou, itemId]);
      if (item.habilidade_id) await connection.query(`INSERT INTO historico_questoes (aluno_id, questao_id, habilidade_id, resposta_dada, acertou, tempo_resposta_seg)
        VALUES (?, ?, ?, ?, ?, ?)`, [alunoId, item.questao_id, item.habilidade_id, String(respostaDada), acertou, tempoResposta]);

      // Persiste o resultado de habilidade dentro da mesma transação para que
      // o dashboard (AnalyticsService) e os focos do professor
      // (RecomendacaoProfessorService) tenham os dados disponíveis imediatamente.
      // `tentativa_origem_id` é NULL para trilhas de aprendizagem sem diagnóstico;
      // nessas tabelas `resultado_habilidade` (tentativa_id NOT NULL) não se aplica.
      if (item.habilidade_id && item.tentativa_origem_id) {
        const percentual = acertou ? 100 : 0;
        await ResultadoHabilidadeService.registrarResultado({
          alunoId,
          tentativaId: item.tentativa_origem_id,
          habilidadeId: item.habilidade_id,
          acertos: acertou ? 1 : 0,
          erros: acertou ? 0 : 1,
          percentual,
          connection
        });
      }

      await connection.commit();
      result = { item, acertou };
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    let sessaoInicio = null;
    if (result.item.sessao_id) {
      const [sessaoRows] = await pool.query('SELECT inicio_em FROM sessoes_adaptativas WHERE id = ?', [result.item.sessao_id]);
      sessaoInicio = sessaoRows[0]?.inicio_em;
    }
    const mastery = result.item.habilidade_id
      ? await MotorAdaptativoService.atualizarProficiencia(alunoId, result.item.habilidade_id, { sessaoId: result.item.sessao_id, sessaoInicio })
      : null;
    await MotorAdaptativoService.registrarAplicacaoQuestao(result.item.questao_id);
    if (result.item.sessao_id) await MotorAdaptativoService.registrarActividadSesion(result.item.sessao_id);
    await RevisaoService.agendarProximaRevisao(alunoId, result.item.questao_id, result.acertou, { dificuldade: result.item.dificuldade, habilidadeId: result.item.habilidade_id });
    if (result.item.habilidade_id) await AnalisePedagogicaService.analisarAposResposta(alunoId, result.item.habilidade_id, result.item.questao_id, { acertou: result.acertou, tempo_resposta_seg: tempoResposta });
    const gamification = await GamificationService.registrarResultado(alunoId, result.acertou);

    // Refuerzo instruccional: escalera de intervención (feedback → representación → ejemplo → prerrequisito → práctica).
    let planoReforco = null;
    if (!result.acertou && result.item.habilidade_id) {
      const hist = await MotorAdaptativoService.obterHistorico(alunoId, result.item.habilidade_id);
      planoReforco = Engine.planReforco({ history: hist.slice(-6) });
    }

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
      feedback: {
        acertou: result.acertou,
        gabarito: normalizeForComparison(result.item.resposta),
        explicacao: feedbackFor(result.item, result.acertou, respostaDada),
        habilidadeReforcada: mastery?.status === C.DOMINIO_STATUS.PRECISA_REFORCO,
        planoReforco: planoReforco ? planoReforcoLegible(planoReforco.pasos) : [],
        dominioEstimado: mastery?.percentual ?? null,
        sesion: mastery?.sessao ?? null,
        podeTentarNovamente: false,
        tentativasRestantes: 0,
        ...gamification
      },
      proximaTarefa
    };
  },

  /**
   * Progresso do aluno sobre o CURRÍCULO dele.
   *
   * Antes esta query listava `habilidades` inteira, sem WHERE. A tabela é global
   * (compartilhada por todos os alunos e pelas atividades de todos os
   * professores), então o painel acabava mostrando as habilidades de menor `id`
   * do banco — "Soma" e "Frações" apareciam para um aluno de 1º ano do médio e
   * "Teorema de Pitágoras", recém-praticada, nunca entrava no corte. O filtro por
   * aluno ficava no `ON` do LEFT JOIN (acerta o percentual, não filtra linhas).
   *
   * A fonte de verdade passa a ser o currículo (`curriculo_aluno` +
   * `habilidades_curriculo`), o mesmo critério que `selecionarProximaQuestao` já
   * usa. Assim a trilha e o painel concordam sobre quais habilidades são do aluno.
   *
   * `habilidades.ano_escolar` não serve como filtro: está NULL nas 12 habilidades
   * do banco (as criadas pela trilha nascem por `gerarQuestaoDeterministica`, que
   * insere a questão com habilidade já existente e nunca passa pelo INSERT que
   * preencheria o campo). E mesmo preenchida, a coluna é de tabela GLOBAL — ver o
   * comentário em `ensureActivityPersisted`.
   */
  /**
   * Devolve o item da trilha COM a questão completa, validando que é do aluno.
   *
   * Usado pelos endpoints de tutor (dica/explicação). O `FOR UPDATE` não é
   * necessário aqui — é leitura, e a escrita do tutor é só no cache.
   *
   * @returns {Promise<object|null>} item ou null se não existir / não for do aluno
   */
  async buscarItemComQuestao(alunoId, itemId) {
    // `questoes` NÃO tem coluna `titulo` — só `enunciado`. (`atividades` tem
    // `titulo`; daí a tentação. O teste `schemaDrift` barraria a query.)
    const [rows] = await pool.query(`SELECT ti.id AS item_id, ti.trilha_id, ti.sessao_id, ti.bloco, ti.status,
        ti.tentativa, ti.resposta_aluno, ti.meta_json,
        q.id AS questao_id, q.enunciado, q.alternativa_a, q.alternativa_b, q.alternativa_c, q.alternativa_d,
        q.resposta, q.dificuldade, q.habilidade_id, h.descricao AS habilidade_nome
      FROM trilha_itens ti
      JOIN trilhas t ON t.id = ti.trilha_id
      JOIN questoes q ON q.id = ti.questao_id
      LEFT JOIN habilidades h ON h.id = q.habilidade_id
      WHERE ti.id = ? AND t.aluno_id = ? LIMIT 1`, [itemId, alunoId]);
    const item = rows[0];
    if (!item) return null;
    // A questão do banco usa alternativa_a..d + resposta; o validador de gabarito
    // e o tutor esperam `options` por letra + `correct`. Adaptamos aqui para não
    // repetir essa tradução em cada consumidor.
    return { ...item, ...this.questaoParaFormatoTutor(item) };
  },

  /** Converte alternativa_a..d / resposta (formato do banco) em options/correct. */
  questaoParaFormatoTutor(item) {
    const mapa = { A: item.alternativa_a, B: item.alternativa_b, C: item.alternativa_c, D: item.alternativa_d };
    const options = Object.fromEntries(
      Object.entries(mapa).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
    );
    return {
      // `questoes` guarda o enunciado em `enunciado`; `titulo` fica como
      // fallback para itens cuja questão venha de outra forma.
      text: item.enunciado || item.titulo,
      habilidade: item.habilidade_nome || '',
      dificuldade: item.dificuldade || 'facil',
      options,
      correct: item.resposta
    };
  },

  /**
   * Cache do conteúdo de tutor no `meta_json` do item.
   *
   * Sem cache, cada clique em "Pedir dica" chamaria a IA de novo e consumiria
   * outro passe do aluno para devolver texto idêntico. `meta_json` já existe na
   * tabela, então não há migration.
   *
   * A leitura faz merge com o JSON atual para não apagar `origem`/`habilidade_id`,
   * que `criarItemDaDecisao` gravou ali.
   */
  async obterTutorCache(alunoId, itemId) {
    const [rows] = await pool.query(`SELECT ti.meta_json FROM trilha_itens ti
      JOIN trilhas t ON t.id = ti.trilha_id WHERE ti.id = ? AND t.aluno_id = ? LIMIT 1`, [itemId, alunoId]);
    const bruto = rows[0]?.meta_json;
    const meta = typeof bruto === 'string' ? safeParseJSON(bruto) : (bruto || {});
    return meta?.tutor || null;
  },

  async gravarTutorCache(alunoId, itemId, dados) {
    const [rows] = await pool.query(`SELECT ti.meta_json FROM trilha_itens ti
      JOIN trilhas t ON t.id = ti.trilha_id WHERE ti.id = ? AND t.aluno_id = ? LIMIT 1`, [itemId, alunoId]);
    if (!rows[0]) return;
    const bruto = rows[0].meta_json;
    const meta = typeof bruto === 'string' ? safeParseJSON(bruto) : (bruto || {});
    const atualizado = { ...meta, tutor: { ...(meta?.tutor || {}), ...dados } };
    await pool.query('UPDATE trilha_itens SET meta_json = ? WHERE id = ?', [JSON.stringify(atualizado), itemId]);
  },

  async obterProgresso(alunoId) {
    const [trilha] = await pool.query("SELECT * FROM trilhas WHERE aluno_id = ? AND status = ? ORDER BY atualizado_em DESC LIMIT 1", [alunoId, C.TRILHA_STATUS.ATIVA]);
    const [reviews] = await pool.query('SELECT COUNT(*) AS pendentes FROM revisao_agendada WHERE aluno_id = ? AND data_revisao <= CURDATE()', [alunoId]);

    // Cota diária e progresso diário (questões concluídas hoje / cota do dia).
    let questoesHoje = 0;
    let cotaDiaria = 0;
    let progressoDiario = 0;
    if (trilha?.[0]) {
      cotaDiaria = await this.calcularCotaDiaria(alunoId, trilha[0].id);
      questoesHoje = await this.contarQuestoesConcluidasHoje(alunoId, trilha[0].id);
      progressoDiario = cotaDiaria.total > 0
        ? Number(((questoesHoje / cotaDiaria.total) * 100).toFixed(1))
        : 0;
    }

    const curriculo = await CurriculoAlunoModel.findByAluno(alunoId);
    let skills = [];
    if (curriculo) {
      // Ordenação: primeiro o que tem evidência de prática, dentro dele o maior
      // domínio; depois a ordem curricular, para o painel não oscilar a cada
      // recarga. (Comentário fora do SQL: `--` dentro de prepared statement é
      // risco desnecessário.)
      const [rows] = await pool.query(`SELECT h.id AS habilidade_id, h.descricao AS habilidade_nome,
          COALESCE(uh.percentual_dominio, 0) AS percentual_dominio,
          COALESCE(uh.status_dominio, ?) AS status_dominio,
          COALESCE(uh.n_tentativas, 0) AS n_tentativas
        FROM habilidades_curriculo hc
        JOIN habilidades h ON h.id = hc.habilidade_id
        LEFT JOIN usuario_habilidades uh ON uh.habilidade_id = h.id AND uh.aluno_id = ?
        WHERE hc.curriculo_id = ?
        ORDER BY (COALESCE(uh.n_tentativas, 0) > 0 OR COALESCE(uh.percentual_dominio, 0) > 0) DESC,
          COALESCE(uh.percentual_dominio, 0) DESC,
          hc.ordem ASC, h.id ASC`,
        [C.DOMINIO_STATUS.NAO_INICIADO, alunoId, curriculo.id]);
      skills = rows;
    }

    const totalSkills = skills.length;
    const mastered = skills.filter(s => Engine.normalizeStatus(s.status_dominio) === C.DOMINIO_STATUS.DOMINADA).length;
    const proficiente = skills.filter(s => Engine.normalizeStatus(s.status_dominio) === C.DOMINIO_STATUS.PROFICIENTE).length;
    const needsReinforcement = skills.filter(s => Engine.normalizeStatus(s.status_dominio) === C.DOMINIO_STATUS.PRECISA_REFORCO).length;
    // Agora mede domínio sobre o currículo do aluno, não sobre o banco inteiro.
    // O número fica menor do que antes — e passa a significar algo.
    const progressoGeral = totalSkills > 0 ? Number(((mastered / totalSkills) * 100).toFixed(1)) : 0;

    // O corte dos 5 é relevante (evidência + domínio), não mais "menor id do banco".
    // A view apenas renderiza; devolve também o total para ela poder avisar que
    // há mais habilidades fora da amostra.
    const LIMITE_EXIBICAO = 5;
    return {
      trilha,
      progressoGeral,
      totalSkills,
      mastered,
      proficiente,
      needsReinforcement,
      habilidades: skills.slice(0, LIMITE_EXIBICAO).map(s => ({ ...s, status_dominio: Engine.normalizeStatus(s.status_dominio) })),
      habilidadesOmitidas: Math.max(0, totalSkills - LIMITE_EXIBICAO),
      // Sem currículo não há o que medir: a view orienta o nivelamento em vez de
      // exibir painel vazio. (Cair em `usuario_habilidades` reintroduziria
      // habilidades globais — foi assim que "Soma" vazou para este painel.)
      semCurriculo: !curriculo,
      revisoesPendentes: reviews[0].pendentes,
      questoesHoje,
      cotaDiaria: cotaDiaria.total,
      progressoDiario
    };
  }
};

module.exports = TrilhaService;