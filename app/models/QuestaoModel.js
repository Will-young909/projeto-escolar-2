
const pool = require('../../config/pool');

const QuestaoModel = {
  // Encontra uma questão INÉDITA para o aluno, com base na habilidade e dificuldade
  async findNewQuestionBySkillAndDifficulty(alunoId, habilidadeId, dificuldades) {
    try {
      const [rows] = await pool.query(
        `SELECT q.* FROM questoes q
         WHERE q.habilidade_id = ?
           AND q.dificuldade IN (?)
           AND q.id NOT IN (
             SELECT hq.questao_id FROM historico_questoes hq WHERE hq.aluno_id = ?
           )
         ORDER BY RAND() -- Aleatoriza a seleção da questão para não ser sempre a mesma
         LIMIT 1`,
        [habilidadeId, dificuldades, alunoId]
      );
      return rows[0];
    } catch (error) {
      console.error('Erro ao buscar nova questão por habilidade e dificuldade:', error);
      throw error;
    }
  },

  // Busca uma questão pelo ID (útil para o histórico)
  async findById(id) {
    try {
      const [rows] = await pool.query('SELECT * FROM questoes WHERE id = ?', [id]);
      return rows[0];
    } catch (error) {
      console.error('Erro ao buscar questão por ID:', error);
      throw error;
    }
  }
};

module.exports = QuestaoModel;
