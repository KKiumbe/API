const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Helper function to generate a receipt number with "RCPT" prefix
function generateReceiptNumber() {
    const randomDigits = Math.floor(10000 + Math.random() * 90000); // Generates a number between 10000 and 99999
    return `RCPT${randomDigits}`; // Prefix with "RCPT"
}

const manualReceipt = async (req, res) => {
    const { customerId, totalAmount, modeOfPayment, paidBy } = req.body;

    // Validate required fields
    if (!customerId || !totalAmount || !modeOfPayment || !paidBy) {
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

        // Initialize variables for processing
        let remainingAmount = totalAmount;
        const receipts = []; // To store created receipts
        const updatedInvoices = []; // To track updated invoices
        const payments = []; // To track created payments

        if (invoices.length === 0) {
            // No unpaid invoices; treat as overpayment and update closing balance
            const newClosingBalance = customer.closingBalance - totalAmount; // Closing balance will be negative
            
            // Create a payment record
            const payment = await prisma.payment.create({
                data: {
                    amount: totalAmount,
                    modeOfPayment: modeOfPayment,
                    receipted: true, // Mark payment as receipted
                    createdAt: new Date() // Set createdAt timestamp
                },
            });

            payments.push(payment);

            // Generate a unique receipt number
            const receiptNumber = generateReceiptNumber();

            // Create a receipt for the overpayment
            const receipt = await prisma.receipt.create({
                data: {
                    customerId: customerId,
                    amount: totalAmount,
                    modeOfPayment: modeOfPayment, // Use the provided payment method
                    receiptNumber: receiptNumber,  // Add receipt number here
                    paymentId: payment.id,  // Link the created payment
                    paidBy: paidBy,  // Include the paidBy field
                    createdAt: new Date() // Set createdAt timestamp
                },
            });

            receipts.push(receipt);

            // Update the customer's closing balance
            await prisma.customer.update({
                where: { id: customerId },
                data: {
                    closingBalance: newClosingBalance,
                },
            });

            return res.status(200).json({
                message: 'No unpaid invoices found. Payment processed as overpayment.',
                receipts,
                updatedInvoices,
                payments,
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

            // Generate a unique receipt number
            const receiptNumber = generateReceiptNumber();

            // Create a payment record for the invoice payment
            const payment = await prisma.payment.create({
                data: {
                    amount: paymentForInvoice,
                    modeOfPayment: modeOfPayment,
                    receipted: true, // Mark payment as receipted
                    createdAt: new Date() // Set createdAt timestamp
                },
            });

            payments.push(payment);

            // Create a receipt for the payment
            const receipt = await prisma.receipt.create({
                data: {
                    customerId: customerId,
                    amount: paymentForInvoice,
                    modeOfPayment: modeOfPayment,
                    receiptNumber: receiptNumber,
                    paymentId: payment.id,
                    paidBy: paidBy,
                    createdAt: new Date() // Set createdAt timestamp
                },
            });

            receipts.push(receipt);

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
