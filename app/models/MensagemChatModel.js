const pool = require('../../config/pool');

const MensagemChatModel = {

  async findBySala(sala) {
    const [rows] = await pool.query(
      'SELECT * FROM mensagens_chat WHERE sala = ? ORDER BY enviado_em ASC',
      [sala]
    );
    return rows;
  },

  async create({ sala, user_id, user_nome, texto, enviado_em }) {
    const [result] = await pool.query(
      `INSERT INTO mensagens_chat (sala, user_id, user_nome, texto, enviado_em)
       VALUES (?, ?, ?, ?, ?)`,
      [sala, user_id, user_nome, texto, enviado_em || Date.now()]
    );
    return { id: result.insertId };
  },

  async salasDoUsuario(userId) {
    const [rows] = await pool.query(
      `SELECT sala, MAX(enviado_em) AS ultima_msg
       FROM mensagens_chat
       WHERE user_id = ?
       GROUP BY sala
       ORDER BY ultima_msg DESC`,
      [userId]
    );
    return rows;
  }
};

module.exports = MensagemChatModel;
