const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const axios = require('axios');

const SMS_API_KEY = process.env.SMS_API_KEY;
const PARTNER_ID = process.env.PARTNER_ID;
const SHORTCODE = process.env.SHORTCODE;
const SMS_ENDPOINT = process.env.SMS_ENDPOINT;
const SMS_BALANCE_URL = process.env.SMS_BALANCE_URL;

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
        // Retrieve customer data
        const customer = await prisma.customer.findUnique({
            where: { id: customerId },
            select: { id: true, closingBalance: true, phoneNumber: true, firstName: true },
        });

        if (!customer) {
            return res.status(404).json({ message: 'Customer not found.' });
        }

        // Retrieve the payment amount
        const payment = await prisma.payment.findUnique({
            where: { id: paymentId },
            select: { amount: true, receipted: true },
        });

        if (!payment) return res.status(404).json({ message: 'Payment not found.' });
        if (payment.receipted) return res.status(400).json({ message: 'Payment already receipted.' });

        const totalAmount = payment.amount;

        // Mark the payment as receipted
        await prisma.payment.update({
            where: { id: paymentId },
            data: { receipted: true },
        });

        // Fetch unpaid/partially paid invoices
        const invoices = await prisma.invoice.findMany({
            where: { customerId, OR: [{ status: 'UNPAID' }, { status: 'PPAID' }] },
            orderBy: { createdAt: 'asc' },
        });

        let remainingAmount = totalAmount;
        let appliedToInvoices = 0;
        const receipts = [];
        const updatedInvoices = [];

        for (const invoice of invoices) {
            if (remainingAmount <= 0) break;

            const invoiceDue = invoice.invoiceAmount - invoice.amountPaid;
            const paymentForInvoice = Math.min(remainingAmount, invoiceDue);

            // Update invoice
            const updatedInvoice = await prisma.invoice.update({
                where: { id: invoice.id },
                data: {
                    amountPaid: invoice.amountPaid + paymentForInvoice,
                    status: (invoice.amountPaid + paymentForInvoice) >= invoice.invoiceAmount ? 'PAID' : 'PPAID',
                },
            });

            updatedInvoices.push(updatedInvoice);
            appliedToInvoices += paymentForInvoice;

            // Create a receipt for this invoice
            const receiptNumber = generateReceiptNumber();
            const receipt = await prisma.receipt.create({
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
            remainingAmount -= paymentForInvoice;
        }

        // Handle any remaining amount
        if (remainingAmount > 0) {
            const unmatchedReceiptNumber = generateReceiptNumber();
            const unmatchedReceipt = await prisma.receipt.create({
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

        // Update customer's closing balance dynamically
        const finalClosingBalance = customer.closingBalance - appliedToInvoices - remainingAmount;

        console.log(`Final Closing Balance for Customer ID ${customerId}: ${finalClosingBalance}`);

        const updatedCustomer = await prisma.customer.update({
            where: { id: customerId },
            data: { closingBalance: finalClosingBalance },
        });

        console.log(`Updated Closing Balance in DB: ${updatedCustomer.closingBalance}`);

        // Return response
        res.status(201).json({
            message: 'Payment processed successfully.',
            receipts,
            updatedInvoices,
            newClosingBalance: updatedCustomer.closingBalance,
        });

        // Send confirmation SMS
        const balanceMessage = finalClosingBalance < 0
            ? `Your closing balance is an overpayment of KES ${Math.abs(finalClosingBalance)}`
            : `Your closing balance is KES ${finalClosingBalance}`;
        const text = `Dear ${customer.firstName}, payment of KES ${totalAmount} received successfully. ${balanceMessage}. Thank you!`;

        await sendSMS(text, customer);

    } catch (error) {
        console.error('Error processing payment:', error);
        res.status(500).json({ error: 'Failed to process payment.', details: error.message });
    }
};



const sendSMS = async (text, customer) => {
    try {
        if (!customer.phoneNumber) {
            throw new Error("Customer's phone number is missing.");
        }

        const mobile = customer.phoneNumber;
        const clientsmsid = Math.floor(Math.random() * 1000000);

        const smsRecord = await prisma.sms.create({
            data: {
                clientsmsid,
                customerId: customer.id,
                mobile,
                message: text,
                status: 'pending',
            },
        });

        const payload = {
            apikey: SMS_API_KEY,
            partnerID: PARTNER_ID,
            message: text,
            shortcode: SHORTCODE,
            mobile,
        };

        console.log("This is payload:", JSON.stringify(payload));
        const response = await axios.post(SMS_ENDPOINT, payload);

        await prisma.sms.update({
            where: { id: smsRecord.id },
            data: { status: 'sent' },
        });

        return response.data;
    } catch (error) {
        console.error('Error sending SMS:', error);
        if (clientsmsid) {
            await prisma.sms.update({
                where: { clientsmsid },
                data: { status: 'failed' },
            });
        }

        throw new Error(error.response ? error.response.data : 'Failed to send SMS.');
    }
};

module.exports = { MpesaPaymentSettlement };
