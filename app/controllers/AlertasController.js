const pool = require('../../config/pool');

const TIPOS = {
  cancelamento_alto: { label: 'Cancelamento alto', icon: 'fa-triangle-exclamation', cor: '#e74c3c' },
  no_show_reincidente: { label: 'No-show reincidente', icon: 'fa-user-clock', cor: '#f39c12' },
  aumento_denuncias: { label: 'Aumento de denúncias', icon: 'fa-flag', cor: '#c0392b' },
  nova_aula: { label: 'Nova aula', icon: 'fa-calendar-plus', cor: '#27ae60' },
  lembrete_aula: { label: 'Lembrete de aula', icon: 'fa-bell', cor: '#2980b9' },
  mensagem_private: { label: 'Mensagem privada', icon: 'fa-envelope', cor: '#8e44ad' },
  status_atividade: { label: 'Status de atividade', icon: 'fa-clipboard-check', cor: '#16a085' },
};

const AlertasController = {

  tipos: TIPOS,

  async getAlertas(req, res) {
    try {
      const [alertas] = await pool.query('SELECT * FROM alertas_operacionais WHERE resolvido = FALSE ORDER BY criado_em DESC');
      res.json(alertas.map(a => ({ ...a, meta: TIPOS[a.tipo] || { label: a.tipo, icon: 'fa-bell', cor: '#800020' } })));
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
      'INSERT INTO alertas_operacionais (tipo, entidade_id, mensagem) VALUES (?, ?, ?)',
      [tipo, entidade_id, mensagem]
    );
  },

  async criarNotificacaoUsuario({ usuarioId, usuarioTipo, tipo, mensagem, linkRelacionado = null, io = null }) {
    if (!usuarioId || !usuarioTipo || !mensagem) return null;
    const [result] = await pool.query(
      'INSERT INTO notificacoes (usuario_id, usuario_tipo, tipo, mensagem, lida, link_relacionado, resolvida) VALUES (?, ?, ?, ?, FALSE, ?, FALSE)',
      [usuarioId, usuarioTipo, tipo || 'geral', mensagem, linkRelacionado]
    );
    const payload = {
      id: result.insertId,
      usuario_id: usuarioId,
      usuario_tipo: usuarioTipo,
      tipo: tipo || 'geral',
      mensagem,
      lida: false,
      resolvida: false,
      link_relacionado: linkRelacionado,
      criado_em: new Date().toISOString(),
      meta: TIPOS[tipo] || { label: tipo || 'Notificação', icon: 'fa-bell', cor: '#800020' }
    };
    if (io) {
      io.to(`user:${usuarioId}`).emit('notification:new', payload);
    }
    return payload;
  },

  async getMinhasNotificacoes(req, res) {
    const user = req.session.user_aluno || req.session.user_prof;
    if (!user) return res.redirect('/login');
    const usuarioTipo = req.session.user_aluno ? 'aluno' : 'professor';
    try {
      const [notificacoes] = await pool.query(
        `SELECT id, usuario_id, usuario_tipo, tipo, mensagem, lida, link_relacionado, resolvida, criado_em
         FROM notificacoes
         WHERE usuario_id = ? AND usuario_tipo = ?
         ORDER BY criado_em DESC
         LIMIT 100`,
        [user.id, usuarioTipo]
      );
      const mapped = notificacoes.map(n => ({
        ...n,
        meta: TIPOS[n.tipo] || { label: n.tipo || 'Notificação', icon: 'fa-bell', cor: '#800020' }
      }));
      const naoLidas = mapped.filter(n => !n.lida && !n.resolvida).length;
      res.render('pages/minhas_notificacoes', { user, session: req.session, notificacoes: mapped, naoLidas, tipos: TIPOS });
    } catch (error) {
      console.error('Erro ao carregar notificações:', error);
      res.status(500).render('pages/minhas_notificacoes', { user, session: req.session, notificacoes: [], naoLidas: 0, tipos: TIPOS, erro: 'Erro ao carregar notificações.' });
    }
  },

  async marcarNotificacaoLida(req, res) {
    const user = req.session.user_aluno || req.session.user_prof;
    if (!user) return res.status(401).json({ success: false, message: 'Não autenticado.' });
    const usuarioTipo = req.session.user_aluno ? 'aluno' : 'professor';
    try {
      await pool.query('UPDATE notificacoes SET lida = TRUE WHERE id = ? AND usuario_id = ? AND usuario_tipo = ?', [req.params.id, user.id, usuarioTipo]);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async marcarTodasLidas(req, res) {
    const user = req.session.user_aluno || req.session.user_prof;
    if (!user) return res.status(401).json({ success: false, message: 'Não autenticado.' });
    const usuarioTipo = req.session.user_aluno ? 'aluno' : 'professor';
    try {
      await pool.query('UPDATE notificacoes SET lida = TRUE WHERE usuario_id = ? AND usuario_tipo = ?', [user.id, usuarioTipo]);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async resolverNotificacao(req, res) {
    const user = req.session.user_aluno || req.session.user_prof;
    if (!user) return res.status(401).json({ success: false, message: 'Não autenticado.' });
    const usuarioTipo = req.session.user_aluno ? 'aluno' : 'professor';
    try {
      await pool.query('UPDATE notificacoes SET resolvida = TRUE, lida = TRUE WHERE id = ? AND usuario_id = ? AND usuario_tipo = ?', [req.params.id, user.id, usuarioTipo]);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async excluirNotificacao(req, res) {
    const user = req.session.user_aluno || req.session.user_prof;
    if (!user) return res.status(401).json({ success: false, message: 'Não autenticado.' });
    const usuarioTipo = req.session.user_aluno ? 'aluno' : 'professor';
    try {
      await pool.query('DELETE FROM notificacoes WHERE id = ? AND usuario_id = ? AND usuario_tipo = ? AND resolvida = TRUE', [req.params.id, user.id, usuarioTipo]);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async countNaoLidas(req, res) {
    const user = req.session.user_aluno || req.session.user_prof;
    if (!user) return res.status(401).json({ count: 0 });
    const usuarioTipo = req.session.user_aluno ? 'aluno' : 'professor';
    try {
      const [[row]] = await pool.query(
        'SELECT COUNT(*) as count FROM notificacoes WHERE usuario_id = ? AND usuario_tipo = ? AND lida = FALSE AND resolvida = FALSE',
        [user.id, usuarioTipo]
      );
      res.json({ count: row.count || 0 });
    } catch (error) {
      res.status(500).json({ count: 0 });
    }
  }
};

// Cron job para rodar as verificações
setInterval(async () => {
  try {
    await AlertasController.checkCancelamentosAltos();
    await AlertasController.checkNoShowReincidente();
    await AlertasController.checkAumentoDenuncias();
  } catch (e) { console.error('Erro no cron de alertas:', e); }
}, 1000 * 60 * 60 * 24); // Roda uma vez por dia

module.exports = AlertasController;
