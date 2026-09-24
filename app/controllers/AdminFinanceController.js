const pool = require('../../config/pool');
const ExcelJS = require('exceljs');

const AdminFinanceController = {

  async getTransactionHistory(req, res) {
    const { page = 1, limit = 15 } = req.query;
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    try {
        const params = [parseInt(limit, 10), offset];

        const query = `
            SELECT 
                p.id as pagamento_id,
                p.descricao,
                p.valor,
                p.status,
                p.criado_em,
                ag.aluno_id,
                al.nome as aluno_nome,
                ag.professor_id,
                prof.nome as professor_nome
            FROM pagamentos p
            LEFT JOIN agendamentos ag ON p.sala = ag.sala_id
            LEFT JOIN alunos al ON ag.aluno_id = al.id
            LEFT JOIN professores prof ON ag.professor_id = prof.id
            ORDER BY p.criado_em DESC
            LIMIT ? OFFSET ?;
        `;

        const countQuery = `SELECT COUNT(*) as total FROM pagamentos;`;

        const [transactions] = await pool.query(query, params);
        const [countResult] = await pool.query(countQuery);
        
        const totalItems = countResult[0].total;
        const totalPages = Math.ceil(totalItems / limit);

        res.json({
            transactions,
            pagination: { page: parseInt(page, 10), totalPages, totalItems, limit: parseInt(limit, 10) }
        });

    } catch (error) {
        console.error("Error fetching transaction history:", error);
        res.status(500).send(error.message);
    }
  },

  async markRepasseAsPaid(req, res) {
    try {
        const { id } = req.params;
        if (!id) {
            return res.status(400).send('Repasse ID is required.');
        }

        const [result] = await pool.query(
            'UPDATE repasses SET status = ?, data_pagamento = NOW() WHERE id = ?', 
            ['pago', id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).send('Repasse not found or already processed.');
        }

        // TODO: Adicionar lógica para notificar o professor

        res.status(200).send('Repasse marcado como pago com sucesso.');
    } catch (error) {
        console.error("Error marking repasse as paid:", error);
        res.status(500).send(error.message);
    }
  },

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
