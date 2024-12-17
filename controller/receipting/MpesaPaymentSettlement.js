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
            // Retrieve customer data
            const customer = await tx.customer.findUnique({
                where: { id: customerId },
                select: { id: true, closingBalance: true, phoneNumber: true, firstName: true },
            });
            if (!customer) throw new Error('Customer not found.');

            // Retrieve payment data
            const payment = await tx.payment.findUnique({
                where: { id: paymentId },
                select: { amount: true, receipted: true },
            });
            if (!payment) throw new Error('Payment not found.');
            if (payment.receipted) throw new Error('Payment already receipted.');

            const totalAmount = payment.amount;

            // Mark payment as receipted
            await tx.payment.update({
                where: { id: paymentId },
                data: { receipted: true },
            });

            // Fetch unpaid/partially paid invoices
            const invoices = await tx.invoice.findMany({
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
                const updatedInvoice = await tx.invoice.update({
                    where: { id: invoice.id },
                    data: {
                        amountPaid: invoice.amountPaid + paymentForInvoice,
                        status: (invoice.amountPaid + paymentForInvoice) >= invoice.invoiceAmount ? 'PAID' : 'PPAID',
                    },
                });

                updatedInvoices.push(updatedInvoice);
                appliedToInvoices += paymentForInvoice;

                // Create receipt for this invoice
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
                remainingAmount -= paymentForInvoice;
            }

            // Handle remaining unmatched payment
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

            // Calculate and update customer's closing balance
            const finalClosingBalance = Math.round(customer.closingBalance - appliedToInvoices - remainingAmount);

            console.log(`
                Customer ID: ${customerId}
                Original Closing Balance: ${customer.closingBalance}
                Applied to Invoices: ${appliedToInvoices}
                Remaining Amount: ${remainingAmount}
                Final Closing Balance: ${finalClosingBalance}
            `);

            const updatedCustomer = await tx.customer.update({
                where: { id: customerId },
                data: { closingBalance: finalClosingBalance },
            });

            // Return results
            return {
                receipts,
                updatedInvoices,
                newClosingBalance: updatedCustomer.closingBalance,
            };
        });

        // Successful response after transaction
        res.status(201).json({
            message: 'Payment processed successfully.',
            receipts: result.receipts,
            updatedInvoices: result.updatedInvoices,
            newClosingBalance: result.newClosingBalance,
        });

        // Send confirmation SMS
        const balanceMessage =
            result.newClosingBalance < 0
                ? `Your closing balance is an overpayment of KES ${Math.abs(result.newClosingBalance)}`
                : `Your closing balance is KES ${result.newClosingBalance}`;
        const text = `Dear customer, payment of KES ${req.body.amount} was received successfully. ${balanceMessage}. Thank you!`;

        await sendSMS(text, { phoneNumber: result.receipts[0]?.mobile, id: customerId });

    } catch (error) {
        console.error('Error processing payment:', error.message);
        res.status(500).json({ error: 'Failed to process payment.', details: error.message });
    }
};

const sendSMS = async (text, customer) => {
    try {
        if (!customer.phoneNumber) throw new Error("Customer's phone number is missing.");

        const clientsmsid = Math.floor(Math.random() * 1000000);

        // Create SMS record
        const smsRecord = await prisma.sms.create({
            data: {
                clientsmsid,
                customerId: customer.id,
                mobile: customer.phoneNumber,
                message: text,
                status: 'pending',
            },
        });

        const payload = {
            apikey: SMS_API_KEY,
            partnerID: PARTNER_ID,
            message: text,
            shortcode: SHORTCODE,
            mobile: customer.phoneNumber,
        };

        console.log("Sending SMS payload:", JSON.stringify(payload));
        const response = await axios.post(SMS_ENDPOINT, payload);

        // Update SMS status to 'sent'
        await prisma.sms.update({
            where: { id: smsRecord.id },
            data: { status: 'sent' },
        });

        return response.data;
    } catch (error) {
        console.error('Error sending SMS:', error);
        throw new Error(error.response ? error.response.data : 'Failed to send SMS.');
    }
};

module.exports = { MpesaPaymentSettlement };
