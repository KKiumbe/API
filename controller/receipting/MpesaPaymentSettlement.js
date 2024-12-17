const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const axios = require('axios');

const SMS_API_KEY = process.env.SMS_API_KEY;
const PARTNER_ID = process.env.PARTNER_ID;
const SHORTCODE = process.env.SHORTCODE;
const SMS_ENDPOINT = process.env.SMS_ENDPOINT;

function generateReceiptNumber() {
    const randomDigits = Math.floor(10000 + Math.random() * 900000);
    return `RCPT${randomDigits}`;
}

const MpesaPaymentSettlement = async (req, res) => {
    const { customerId, modeOfPayment, paidBy, paymentId } = req.body;

    if (!customerId || !modeOfPayment || !paidBy || !paymentId) {
        return res.status(400).json({ message: 'Missing required fields.' });
    }

    try {
        const result = await prisma.$transaction(async (tx) => {
            // Step 1: Retrieve customer data
            const customer = await tx.customer.findUnique({
                where: { id: customerId },
                select: { id: true, closingBalance: true, phoneNumber: true, firstName: true },
            });

            if (!customer) throw new Error('Customer not found.');

            // Step 2: Retrieve payment data
            const payment = await tx.payment.findUnique({
                where: { id: paymentId },
                select: { amount: true, receipted: true },
            });

            if (!payment) throw new Error('Payment not found.');
            if (payment.receipted) throw new Error('Payment already receipted.');

            const totalAmount = payment.amount;
            console.log(`this is the total amount paid ${totalAmount}`);

            // Step 3: Update customer closing balance immediately
            const updatedClosingBalance = customer.closingBalance - totalAmount;

            console.log(`this is the total amount paid ${updatedClosingBalance}`);

            await tx.customer.update({
                where: { id: customerId },
                data: { closingBalance: updatedClosingBalance },
            });

            // Step 4: Mark the payment as receipted
            await tx.payment.update({
                where: { id: paymentId },
                data: { receipted: true },
            });

            let remainingAmount = totalAmount;
            const receipts = [];

            // Step 5: Fetch and process unpaid/partially paid invoices
            const invoices = await tx.invoice.findMany({
                where: { customerId, OR: [{ status: 'UNPAID' }, { status: 'PPAID' }] },
                orderBy: { createdAt: 'asc' },
            });

            for (const invoice of invoices) {
                if (remainingAmount <= 0) break;

                const invoiceDue = invoice.invoiceAmount - invoice.amountPaid;
                const paymentForInvoice = Math.min(remainingAmount, invoiceDue);

                // Update invoice amountPaid and status
                await tx.invoice.update({
                    where: { id: invoice.id },
                    data: {
                        amountPaid: { increment: paymentForInvoice },
                        status: (invoice.amountPaid + paymentForInvoice) >= invoice.invoiceAmount ? 'PAID' : 'PPAID',
                    },
                });

                remainingAmount -= paymentForInvoice;

                // Create a receipt for this invoice
                const receiptNumber = generateReceiptNumber();
                const receipt = await tx.receipt.create({
                    data: {
                        customerId,
                        amount: paymentForInvoice,
                        modeOfPayment,
                        receiptNumber,
                        paymentId,
                        paidBy,
                        createdAt: new Date(),
                    },
                });
                receipts.push(receipt);
            }

            // Step 6: Handle any remaining unmatched payment (overpayment)
            if (remainingAmount > 0) {
                const unmatchedReceiptNumber = generateReceiptNumber();
                const unmatchedReceipt = await tx.receipt.create({
                    data: {
                        customerId,
                        amount: remainingAmount,
                        modeOfPayment,
                        receiptNumber: unmatchedReceiptNumber,
                        paymentId,
                        paidBy,
                        createdAt: new Date(),
                    },
                });
                receipts.push(unmatchedReceipt);
            }

            return {
                receipts,
                newClosingBalance: updatedClosingBalance,
            };
        });

        // Send success response
        res.status(201).json({
            message: 'Payment processed successfully.',
            receipts: result.receipts,
            newClosingBalance: result.newClosingBalance,
        });

        // Send SMS confirmation
        const balanceMessage = result.newClosingBalance < 0
            ? `Your closing balance is an overpayment of KES ${Math.abs(result.newClosingBalance)}`
            : `Your closing balance is KES ${result.newClosingBalance}`;
        const text = `Dear Customer, payment of KES ${req.body.totalAmount} received successfully. ${balanceMessage}. Thank you!`;

        await sendSMS(text, customerId);
    } catch (error) {
        console.error('Error processing payment:', error.message);
        res.status(500).json({ error: 'Failed to process payment.', details: error.message });
    }
};

const sendSMS = async (text, customerId) => {
    try {
        const customer = await prisma.customer.findUnique({
            where: { id: customerId },
            select: { phoneNumber: true },
        });

        if (!customer || !customer.phoneNumber) throw new Error('Invalid phone number.');

        const payload = {
            apikey: SMS_API_KEY,
            partnerID: PARTNER_ID,
            message: text,
            shortcode: SHORTCODE,
            mobile: customer.phoneNumber,
        };

        console.log('Sending SMS:', payload);
        await axios.post(SMS_ENDPOINT, payload);
    } catch (error) {
        console.error('Failed to send SMS:', error.message);
    }
};

module.exports = { MpesaPaymentSettlement };
