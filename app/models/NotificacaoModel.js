const pool = require('../../config/pool');

const NotificacaoModel = {

  async findByUsuario(usuarioId, usuarioTipo) {
    const [rows] = await pool.query(
      `SELECT * FROM notificacoes
       WHERE usuario_id = ? AND usuario_tipo = ?
       ORDER BY criado_em DESC`,
      [usuarioId, usuarioTipo]
    );
    return rows;
  },

  async create({ usuario_id, usuario_tipo, tipo, mensagem }) {
    const [result] = await pool.query(
      `INSERT INTO notificacoes (usuario_id, usuario_tipo, tipo, mensagem)
       VALUES (?, ?, ?, ?)`,
      [usuario_id, usuario_tipo, tipo, mensagem]
    );
    return { id: result.insertId };
  },

  async marcarLida(id) {
    const [result] = await pool.query(
      'UPDATE notificacoes SET lida = 1 WHERE id = ?',
      [id]
    );
    return result.affectedRows > 0;
  }
};

module.exports = NotificacaoModel;
