const { PrismaClient } = require('@prisma/client');
const { sendSMS } = require('../../routes/sms/sms');
const prisma = new PrismaClient();

function generateReceiptNumber() {
    const randomDigits = Math.floor(10000 + Math.random() * 90000);
    return `RCPT${randomDigits}`;
}

const manualCashPayment = async (req, res) => {
    const { customerId, totalAmount, modeOfPayment, paidBy } = req.body;

    // Validate required fields
    if (!customerId || !totalAmount || !modeOfPayment || !paidBy) {
        return res.status(400).json({ message: 'Missing required fields.' });
    }

    try {
        // Step 1: Retrieve the customer
        const customer = await prisma.customer.findUnique({
            where: { id: customerId },
            select: { id: true, closingBalance: true, phoneNumber: true, firstName: true },
        });

        if (!customer) {
            return res.status(404).json({ message: 'Customer not found.' });
        }

        // Step 2: Create a payment record
        const payment = await prisma.payment.create({
            data: {
                amount: totalAmount,
                modeOfPayment: modeOfPayment,
                createdAt: new Date(),
            },
        });

        // Step 3: Get unpaid invoices for the customer
        const invoices = await prisma.invoice.findMany({
            where: { customerId: customerId, status: 'UNPAID' },
            orderBy: { createdAt: 'asc' },
        });

        // Initialize variables for payment processing
        let remainingAmount = totalAmount;
        const receipts = []; // Store created receipts for each invoice
        const updatedInvoices = []; // Track updated invoices

        // Step 4: Allocate payment to invoices
        for (const invoice of invoices) {
            if (remainingAmount <= 0) break;

            const invoiceDue = invoice.invoiceAmount - invoice.amountPaid;
            const paymentForInvoice = Math.min(remainingAmount, invoiceDue);

            // Update invoice with the paid amount
            const updatedInvoice = await prisma.invoice.update({
                where: { id: invoice.id },
                data: {
                    amountPaid: invoice.amountPaid + paymentForInvoice,
                    status: invoice.amountPaid + paymentForInvoice >= invoice.invoiceAmount ? 'PAID' : 'UNPAID',
                },
            });
            updatedInvoices.push(updatedInvoice);

            // Generate a unique receipt number
            const receiptNumber = generateReceiptNumber();

            // Create a receipt for this payment
            const receipt = await prisma.receipt.create({
                data: {
                    customerId: customerId,
                    amount: paymentForInvoice,
                    modeOfPayment: modeOfPayment,
                    receiptNumber: receiptNumber,
                    paymentId: payment.id, // Link to the created payment
                    paidBy: paidBy,
                    createdAt: new Date(),
                },
            });
            receipts.push(receipt);

            remainingAmount -= paymentForInvoice;
        }

        // Step 5: Handle overpayment
        let finalClosingBalance = customer.closingBalance;
        if (remainingAmount > 0) {
            finalClosingBalance -= remainingAmount; // Deduct overpayment from closing balance

            // Generate a unique receipt number for the overpayment
            const overpaymentReceiptNumber = generateReceiptNumber();
            const overpaymentReceipt = await prisma.receipt.create({
                data: {
                    customerId: customerId,
                    amount: remainingAmount,
                    modeOfPayment: modeOfPayment,
                    receiptNumber: overpaymentReceiptNumber,
                    paymentId: payment.id, // Link to the created payment
                    paidBy: paidBy,
                    createdAt: new Date(),
                },
            });
            receipts.push(overpaymentReceipt);
        }

        // Update the customer's closing balance
        await prisma.customer.update({
            where: { id: customerId },
            data: { closingBalance: finalClosingBalance },
        });

        res.status(201).json({
            message: 'Manual cash payment processed successfully.',
            receipts,
            updatedInvoices,
            newClosingBalance: finalClosingBalance,
        });

        // Construct the SMS message
        const formattedBalanceMessage = finalClosingBalance < 0
            ? `Your closing balance is an overpayment of KES ${Math.abs(finalClosingBalance)}`
            : `Your closing balance is KES ${finalClosingBalance}`;

        const message = `Dear ${customer.firstName}, payment of KES ${totalAmount} received successfully. ${formattedBalanceMessage}. Thank you for your payment!`;
        const sanitisedNumber = sanitizePhoneNumber(customer.phoneNumber);
        await sendSMS(sanitisedNumber, message);

    } catch (error) {
        console.error('Error creating manual cash payment:', error);
        res.status(500).json({ error: 'Failed to create manual cash payment.', details: error.message });
    }
};

function sanitizePhoneNumber(phone) {
    if (typeof phone !== 'string') {
        console.error('Invalid phone number format:', phone);
        return '';
    }

    if (phone.startsWith('+254')) {
        return phone.slice(1);
    } else if (phone.startsWith('0')) {
        return `254${phone.slice(1)}`;
    } else if (phone.startsWith('254')) {
        return phone;
    } else {
        return `254${phone}`;
    }
}

module.exports = { manualCashPayment };
