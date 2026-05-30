const pool = require('../../config/pool');

const AdminAuditLogModel = {
  async create(log) {
    const [result] = await pool.query('INSERT INTO admin_audit_logs SET ?', log);
    return result;
  }
};

module.exports = AdminAuditLogModel;