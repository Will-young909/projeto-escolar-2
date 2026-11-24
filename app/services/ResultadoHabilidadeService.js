'use strict';

/**
 * ResultadoHabilidadeService
 *
 * Serviço de gravação da tabela `resultado_habilidade`.
 *
 * A tabela armazena o resultado agregado de uma habilidade dentro de uma
 * tentativa específica (`tentativa_id NOT NULL` com FK para `tentativas_teste`).
 * O escritor acumula `acertos`/`erros` e recomputa `percentual` sempre que um
 * novo item da mesma (aluno, tentativa, habilidade) é concluído — assim o
 * dashboard (`AnalyticsService.getDashboardData`) e os focos do professor
 * (`RecomendacaoProfessorService.buscarFocosPorTentativa`) passam a ter dados.
 *
 * `nivel` é gravado dentro do ENUM da schema: 'reforco' | 'pratica' | 'avanco'.
 *
 * O método `registrarResultado` aceita um `connection` opcional: quando
 * fornecido, usa a transação já aberta do chamador (atomicidade com
 * `historico_questoes` / `usuario_habilidades`); caso contrário, gerencia sua
 * própria conexão e transação.
 */

const pool = require('../../config/pool');

const ResultadoHabilidadeService = {
  /**
   * Classifica o desempenho dentro dos valores permitidos pelo ENUM da schema.
   *
   * - reforco:  percentual < 40  OU  erros >= 3
   * - pratica:  40 <= percentual < 70  OU  (percentual >= 40 e erros > 0)
   * - avanco:   percentual >= 70  e  erros === 0
   */
  calcularNivel(percentual, erros) {
    const p = Number(percentual || 0);
    const e = Number(erros || 0);
    if (p < 40 || e >= 3) return 'reforco';
    if (p < 70 || e > 0) return 'pratica';
    return 'avanco';
  },

  /**
   * Valida os campos obrigatórios antes de qualquer gravação.
   * Retorna array de mensagens de erro (vazio quando válido).
   */
  validarEntrada({ alunoId, tentativaId, habilidadeId, acertos, erros, percentual }) {
    const errosValidacao = [];
    if (!alunoId) errosValidacao.push('aluno_id é obrigatório');
    if (!tentativaId) errosValidacao.push('tentativa_id é obrigatório');
    if (!habilidadeId) errosValidacao.push('habilidade_id é obrigatório');
    if (acertos == null || Number.isNaN(Number(acertos))) errosValidacao.push('acertos é obrigatório');
    if (erros == null || Number.isNaN(Number(erros))) errosValidacao.push('erros é obrigatório');
    if (percentual == null || Number.isNaN(Number(percentual))) errosValidacao.push('percentual é obrigatório');
    return errosValidacao;
  },
  /**
   * Registra (ou atualiza, acumulando) o resultado de habilidade.
   *
   * @param {object} params
   * @param {string} params.alunoId      FK alunos.id
   * @param {number} params.tentativaId  FK tentativas_teste.id (NOT NULL)
   * @param {number} params.habilidadeId FK habilidades.id
   * @param {number} params.acertos      acertos deste item (0 ou 1)
   * @param {number} params.erros        erros deste item (0 ou 1)
   * @param {number} params.percentual   percentual deste item (0 ou 100)
   * @param {object} [params.connection] conexão transacional do chamador (opcional)
   * @returns {Promise<{sucesso: boolean, nivel: string, percentual: number}>}
   */
  async registrarResultado({
    alunoId,
    tentativaId,
    habilidadeId,
    acertos,
    erros,
    percentual,
    connection = null
  } = {}) {
    const errosValidacao = this.validarEntrada({
      alunoId, tentativaId, habilidadeId, acertos, erros, percentual
    });
    if (errosValidacao.length > 0) {
      const error = new Error(errosValidacao.join(', '));
      error.code = 'VALIDATION_ERROR';
      throw error;
    }

    const acertosNum = Number(acertos);
    const errosNum = Number(erros);
    const percentualNum = Number(percentual);
    const nivel = this.calcularNivel(percentualNum, errosNum);

    const ownConnection = !connection;
    const conn = connection || await pool.getConnection();
    if (ownConnection) await conn.beginTransaction();

    try {
      const [existing] = await conn.query(
        `SELECT id, acertos, erros FROM resultado_habilidade
         WHERE aluno_id = ? AND tentativa_id = ? AND habilidade_id = ? LIMIT 1`,
        [alunoId, tentativaId, habilidadeId]
      );

      if (existing[0]) {
        const totalAcertos = Number(existing[0].acertos) + acertosNum;
        const totalErros = Number(existing[0].erros) + errosNum;
        const total = totalAcertos + totalErros;
        const novoPercentual = total ? (totalAcertos / total) * 100 : 0;
        const novoNivel = this.calcularNivel(novoPercentual, totalErros);

        await conn.query(
          `UPDATE resultado_habilidade
           SET acertos = ?, erros = ?, percentual = ?, nivel = ?
           WHERE id = ?`,
          [totalAcertos, totalErros, novoPercentual, novoNivel, existing[0].id]
        );
      } else {
        await conn.query(
          `INSERT INTO resultado_habilidade
           (aluno_id, tentativa_id, habilidade_id, acertos, erros, percentual, nivel)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [alunoId, tentativaId, habilidadeId, acertosNum, errosNum, percentualNum, nivel]
        );
      }

      if (ownConnection) await conn.commit();
      return { sucesso: true, nivel, percentual: percentualNum };
    } catch (error) {
      if (ownConnection) await conn.rollback();
      throw error;
    } finally {
      if (ownConnection) conn.release();
    }
  },

  /**
   * Lista resultados de habilidade de um aluno (útil para dashboards).
   */
  async listarPorAluno(alunoId) {
    const [rows] = await pool.query(
      `SELECT habilidade_id, tentativa_id, acertos, erros, percentual, nivel, criado_em
       FROM resultado_habilidade
       WHERE aluno_id = ?
       ORDER BY criado_em DESC`,
      [alunoId]
    );
    return rows;
  },

  /**
   * Lista resultados de habilidade por tentativa (útil para RecomendacaoProfessorService).
   */
  async listarPorTentativa(alunoId, tentativaId) {
    const [rows] = await pool.query(
      `SELECT habilidade_id, acertos, erros, percentual, nivel
       FROM resultado_habilidade
       WHERE aluno_id = ? AND tentativa_id = ?
       ORDER BY percentual ASC, erros DESC`,
      [alunoId, tentativaId]
    );
    return rows;
  }
};

module.exports = ResultadoHabilidadeService;
