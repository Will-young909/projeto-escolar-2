const pool = require('../../config/pool');

const AgendamentoModel = {

  async findByAluno(alunoId) {
    const [rows] = await pool.query(
      `SELECT ag.*, p.nome AS professor_nome
       FROM agendamentos ag
       JOIN professores p ON p.id = ag.professor_id
       WHERE ag.aluno_id = ?
       ORDER BY ag.data, ag.hora`,
      [alunoId]
    );
    return rows;
  },

  async findByProfessor(professorId) {
    const [rows] = await pool.query(
      `SELECT ag.*, a.nome AS aluno_nome
       FROM agendamentos ag
       JOIN alunos a ON a.id = ag.aluno_id
       WHERE ag.professor_id = ?
       ORDER BY ag.data, ag.hora`,
      [professorId]
    );
    return rows;
  },

  async create({ aluno_id, professor_id, horario_id, sala_id, data, hora }) {
    const [result] = await pool.query(
      `INSERT INTO agendamentos (aluno_id, professor_id, horario_id, sala_id, data, hora)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [aluno_id, professor_id, horario_id, sala_id, data, hora]
    );
    return { id: result.insertId };
  },

  async updateStatus(id, status) {
    const [result] = await pool.query(
      'UPDATE agendamentos SET status = ? WHERE id = ?',
      [status, id]
    );
    return result.affectedRows > 0;
  }
};

module.exports = AgendamentoModel;
