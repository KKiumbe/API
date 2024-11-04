// routes/reportRoutes.js
const express = require('express');
const { getCustomersWithDebtReport } = require('../../controller/reports/debtReport.js');
const router = express.Router();

// Define the route for the debt report
router.get('/reports/customers-debt', getCustomersWithDebtReport);

module.exports = router;