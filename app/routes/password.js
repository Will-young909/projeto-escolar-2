const express = require('express');
const router = express.Router();
const passwordController = require('../controllers/PasswordController');

router.post('/forgot-password', passwordController.forgotPassword);
router.get('/reset-password/:token', passwordController.getResetPassword);
router.post('/reset-password', passwordController.postResetPassword);

module.exports = router;
