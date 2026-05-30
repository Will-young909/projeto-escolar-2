const pool = require('../../config/pool');

const AlertasController = {

  async getAlertas(req, res) {
    try {
      const [alertas] = await pool.query('SELECT * FROM alertas_operacionais WHERE resolvido = FALSE ORDER BY criado_em DESC');
      res.json(alertas);
    } catch (error) {
      res.status(500).send(error.message);
    }
  },

  async checkCancelamentosAltos() {
    const [professores] = await pool.query(`
      SELECT professor_id, COUNT(*) as cancelamentos
      FROM agendamentos
      WHERE status = 'cancelado' AND TIMESTAMPDIFF(DAY, criado_em, NOW()) <= 30
      GROUP BY professor_id
      HAVING cancelamentos > 10
    `);

    for (const professor of professores) {
      await this.criarAlerta('cancelamento_alto', professor.professor_id, `Professor com ${professor.cancelamentos} cancelamentos nos últimos 30 dias.`);
    }
  },

  async checkNoShowReincidente() {
    const [reincidencias] = await pool.query(`
      SELECT aluno_id, COUNT(*) as no_shows
      FROM agendamentos
      WHERE no_show = TRUE AND TIMESTAMPDIFF(MONTH, criado_em, NOW()) <= 2
      GROUP BY aluno_id
      HAVING no_shows >= 3
    `);

    for (const reincidencia of reincidencias) {
      await this.criarAlerta('no_show_reincidente', reincidencia.aluno_id, `Aluno com ${reincidencia.no_shows} no-shows nos últimos 2 meses.`);
    }
  },

  async checkAumentoDenuncias() {
    const [denuncias] = await pool.query(`
      SELECT COUNT(*) as total_denuncias
      FROM denuncias
      WHERE TIMESTAMPDIFF(DAY, criado_em, NOW()) <= 7
    `);

    if (denuncias[0].total_denuncias > 20) {
      await this.criarAlerta('aumento_denuncias', 'sistema', `Aumento súbito de denúncias: ${denuncias[0].total_denuncias} nos últimos 7 dias.`);
    }
  },

  async criarAlerta(tipo, entidade_id, mensagem) {
    await pool.query(
      'INSERT INTO alertas_operacionais (tipo, entidade_id, mensagem) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE mensagem = VALUES(mensagem)',
      [tipo, entidade_id, mensagem]
    );
  }
};

// Cron job para rodar as verificações
setInterval(async () => {
  await AlertasController.checkCancelamentosAltos();
  await AlertasController.checkNoShowReincidente();
  await AlertasController.checkAumentoDenuncias();
}, 1000 * 60 * 60 * 24); // Roda uma vez por dia

module.exports = AlertasController;
