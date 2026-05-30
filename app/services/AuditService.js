const AdminAuditLogModel = require('../models/AdminAuditLogModel');

const AuditService = {
  async log(admin_id, acao, entidade, entidade_id, diff_json, motivo) {
    const log = {
      admin_id,
      acao,
      entidade,
      entidade_id,
      diff_json: JSON.stringify(diff_json),
      motivo
    };
    await AdminAuditLogModel.create(log);
  }
};

module.exports = AuditService;