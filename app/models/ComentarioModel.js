const pool = require('../../config/pool');

const ComentarioModel = {

  async findByProfessor(professorId) {
    const [rows] = await pool.query(
      'SELECT * FROM comentarios WHERE professor_id = ? ORDER BY criado_em DESC',
      [professorId]
    );
    return rows;
  },

  async create({ professor_id, usuario_nome, texto, nota }) {
    const [result] = await pool.query(
      'INSERT INTO comentarios (professor_id, usuario_nome, texto, nota) VALUES (?, ?, ?, ?)',
      [professor_id, usuario_nome, texto, nota || null]
    );
    return { id: result.insertId };
  },

  async mediaByProfessor(professorId) {
    const [rows] = await pool.query(
      `SELECT AVG(nota) AS media, COUNT(nota) AS total
       FROM comentarios
       WHERE professor_id = ? AND nota IS NOT NULL`,
      [professorId]
    );
    return rows[0] || { media: 0, total: 0 };
  }
};

module.exports = ComentarioModel;
