const pool = require('../../config/pool');
const ExcelJS = require('exceljs');

const AdminFinanceController = {
  async getRepasses(req, res) {
    try {
      const [repasses] = await pool.query(
        'SELECT r.*, p.nome as professor_nome FROM repasses r JOIN professores p ON r.professor_id = p.id WHERE r.status = ?',
        [req.query.status || 'pendente']
      );
      res.json(repasses);
    } catch (error) {
      res.status(500).send(error.message);
    }
  },

  async getCarteiraProfessor(req, res) {
    try {
      const { professor_id } = req.params;
      const [agendamentos] = await pool.query(
        'SELECT SUM(preco) as total, COUNT(*) as aulas FROM horarios_disponiveis WHERE professor_id = ? AND status = \'agendado\'',
        [professor_id]
      );
      const [repasses] = await pool.query(
        'SELECT SUM(valor) as total FROM repasses WHERE professor_id = ? AND status = \'pago\'',
        [professor_id]
      );

      const total_ganho = agendamentos[0].total || 0;
      const total_repassado = repasses[0].total || 0;
      const saldo_disponivel = total_ganho - total_repassado;

      res.json({
        total_ganho,
        total_repassado,
        saldo_disponivel,
        aulas_realizadas: agendamentos[0].aulas
      });
    } catch (error) {
      res.status(500).send(error.message);
    }
  },

  async bloquearPagamentos(req, res) {
    try {
      const { professor_id } = req.params;
      await pool.query('UPDATE professores SET pagamentos_bloqueados = TRUE WHERE id = ?', [professor_id]);
      res.status(200).send('Pagamentos bloqueados com sucesso.');
    } catch (error) {
      res.status(500).send(error.message);
    }
  },

  async exportarCSV(req, res) {
    try {
      const [repasses] = await pool.query('SELECT r.*, p.nome as professor_nome, p.email as professor_email FROM repasses r JOIN professores p ON r.professor_id = p.id');

      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Repasses');

      worksheet.columns = [
        { header: 'ID', key: 'id', width: 10 },
        { header: 'Professor', key: 'professor_nome', width: 30 },
        { header: 'Email', key: 'professor_email', width: 30 },
        { header: 'Valor', key: 'valor', width: 15 },
        { header: 'Status', key: 'status', width: 15 },
        { header: 'Data Solicitação', key: 'data_solicitacao', width: 20 },
        { header: 'Data Pagamento', key: 'data_pagamento', width: 20 },
      ];

      worksheet.addRows(repasses);

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=repasses.csv');

      await workbook.csv.write(res);
      res.end();
    } catch (error) {
      res.status(500).send(error.message);
    }
  }
};

module.exports = AdminFinanceController;
