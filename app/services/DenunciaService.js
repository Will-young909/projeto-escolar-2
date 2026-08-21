const pool = require('../../config/pool');


async function getUserInfo(userId) {
    if (!userId) return null;
    let [user] = await pool.query('SELECT id, \'aluno\' as tipo FROM alunos WHERE id = ?', [userId]);
    if (user.length > 0) return { ...user[0], table: 'alunos', statusField: 'status' };

    [user] = await pool.query('SELECT id, \'professor\' as tipo FROM professores WHERE id = ?', [userId]);
    if (user.length > 0) return { ...user[0], table: 'professores', statusField: 'aprovacao_status' };

    return null;
}


async function notifyUser(userId, message, type = 'denuncia_status') {
    const userInfo = await getUserInfo(userId);
    if (!userInfo) return;

    await pool.query(
        'INSERT INTO notificacoes (usuario_id, usuario_tipo, tipo, mensagem) VALUES (?, ?, ?, ?)',
        [userId, userInfo.tipo, type, message]
    );
}


async function addHistory(denunciaId, acao, detalhes, adminUserId = null) {
    await pool.query(
        'INSERT INTO denuncia_historico (denuncia_id, acao, detalhes, usuario_id) VALUES (?, ?, ?, ?)',
        [denunciaId, acao, detalhes, adminUserId]
    );
}


async function findAll(queryParams) {
    const [denuncias] = await pool.query(`
        SELECT d.*, 
               denunciante.nome AS denunciante_nome, 
               denunciado.nome AS denunciado_nome,
               c.texto AS comentario_texto
        FROM denuncias d
        LEFT JOIN (SELECT id, nome FROM alunos UNION SELECT id, nome FROM professores) AS denunciante ON d.denunciante_id = denunciante.id
        LEFT JOIN (SELECT id, nome FROM alunos UNION SELECT id, nome FROM professores) AS denunciado ON d.denunciado_id = denunciado.id
        LEFT JOIN comentarios c ON JSON_UNQUOTE(JSON_EXTRACT(d.conteudo_info, '$.id')) = c.id AND JSON_UNQUOTE(JSON_EXTRACT(d.conteudo_info, '$.tipo')) = 'comentario'
        ORDER BY d.criado_em DESC
    `);
    return denuncias;
}


async function findDenunciaHistory(denunciaId) {
    const [historico] = await pool.query(`
        SELECT h.*, COALESCE(u.nome, 'Sistema') as usuario_nome
        FROM denuncia_historico h
        LEFT JOIN (SELECT id, nome FROM alunos UNION ALL SELECT id, nome FROM professores) u ON h.usuario_id = u.id
        WHERE h.denuncia_id = ?
        ORDER BY h.criado_em ASC
    `, [denunciaId]);
    return historico;
}

async function updateStatus(denunciaId, status, adminUserId) {
    await pool.query('UPDATE denuncias SET status = ? WHERE id = ?', [status, denunciaId]);
    await addHistory(denunciaId, 'Mudança de Status', `Status alterado para ${status}`, adminUserId);
    
    const [[denuncia]] = await pool.query('SELECT titulo, denunciante_id FROM denuncias WHERE id = ?', [denunciaId]);
    if (denuncia && denuncia.denunciante_id) {
         await notifyUser(denuncia.denunciante_id, `O status da sua denúncia "${denuncia.titulo}" foi atualizado para: ${status}.`);
    }
}

async function warnUser(denunciaId, userId, message, adminUserId) {
    if (!userId || !message) throw new Error('UserID e mensagem são obrigatórios para advertir.');

    const fullMessage = `**Advertência da Moderação**\n\n` +
                        `**Mensagem:** ${message}\n\n` +
                        `Por favor, revise as diretrizes da comunidade. A reincidência pode levar a ações mais severas, como suspensão ou banimento da conta.`;

    await addHistory(denunciaId, 'Usuário Advertido', `Advertência enviada: "${message}"`, adminUserId);
    await notifyUser(userId, fullMessage, 'advertencia');
}

async function suspendUser(denunciaId, userId, reason, duration, adminUserId) {
    if (!userId || !reason || !duration) throw new Error('UserID, motivo e duração são obrigatórios para suspender.');
    const userInfo = await getUserInfo(userId);
    if (!userInfo) throw new Error('Usuário a ser suspenso não encontrado.');

    const durationInDays = parseInt(duration, 10);
    const suspensionEndDate = new Date();
    suspensionEndDate.setDate(suspensionEndDate.getDate() + durationInDays);

    const statusUpdateField = userInfo.tipo === 'aluno' ? 'status' : 'aprovacao_status';
    const newStatus = userInfo.tipo === 'aluno' ? 'suspenso' : 'suspended';

    await pool.query(
        `UPDATE ${userInfo.table} SET ${statusUpdateField} = ?, suspenso_ate = ? WHERE id = ?`,
        [newStatus, suspensionEndDate, userId]
    );

    const details = `Usuário suspenso por ${durationInDays} dias. Motivo: "${reason}"`;
    await addHistory(denunciaId, 'Usuário Suspenso', details, adminUserId);

    const suspensionMessage = `**Sua Conta Foi Suspensa**\n\n` +
                              `Sua conta foi suspensa por ${durationInDays} dia(s) devido a violações das nossas diretrizes.\n\n` +
                              `**Motivo:** ${reason}\n\n` +
                              `O acesso à sua conta será restaurado após o término do período de suspensão. Violações futuras podem resultar no banimento permanente da sua conta.`;

    await notifyUser(userId, suspensionMessage, 'suspensao');
}

async function banUser(denunciaId, userId, reason, adminUserId) {
    if (!userId || !reason) throw new Error('UserID e motivo são obrigatórios para banir.');
    const userInfo = await getUserInfo(userId);
    if (!userInfo) throw new Error('Usuário a ser banido não encontrado.');
    
    const statusUpdateField = userInfo.tipo === 'aluno' ? 'status' : 'aprovacao_status';
    const newStatus = userInfo.tipo === 'aluno' ? 'banido' : 'banned';

    await pool.query(`UPDATE ${userInfo.table} SET ${statusUpdateField} = ? WHERE id = ?`, [newStatus, userId]);
    
    const details = `Usuário banido permanentemente. Motivo: "${reason}"`;
    await addHistory(denunciaId, 'Usuário Banido', details, adminUserId);

    const banMessage = `**Sua Conta Foi Banida Permanentemente**\n\n` +
                       `Sua conta foi banida permanentemente devido a violações graves ou repetidas das nossas diretrizes.\n\n` +
                       `**Motivo:** ${reason}\n\n` +
                       `Esta ação é final e não pode ser revertida.`;

    await notifyUser(userId, banMessage, 'banimento');
}

async function addInternalNote(denunciaId, note, adminUserId) {
    if (!note) throw new Error('A nota não pode estar vazia.');
    await addHistory(denunciaId, 'Observação Interna', note, adminUserId);
}

async function findUserDenunciaHistory(userId) {
     const [denuncias] = await pool.query('SELECT * FROM denuncias WHERE denunciado_id = ? OR denunciante_id = ? ORDER BY criado_em DESC', [userId, userId]);
     return denuncias;
}

module.exports = {
    findAll,
    findDenunciaHistory,
    updateStatus,
    warnUser,
    suspendUser,
    banUser,
    addInternalNote,
    findUserDenunciaHistory,
};