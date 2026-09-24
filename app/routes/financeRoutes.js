const express = require('express');
const router = express.Router();
const FinanceController = require('../controllers/FinanceController');
const { isAdmin } = require('../middleware/authMiddleware'); // Assuming you have an auth middleware

// These routes should be protected and only accessible by admins
router.use(isAdmin);

router.get('/pending-payouts', FinanceController.getPendingPayouts);
router.get('/transaction-history', FinanceController.getTransactionHistory);

module.exports = router;
