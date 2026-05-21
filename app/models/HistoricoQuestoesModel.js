
const pool = require('../../config/pool');

const HistoricoQuestoesModel = {
  async create({ alunoId, questaoId, habilidadeId, respostaDada, acertou, tempoResposta }) {
    try {
      const [result] = await pool.query(
        'INSERT INTO historico_questoes (aluno_id, questao_id, habilidade_id, resposta_dada, acertou, tempo_resposta_seg) VALUES (?, ?, ?, ?, ?, ?)',
        [alunoId, questaoId, habilidadeId, respostaDada, acertou, tempoResposta]
      );
      return { id: result.insertId };
    } catch (error) {
      console.error('Erro ao criar histórico de questão:', error);
      throw error;
    }
  },

  async findByAlunoAndHabilidade(alunoId, habilidadeId) {
    try {
      const [rows] = await pool.query(
        'SELECT * FROM historico_questoes WHERE aluno_id = ? AND habilidade_id = ? ORDER BY data_resposta ASC',
        [alunoId, habilidadeId]
      );
      return rows;
    } catch (error) {
      console.error('Erro ao buscar histórico por aluno e habilidade:', error);
      throw error;
    }
  },

  async findByAlunoId(alunoId) {
    try {
      const [rows] = await pool.query('SELECT * FROM historico_questoes WHERE aluno_id = ? ORDER BY data_resposta DESC', [alunoId]);
      return rows;
    } catch (error) {
      console.error('Erro ao buscar histórico por aluno:', error);
      throw error;
    }
  },

  /**
   * Busca todo o histórico de questões, em ordem cronológica.
   * Essencial para o treinamento do modelo de Machine Learning.
   */
  async findAll() {
    try {
      // Ordenar por data_resposta é crucial para reconstruir o estado do aluno ao longo do tempo.
      const [rows] = await pool.query('SELECT * FROM historico_questoes ORDER BY data_resposta ASC');
      return rows;
    } catch (error) {
      console.error('Erro ao buscar todo o histórico de questões:', error);
      throw error;
    }
  }
};

module.exports = HistoricoQuestoesModel;
