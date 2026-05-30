const pool = require('../../config/pool');
const AuditService = require('../services/AuditService');

const updateTeacherStatus = async (teacherId, newStatus, adminId, reason = null) => {
    const validStatuses = ['approved', 'rejected', 'suspended', 'pending'];
    if (!validStatuses.includes(newStatus)) {
        throw new Error('Invalid status provided.');
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [rows] = await connection.query('SELECT * FROM professores WHERE id = ?', [teacherId]);
        const oldData = rows[0];

        const updateQuery = 'UPDATE professores SET aprovacao_status = ?, motivo_reprovacao = ?, aprovado_por = ?, aprovado_em = NOW() WHERE id = ?';
        await connection.query(updateQuery, [newStatus, reason, adminId, teacherId]);

        const [updatedRows] = await connection.query('SELECT * FROM professores WHERE id = ?', [teacherId]);
        const newData = updatedRows[0];

        const diff = { old: oldData, new: newData };

        await AuditService.log(adminId, `update_status: ${newStatus}`, 'professor', teacherId, diff, reason);

        await connection.commit();
    } catch (error) {
        await connection.rollback();
        console.error(`Error updating teacher status to ${newStatus} for teacher ${teacherId}:`, error);
        throw error; 
    } finally {
        connection.release();
    }
};

exports.listTeachers = async (req, res) => {
    try {
        const [teachers] = await pool.query('SELECT id, nome, email, aprovacao_status, criado_em FROM professores ORDER BY criado_em DESC');
        res.render('pages/admin/teachers', { layout: 'admin_layout', teachers });
    } catch (error) {
        console.error('Error listing teachers:', error);
        res.status(500).send('Error listing teachers');
    }
};

exports.approveTeacher = async (req, res) => {
    const { id } = req.params;
    const adminId = req.session.user_admin.id;
    try {
        await updateTeacherStatus(id, 'approved', adminId);
        res.redirect('/admin/dashboard#page-users');
    } catch (error) {
        res.status(500).send('Failed to approve teacher.');
    }
};

exports.rejectTeacher = async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;
    const adminId = req.session.user_admin.id;

    if (!reason) {
        return res.status(400).send('A reason is required for rejection.');
    }

    try {
        await updateTeacherStatus(id, 'rejected', adminId, reason);
        res.redirect('/admin/dashboard#page-users');
    } catch (error) {
        res.status(500).send('Failed to reject teacher.');
    }
};

exports.suspendTeacher = async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;
    const adminId = req.session.user_admin.id;

    if (!reason) {
        return res.status(400).send('A reason is required for suspension.');
    }

    try {
        await updateTeacherStatus(id, 'suspended', adminId, reason);
        res.redirect('/admin/dashboard#page-users');
    } catch (error) {
        res.status(500).send('Failed to suspend teacher.');
    }
};

exports.reactivateTeacher = async (req, res) => {
    const { id } = req.params;
    const adminId = req.session.user_admin.id;
    try {
        await updateTeacherStatus(id, 'pending', adminId, 'Reactivated by admin');
        res.redirect('/admin/dashboard#page-users');
    } catch (error) {
        res.status(500).send('Failed to reactivate teacher.');
    }
};
