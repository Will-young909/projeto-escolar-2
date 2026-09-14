const pool = require('../../config/pool');

const CurriculoAlunoModel = {
  async findByAluno(alunoId) {
    const [rows] = await pool.query('SELECT * FROM curriculo_aluno WHERE aluno_id = ? LIMIT 1', [alunoId]);
    return rows[0] || null;
  },

  async createOrUpdate(alunoId, data) {
    const existing = await this.findByAluno(alunoId);
    if (existing) {
      await pool.query('UPDATE curriculo_aluno SET disciplina_id = ?, ano_escolar = ?, objetivo = ?, versao_mapa = ?, atualizado_em = NOW() WHERE id = ?', [data.disciplina_id, data.ano_escolar, data.objetivo, data.versao_mapa, existing.id]);
      return { ...existing, ...data };
    }
    const [result] = await pool.query('INSERT INTO curriculo_aluno (aluno_id, disciplina_id, ano_escolar, objetivo, versao_mapa) VALUES (?, ?, ?, ?, ?)', [alunoId, data.disciplina_id, data.ano_escolar, data.objetivo, data.versao_mapa]);
    return { id: result.insertId, ...data };
  },

  async listHabilidades(curriculoId) {
    const [rows] = await pool.query('SELECT h.* FROM habilidades_curriculo hc JOIN habilidades h ON h.id = hc.habilidade_id WHERE hc.curriculo_id = ? ORDER BY hc.ordem ASC', [curriculoId]);
    return rows;
  }
};

module.exports = CurriculoAlunoModel;
