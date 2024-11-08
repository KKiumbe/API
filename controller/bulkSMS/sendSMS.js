const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function checkSmsBalance() {
  try {
    const response = await axios.post(process.env.SMS_BALANCE_URL, {
      apikey: process.env.SMS_API_KEY,
      partnerID: process.env.PARTNER_ID,
    });
    return response.data.balance; // Adjust based on actual API response structure
  } catch (error) {
    console.error('Error fetching SMS balance:', error);
    throw new Error('Failed to retrieve SMS balance');
  }
}


async function generateBulkBillSmsMessage() {
  const ENDPOINT = process.env.BULK_SMS_ENDPOINT;

  try {
    // Fetch active customers
    const activeCustomers = await prisma.customer.findMany({
      where: { status: 'ACTIVE' }
    });

    // Check SMS balance before proceeding
    const balance = await checkSmsBalance();
    const customerCount = activeCustomers.length;

    // Check if the balance is sufficient (at least twice the number of customers)
    if (balance < customerCount * 2) {
      console.log('Insufficient SMS balance. Requires at least twice the number of active customers.');
      throw new Error('Insufficient SMS balance.');
    }

    // Prepare the bulk SMS request body
    const smsList = await Promise.all(
      activeCustomers.map(async (customer) => {
        const latestInvoice = await prisma.invoice.findFirst({
          where: { customerId: customer.id },
          orderBy: { createdAt: 'desc' }
        });

        if (!latestInvoice) return null;

        const currentMonthBill = latestInvoice.invoiceAmount;
        const closingBalance = latestInvoice.closingBalance;
        const customerName = `${customer.firstName} ${customer.lastName}`;
        const month = new Date().toLocaleString('default', { month: 'long' });

        const mobile = customer.phoneNumber.startsWith('0')
          ? `254${customer.phoneNumber.slice(1)}`
          : customer.phoneNumber.startsWith('+')
          ? customer.phoneNumber.slice(1)
          : customer.phoneNumber;

        const message = `Dear ${customerName}, your ${month} bill is ${currentMonthBill}, your previous balance is ${closingBalance - currentMonthBill}, and your total balance is ${closingBalance}. Help us serve you better by always paying on time. Paybill No :4107197 , your phone number as the account number. Customer support: 0726594923.`;

      
        const clientsmsid = uuidv4();

        await prisma.sms.create({
          data: {
            clientsmsid,
            customerId: customer.id,
            mobile,
            message,
            status: 'pending', // Set initial status to pending
          },
        });

        return {
          partnerID: process.env.PARTNER_ID,
          apikey: process.env.SMS_API_KEY,
          pass_type: "plain",
          clientsmsid,
          mobile,
          message,
          shortcode: process.env.SHORTCODE,
        };
      })
    );

    const filteredSmsList = smsList.filter(sms => sms !== null);

    if (filteredSmsList.length > 0) {
      const response = await axios.post(ENDPOINT, {
        count: filteredSmsList.length,
        smslist: filteredSmsList
      });

      if (response.data.success) {
        const sentIds = filteredSmsList.map(sms => sms.clientsmsid);

        // Update SMS status to "sent" in the database
        await prisma.sms.updateMany({
          where: { clientsmsid: { in: sentIds } },
          data: { status: 'sent' }
        });

        console.log(`Updated status to 'sent' for ${sentIds.length} SMS records.`);
      }

      console.log(`Sent ${filteredSmsList.length} bulk SMS messages.`);
      return response.data;

    } else {
      console.log('No active customers with invoices to send SMS.');
      return null;
    }
  } catch (error) {
    console.error('Error generating bulk SMS:', error);
    throw error;
  }
}

module.exports = { generateBulkBillSmsMessage };
