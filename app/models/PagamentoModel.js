const pool = require('../../config/pool');

const PagamentoModel = {

  async findAll() {
    const [rows] = await pool.query(
      'SELECT * FROM pagamentos ORDER BY criado_em DESC'
    );
    return rows;
  },

  async findByPreferenceId(preferenceId) {
    const [rows] = await pool.query(
      'SELECT * FROM pagamentos WHERE preference_id = ?',
      [preferenceId]
    );
    return rows[0] || null;
  },

  async findByPaymentId(paymentId) {
    const [rows] = await pool.query(
      'SELECT * FROM pagamentos WHERE payment_id = ?',
      [paymentId]
    );
    return rows[0] || null;
  },

  async findByCheckoutId(checkoutId) {
    if (!checkoutId) return null;
    const [rows] = await pool.query(
      'SELECT * FROM pagamentos WHERE checkout_id = ?',
      [checkoutId]
    );
    return rows[0] || null;
  },

  async create({ checkout_id, preference_id, payment_id, sala, descricao, valor, criado_por, status, taxa_plataforma, valor_liquido, professor_id }) {
    const [result] = await pool.query(
      `INSERT INTO pagamentos (checkout_id, preference_id, payment_id, sala, descricao, valor, taxa_plataforma, valor_liquido, criado_por, professor_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [checkout_id || null, preference_id || null, payment_id || null, sala || null, descricao || null, valor, taxa_plataforma ?? 0, valor_liquido ?? 0, criado_por || null, professor_id || null, status || 'pending']
    );
    return { id: result.insertId };
  },

  async updateByPreferenceId(preferenceId, dados) {
    const campos = [];
    const valores = [];

    for (const [key, val] of Object.entries(dados)) {
      campos.push(`${key} = ?`);
      valores.push(val);
    }

    if (campos.length === 0) return false;
    valores.push(preferenceId);

    const [result] = await pool.query(
      `UPDATE pagamentos SET ${campos.join(', ')} WHERE preference_id = ?`,
      valores
    );
    return result.affectedRows > 0;
  },

  async updateByPaymentId(paymentId, dados) {
    const campos = [];
    const valores = [];

    for (const [key, val] of Object.entries(dados)) {
      campos.push(`${key} = ?`);
      valores.push(val);
    }

    if (campos.length === 0) return false;
    valores.push(paymentId);

    const [result] = await pool.query(
      `UPDATE pagamentos SET ${campos.join(', ')} WHERE payment_id = ?`,
      valores
    );
    return result.affectedRows > 0;
  },

  async updateByCheckoutId(checkoutId, dados) {
    if (!checkoutId) return false;
    const campos = [];
    const valores = [];

    for (const [key, val] of Object.entries(dados)) {
      campos.push(`${key} = ?`);
      valores.push(val);
    }

    if (campos.length === 0) return false;
    valores.push(checkoutId);

    const [result] = await pool.query(
      `UPDATE pagamentos SET ${campos.join(', ')} WHERE checkout_id = ?`,
      valores
    );
    return result.affectedRows > 0;
  }
};

module.exports = PagamentoModel;