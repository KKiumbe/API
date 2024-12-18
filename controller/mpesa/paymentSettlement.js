const { PrismaClient } = require('@prisma/client');
const { sendSMS } = require('../../routes/sms/sms');
const prisma = new PrismaClient();

async function generateUniqueReceiptNumber() {
    let receiptNumber;
    let exists = true;

    while (exists) {
        const randomDigits = Math.floor(10000 + Math.random() * 90000);
        receiptNumber = `RCPT${randomDigits}`;
        exists = await prisma.receipt.findUnique({
            where: { receiptNumber },
        }) !== null;
    }

    return receiptNumber;
}

async function settleInvoice() {
    try {
        const mpesaTransactions = await prisma.mpesaTransaction.findMany({
            where: { processed: false },
        });

        if (mpesaTransactions.length === 0) {
            console.log("No unprocessed Mpesa transactions found.");
            return;
        }

        for (const transaction of mpesaTransactions) {
            const { BillRefNumber, TransAmount, id, FirstName, MSISDN: phone, TransID: MpesaCode, TransTime } = transaction;

            console.log(`Processing transaction: ${id} for amount: ${TransAmount}`);
            const paymentAmount = parseFloat(TransAmount);

            if (isNaN(paymentAmount) || paymentAmount <= 0) {
                console.log(`Invalid payment amount for transaction ${id}. Skipping.`);
                continue;
            }

            const existingPayment = await prisma.payment.findUnique({
                where: { TransactionId: MpesaCode },
            });

            if (existingPayment) {
                console.log(`Mpesa transaction ${MpesaCode} already exists in payment table. Skipping.`);
                continue;
            }

            const customer = await prisma.customer.findUnique({
                where: { phoneNumber: BillRefNumber },
                select: { id: true, closingBalance: true, phoneNumber: true, firstName: true },
            });

            if (!customer) {
                console.log(`No customer found with BillRefNumber ${BillRefNumber}.`);
                await prisma.payment.create({
                    data: {
                        amount: paymentAmount,
                        modeOfPayment: 'MPESA',
                        TransactionId: MpesaCode,
                        firstName: FirstName,
                        receipted: false,
                        createdAt: TransTime,
                        Ref: BillRefNumber 
                    },
                });
                continue;
            }

            const payment = await prisma.payment.create({
                data: {
                    amount: paymentAmount,
                    modeOfPayment: 'MPESA',
                    TransactionId: MpesaCode,
                    firstName: FirstName,
                    receipted: false,
                    createdAt: TransTime,
                    receiptId: null,
                    Ref: BillRefNumber 
                },
            });

            const receiptNumber = await generateUniqueReceiptNumber();
            const { receipts, newClosingBalance } = await processInvoices(paymentAmount, customer.id, payment.id);

            const receiptData = await prisma.receipt.create({
                data: {
                    amount: paymentAmount,
                    modeOfPayment: 'MPESA',
                    paidBy: FirstName,
                    transactionCode: MpesaCode,
                    phoneNumber: phone,
                    paymentId: payment.id,
                    customerId: customer.id,
                    receiptInvoices: {
                        create: receipts,
                    },
                    receiptNumber,
                    createdAt: new Date(),
                },
            });

            await prisma.payment.update({
                where: { id: payment.id },
                data: { receiptId: receiptData.id },
            });

            await prisma.mpesaTransaction.update({
                where: { id },
                data: { processed: true },
            });

            const finalClosingBalance = newClosingBalance;
            const formattedBalanceMessage = finalClosingBalance < 0
                ? `Your Current balance is an overpayment of KES ${Math.abs(finalClosingBalance)}`
                : `Your Current balance is KES ${finalClosingBalance}`;

            const message = `Dear ${customer.firstName}, payment of KES ${paymentAmount} received successfully. ${formattedBalanceMessage}. Help us serve you better by using Paybill No: 4107197, your phone number as the account number. Customer support number: 0726594923.`;

            await sendSMS(message, customer);
            console.log(`Processed payment and created receipt for transaction ${MpesaCode}.`);
        }
    } catch (error) {
        console.error('Error processing Mpesa transactions in settleInvoice:', error);
    }
}

async function processInvoices(paymentAmount, customerId, paymentId) {
    const invoices = await prisma.invoice.findMany({
        where: {
            customerId,
            status: {
                in: ['UNPAID', 'PPAID'], // Only unpaid or partially paid invoices
            },
        },
        orderBy: { createdAt: 'asc' }, // Process oldest invoices first
    });

    let remainingAmount = paymentAmount;
    const receipts = [];

    const result = await prisma.$transaction(async (tx) => {
        await tx.payment.update({
            where: { id: paymentId },
            data: { receipted: true },
        });

        if (invoices.length === 0) {
            const customer = await tx.customer.findUnique({
                where: { id: customerId },
                select: { closingBalance: true },
            });

            const newClosingBalance = customer.closingBalance - paymentAmount;

            await tx.customer.update({
                where: { id: customerId },
                data: { closingBalance: newClosingBalance },
            });

            receipts.push({
                invoiceId: null, // Indicates adjustment to closing balance
            });

            remainingAmount = 0;

            return { receipts, remainingAmount, newClosingBalance };
        }

        for (const invoice of invoices) {
            if (remainingAmount <= 0) break;

            const invoiceDueAmount = invoice.invoiceAmount - invoice.amountPaid;
            const paymentForInvoice = Math.min(remainingAmount, invoiceDueAmount);

            const updatedInvoice = await tx.invoice.update({
                where: { id: invoice.id },
                data: {
                    amountPaid: invoice.amountPaid + paymentForInvoice,
                    status: invoice.amountPaid + paymentForInvoice >= invoice.invoiceAmount ? 'PAID' : 'PPAID',
                },
            });

            receipts.push({ invoiceId: updatedInvoice.id });
            remainingAmount -= paymentForInvoice;
        }

        const customer = await tx.customer.findUnique({
            where: { id: customerId },
            select: { closingBalance: true },
        });

        const newClosingBalance = customer.closingBalance - paymentAmount;

        if (remainingAmount > 0) {
            await tx.customer.update({
                where: { id: customerId },
                data: { closingBalance: newClosingBalance },
            });

            receipts.push({
                invoiceId: null, // Indicates adjustment to closing balance
            });

            remainingAmount = 0;
        }

        return { receipts, remainingAmount, newClosingBalance };
    });

    return result;
}

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

module.exports = { settleInvoice };
