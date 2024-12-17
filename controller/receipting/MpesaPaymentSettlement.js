const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const prisma = new PrismaClient();

// Environment variables for SMS service
const SMS_API_KEY = process.env.SMS_API_KEY;
const PARTNER_ID = process.env.PARTNER_ID;
const SHORTCODE = process.env.SHORTCODE;
const SMS_ENDPOINT = process.env.SMS_ENDPOINT;

// Generate a unique receipt number
function generateReceiptNumber() {
    const randomDigits = Math.floor(10000 + Math.random() * 900000);
    return `RCPT${randomDigits}`;
}

// Payment Settlement Function
const MpesaPaymentSettlement = async (req, res) => {
    const { customerId, modeOfPayment, paidBy, paymentId } = req.body;

    if (!customerId || !modeOfPayment || !paidBy || !paymentId) {
        return res.status(400).json({ message: 'Missing required fields.' });
    }

    try {
        // Use a transaction to ensure atomicity
        const result = await prisma.$transaction(async (tx) => {
            // Step 1: Fetch customer details
            const customer = await tx.customer.findUnique({
                where: { id: customerId },
                select: { closingBalance: true, phoneNumber: true, firstName: true },
            });
            if (!customer) throw new Error('Customer not found.');

            // Step 2: Fetch payment details
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

            let remainingAmount = totalAmount;
            const receipts = [];
            let appliedToInvoices = 0;

            // Step 3: Fetch unpaid or partially paid invoices
            const invoices = await tx.invoice.findMany({
                where: { customerId, OR: [{ status: 'UNPAID' }, { status: 'PPAID' }] },
                orderBy: { createdAt: 'asc' },
            });

            // Step 4: Apply payments to invoices
            if (invoices.length > 0) {
                for (const invoice of invoices) {
                    if (remainingAmount <= 0) break;

                    const invoiceDue = invoice.invoiceAmount - invoice.amountPaid;
                    const paymentForInvoice = Math.min(remainingAmount, invoiceDue);

                    // Update the invoice
                    await tx.invoice.update({
                        where: { id: invoice.id },
                        data: {
                            amountPaid: { increment: paymentForInvoice },
                            status: (invoice.amountPaid + paymentForInvoice) >= invoice.invoiceAmount ? 'PAID' : 'PPAID',
                        },
                    });

                    appliedToInvoices += paymentForInvoice;
                    remainingAmount -= paymentForInvoice;

                    // Create receipt for applied amount
                    const receiptNumber = generateReceiptNumber();
                    const receipt = await tx.receipt.create({
                        data: {
                            customerId,
                            amount: paymentForInvoice,
                            modeOfPayment,
                            receiptNumber,
                            paymentId,
                            paidBy,
                        },
                    });
                    receipts.push(receipt);
                }
            }

            // Step 5: Apply remaining amount directly to closing balance
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
                    },
                });
                receipts.push(unmatchedReceipt);
                appliedToInvoices += remainingAmount; // Reduce closing balance
            }

            // Step 6: Update customer's closing balance
            const finalClosingBalance = customer.closingBalance - appliedToInvoices;
            const updatedCustomer = await tx.customer.update({
                where: { id: customerId },
                data: { closingBalance: finalClosingBalance },
            });

            return { receipts, newClosingBalance: updatedCustomer.closingBalance };
        });

        // Success response
        res.status(201).json({
            message: 'Payment processed successfully.',
            receipts: result.receipts,
            newClosingBalance: result.newClosingBalance,
        });

    } catch (error) {
        console.error('Error processing payment:', error.message);
        res.status(500).json({ error: 'Failed to process payment.', details: error.message });
    }
};

// SMS Sending Function
const sendSMS = async (text, customer) => {
    try {
        if (!customer.phoneNumber) throw new Error("Customer's phone number is missing.");

        const clientsmsid = Math.floor(Math.random() * 1000000);

        // Create SMS record in database
        const smsRecord = await prisma.sms.create({
            data: {
                clientsmsid,
                customerId: customer.id,
                mobile: customer.phoneNumber,
                message: text,
                status: 'pending',
            },
        });

        // Construct the SMS payload
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
        console.error('Error sending SMS:', error.message);
        throw new Error(error.response ? error.response.data : 'Failed to send SMS.');
    }
};

module.exports = { MpesaPaymentSettlement };
