const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// Controller function to manually create receipts for all unpaid invoices of a customer
const manualReceipt = async (req, res) => {
    const { customerId, totalAmount, modeOfPayment } = req.body;

    if (!customerId || !totalAmount || !modeOfPayment) {
        return res.status(400).json({ message: 'Missing required fields.' });
    }

    try {
        // Step 1: Retrieve the customer
        const customer = await prisma.customer.findUnique({
            where: { id: customerId },
        });

        if (!customer) {
            return res.status(404).json({ message: 'Customer not found.' });
        }

        // Step 2: Retrieve all unpaid invoices for the customer
        const invoices = await prisma.invoice.findMany({
            where: { customerId: customerId, status: 'UNPAID' },
        });

        // Initialize remaining amount and closing balance
        let remainingAmount = totalAmount;
        const receipts = []; // To store created receipts
        const updatedInvoices = []; // To track updated invoices
        const payments = []; // To track created payments

        if (invoices.length === 0) {
            // No unpaid invoices; treat as overpayment and update closing balance
            const newClosingBalance = customer.closingBalance - totalAmount; // Closing balance will be negative
            await prisma.customer.update({
                where: { id: customerId },
                data: {
                    closingBalance: newClosingBalance,
                },
            });
            return res.status(200).json({
                message: 'No unpaid invoices found. Payment processed as overpayment.',
                newClosingBalance,
            });
        }

        // Step 3: Process payment against invoices
        for (const invoice of invoices) {
            if (remainingAmount <= 0) break; // Stop if there's no remaining amount

            const invoiceDueAmount = invoice.invoiceAmount - invoice.amountPaid;

            // Calculate amount to pay for this invoice
            const paymentForInvoice = Math.min(remainingAmount, invoiceDueAmount);

            // Update the invoice amount paid
            const updatedInvoice = await prisma.invoice.update({
                where: { id: invoice.id },
                data: {
                    amountPaid: invoice.amountPaid + paymentForInvoice,
                    status: invoice.amountPaid + paymentForInvoice >= invoice.invoiceAmount ? 'PAID' : 'UNPAID', // Use provided statuses
                },
            });

            updatedInvoices.push(updatedInvoice);

            // Create a receipt for the payment
            const receipt = await prisma.receipt.create({
                data: {
                    customerId: customerId,
                    invoiceId: updatedInvoice.id,
                    amount: paymentForInvoice,
                    modeOfPayment: modeOfPayment, // Use the provided payment method
                },
            });

            receipts.push(receipt);

            // Create a payment record for the receipt
            const payment = await prisma.payment.create({
                data: {
                    amount: paymentForInvoice,
                    modeOfPayment: modeOfPayment,
                    receiptId: receipt.id, // Link payment to the created receipt
                },
            });

            payments.push(payment);

            // Deduct the payment amount from remainingAmount
            remainingAmount -= paymentForInvoice;
        }

        // Step 4: Handle remaining amount (possible overpayment)
        if (remainingAmount > 0) {
            const newClosingBalance = customer.closingBalance - totalAmount; // Closing balance will be negative
            await prisma.customer.update({
                where: { id: customerId },
                data: {
                    closingBalance: newClosingBalance,
                },
            });
            return res.status(200).json({
                message: 'Payment processed successfully, but closing balance is negative due to overpayment.',
                receipts,
                updatedInvoices,
                payments,
                newClosingBalance,
            });
        }

        // Step 5: Update the customer's closing balance if no overpayment
        const newClosingBalance = customer.closingBalance - totalAmount;
        await prisma.customer.update({
            where: { id: customerId },
            data: { closingBalance: newClosingBalance },
        });

        res.status(201).json({
            message: 'Receipts created successfully.',
            receipts,
            updatedInvoices,
            payments,
            newClosingBalance,
        });
    } catch (error) {
        console.error('Error creating manual receipts:', error);
        res.status(500).json({ error: 'Failed to create manual receipts.' });
    }
};

module.exports = {
    manualReceipt,
};