const FinanceService = require('../services/FinanceService');

exports.getFinancialDashboard = async (req, res) => {
    try {
        const pendingPayouts = await FinanceService.getPendingPayouts();
        const transactionHistory = await FinanceService.getTransactionHistory(req.query);

        res.render('pages/painel_adm', { // Assuming you want to render this within the main admin page
            layout: 'admin_layout',
            // ... other dashboard data ...
            pendingPayouts: pendingPayouts,
            transactionHistory: transactionHistory.transactions,
            financePagination: transactionHistory.pagination,
            // ... other dashboard data ...
        });
    } catch (error) {
        console.error('Error fetching financial data:', error);
        res.status(500).send('Error loading financial dashboard');
    }
};

exports.getPendingPayouts = async (req, res) => {
    try {
        const pendingPayouts = await FinanceService.getPendingPayouts();
        res.json(pendingPayouts);
    } catch (error) {
        console.error('Error fetching pending payouts:', error);
        res.status(500).json({ error: 'Failed to fetch pending payouts' });
    }
};

exports.getTransactionHistory = async (req, res) => {
    try {
        const transactionHistory = await FinanceService.getTransactionHistory(req.query);
        res.json(transactionHistory);
    } catch (error) {
        console.error('Error fetching transaction history:', error);
        res.status(500).json({ error: 'Failed to fetch transaction history' });
    }
};
