const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Helper function to generate a unique receipt number with "RCPT" prefix
async function generateUniqueReceiptNumber() {
    let receiptNumber;
    let exists = true;

    while (exists) {
        const randomDigits = Math.floor(10000 + Math.random() * 90000); // Generates a number between 10000 and 99999
        receiptNumber = `RCPT${randomDigits}`; // Prefix with "RCPT"

        exists = await prisma.receipt.findUnique({
            where: { receiptNumber: receiptNumber },
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
                where: { mpesaTransactionId: MpesaCode },
            });

            if (existingPayment) {
                console.log(`Mpesa transaction ${MpesaCode} already exists in payment table. Skipping.`);
                continue;
            }

            const customer = await prisma.customer.findUnique({
                where: { phoneNumber: BillRefNumber },
                select: { id: true, closingBalance: true },
            });

            if (!customer) {
                console.log(`No customer found with BillRefNumber ${BillRefNumber}.`);
                await createPaymentRecord(transaction, paymentAmount, FirstName, phone, MpesaCode, null);
                continue;
            }

            const payment = await prisma.payment.create({
                data: {
                    amount: paymentAmount,
                    modeOfPayment: 'MPESA',
                    mpesaTransactionId: MpesaCode,
                    receipted: false,
                    createdAt: TransTime,
                    receiptId: null,
                },
            });

            const receiptNumber = await generateUniqueReceiptNumber();

            // Retrieve and process invoices for the receipt creation
            const { receipts, remainingAmount } = await processInvoices(paymentAmount, customer.id, payment.id);

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
                    receiptNumber: receiptNumber,
                    createdAt: new Date(),
                },
            });

            await prisma.payment.update({
                where: { id: payment.id },
                data: { receiptId: receiptData.id },
            });

            await prisma.mpesaTransaction.update({
                where: { id: id },
                data: { processed: true },
            });

            console.log(`Processed payment and created receipt for transaction ${MpesaCode}.`);
        }
    } catch (error) {
        console.error('Error processing Mpesa transactions in settleInvoice:', error);
    }
}

async function processInvoices(paymentAmount, customerId, paymentId) {
    const invoices = await prisma.invoice.findMany({
        where: { customerId: customerId, status: 'UNPAID' },
    });

    let remainingAmount = paymentAmount;
    const receipts = []; 

    await prisma.payment.update({
        where: { id: paymentId },
        data: { receipted: true },
    });

    for (const invoice of invoices) {
        if (remainingAmount <= 0) break;

        const invoiceDueAmount = invoice.invoiceAmount - invoice.amountPaid;
        const paymentForInvoice = Math.min(remainingAmount, invoiceDueAmount);

        const updatedInvoice = await prisma.invoice.update({
            where: { id: invoice.id },
            data: {
                amountPaid: invoice.amountPaid + paymentForInvoice,
                status: invoice.amountPaid + paymentForInvoice >= invoice.invoiceAmount ? 'PAID' : 'UNPAID',
            },
        });

        receipts.push({
            invoiceId: updatedInvoice.id,
        });

        remainingAmount -= paymentForInvoice;
    }

    if (remainingAmount > 0) {
        const customer = await prisma.customer.findUnique({
            where: { id: customerId },
            select: { closingBalance: true },
        });

        const newClosingBalance = customer.closingBalance - paymentAmount;
        await prisma.customer.update({
            where: { id: customerId },
            data: { closingBalance: newClosingBalance },
        });

        console.log(`Overpayment detected. New closing balance: ${newClosingBalance}`);
    }

    return { receipts, remainingAmount };
}


module.exports = { settleInvoice };
