const express = require('express');
const router = express.Router();
const requireAdmin = require('../middlewares/requireAdmin');

// Admin Dashboard
const AdminDashboardController = require('../controllers/AdminDashboardController');
// A rota /dashboard agora vai gerenciar a listagem de professores com filtros
router.get('/dashboard', requireAdmin, AdminDashboardController.getDashboard);
router.get('/dashboard/summary', requireAdmin, AdminDashboardController.getDashboardSummary);

// Teacher Management Actions
const AdminTeachersController = require('../controllers/AdminTeachersController');
router.post('/teachers/:id/approve', requireAdmin, AdminTeachersController.approveTeacher);
router.post('/teachers/:id/reject', requireAdmin, AdminTeachersController.rejectTeacher);
router.post('/teachers/:id/suspend', requireAdmin, AdminTeachersController.suspendTeacher);
router.post('/teachers/:id/reactivate', requireAdmin, AdminTeachersController.reactivateTeacher);

// Denuncias
const AdminDenunciaController = require('../controllers/AdminDenunciaController');
router.get('/denuncias', requireAdmin, AdminDenunciaController.getDenuncias);
router.post('/denuncias/:id/atribuir', requireAdmin, AdminDenunciaController.atribuirDenuncia);
router.post('/denuncias/:id/status', requireAdmin, AdminDenunciaController.updateStatusDenuncia);
router.post('/denuncias/:id/resolver', requireAdmin, AdminDenunciaController.resolverDenuncia);
router.get('/denuncias/:id/historico', requireAdmin, AdminDenunciaController.getDenunciaHistorico);

// Financeiro
const AdminFinanceController = require('../controllers/AdminFinanceController');
router.get('/financeiro/repasses', requireAdmin, AdminFinanceController.getRepasses);
router.get('/financeiro/carteira/:professor_id', requireAdmin, AdminFinanceController.getCarteiraProfessor);
router.post('/financeiro/bloquear/:professor_id', requireAdmin, AdminFinanceController.bloquearPagamentos);
router.get('/financeiro/exportar', requireAdmin, AdminFinanceController.exportarCSV);

// Alertas
const AlertasController = require('../controllers/AlertasController');
router.get('/alertas', requireAdmin, AlertasController.getAlertas);

module.exports = router;
