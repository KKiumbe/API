const express = require('express');
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');

const prisma = new PrismaClient();
const router = express.Router();

// Load environment variables
const SMS_API_KEY = process.env.SMS_API_KEY;
const PARTNER_ID = process.env.PARTNER_ID;
const SHORTCODE = process.env.SHORTCODE;
const BULK_SMS_ENDPOINT = process.env.BULK_SMS_ENDPOINT;
const SMS_ENDPOINT = process.env.SMS_ENDPOINT;

// Function to sanitize the phone number
const sanitizePhoneNumber = (phone) => {
  if (phone.startsWith('254')) {
    return phone; // Already in the correct format
  } else if (phone.startsWith('0')) {
    return '254' + phone.slice(1); // Replace leading '0' with '254'
  } else {
    return '254' + phone; // Assume it's a local number without a prefix
  }
};

// Send SMS to a group of customers
router.post('/send-to-group', async (req, res) => {
  const { day, message } = req.body; // Get the day and message from the request body

  // Validate request body
  if (!day || !message) {
    return res.status(400).json({ error: 'Day and message are required.' });
  }

  try {
    // Fetch customers for the specified collection day
    const customers = await prisma.customer.findMany({
      where: {
        garbageCollectionDay: day.toUpperCase(), // Ensure the day is in the correct format
        status: 'ACTIVE', // Only fetch active customers
      },
    });

    // Prepare SMS payload for each recipient
    const smsList = customers.map((customer) => {
      const mobile = sanitizePhoneNumber(customer.phoneNumber);
      return {
        partnerID: PARTNER_ID,
        apikey: SMS_API_KEY,
        pass_type: "plain",
        clientsmsid: Math.floor(Math.random() * 10000), // Ensure this is unique if required
        mobile: mobile,
        message: message,
        shortcode: SHORTCODE,
      };
    });

    // Send the bulk SMS
    const response = await axios.post(BULK_SMS_ENDPOINT, {
      count: smsList.length,
      smslist: smsList,
    });

    console.log(`Sent ${smsList.length} bulk SMS messages.`);
    return res.status(200).json({ message: `Sent ${smsList.length} SMS messages.`, data: response.data });
  } catch (error) {
    console.error('Error sending bulk SMS:', error);
    const errorMessage = error.response ? error.response.data : 'Failed to send SMS.';
    return res.status(500).json({ error: errorMessage });
  }
});

// Send a single SMS
router.post('/send-sms', async (req, res) => {
  const { mobile, message } = req.body; // Extract mobile and message from request body

  // Validate input
  if (!mobile || !message) {
    return res.status(400).json({ error: 'Mobile number and message are required.' });
  }

  // Sanitize the mobile number
  const sanitizedMobile = sanitizePhoneNumber(mobile);

  try {
    const payload = {
      apikey: SMS_API_KEY,
      partnerID: PARTNER_ID,
      shortcode: SHORTCODE,
      message: message,
      mobile: sanitizedMobile,
    };

    // Send the SMS request
    const response = await axios.post(SMS_ENDPOINT, payload);
    
    // Return success response
    return res.status(response.status).json({ message: 'SMS sent successfully!', data: response.data });
  } catch (error) {
    console.error('Error sending SMS:', error);
    const errorMessage = error.response ? error.response.data : 'Failed to send SMS.';
    return res.status(500).json({ error: errorMessage });
  }
});

// Send bills to all active customers
router.post('/send-bills', async (req, res) => {
    try {
        // Fetch all active customers with unpaid invoices
        const activeCustomers = await prisma.customer.findMany({
            where: {
                status: 'ACTIVE',
            },
            include: {
                invoices: {
                    where: {
                        status: 'UNPAID',
                    },
                    orderBy: {
                        createdAt: 'desc', // Ensure the latest invoice is first
                    },
                },
            },
        });

        // Prepare messages for each customer
        const messages = activeCustomers.map(customer => {
            const invoices = customer.invoices;
            
            if (invoices.length === 0) {
                return null; // Skip customers with no unpaid invoices
            }

            // Current balance is the amount of the latest unpaid invoice
            const currentInvoice = invoices[0];
            const currentBalance = currentInvoice.invoiceAmount;

            // Previous balance is the sum of all previous unpaid invoices (excluding the latest one)
            const previousBalance = invoices.slice(1).reduce((sum, invoice) => sum + invoice.invoiceAmount, 0);

            // Total balance is the current invoice amount plus previous balances
            const totalBalance = currentBalance + previousBalance;

            return {
                phoneNumber: customer.phoneNumber,
                message: `Hello ${customer.firstName}, your previous balance was KES ${previousBalance}. Your current bill is KES ${currentBalance}. Total balance is KES ${totalBalance}. Please pay your bills.`,
            };
        }).filter(message => message !== null); // Filter out null messages

        // Send SMS to each customer
        if (messages.length > 0) {
            const smsResponses = await sendSms(messages);
            res.status(200).json({
                message: 'Bills sent successfully',
                smsResponses,
            });
        } else {
            res.status(200).json({
                message: 'No bills to send, all customers are current.',
            });
        }
    } catch (error) {
        console.error('Error sending bills:', error);
        res.status(500).json({ error: 'Failed to send bills.' });
    }
});

// Function to send SMS to a list of recipients
const sendSms = async (messages) => {
    // Prepare the SMS list payload for the bulk SMS API
    const smsList = messages.map(({ phoneNumber, message }) => ({
      partnerID: PARTNER_ID,
      apikey: SMS_API_KEY,
      pass_type: "plain",
      clientsmsid: Math.floor(Math.random() * 10000), // Ensure this is unique if required
      message: message,
      shortcode: SHORTCODE,
      mobile: sanitizePhoneNumber(phoneNumber),
       
    }));

    try {
        const response = await axios.post(BULK_SMS_ENDPOINT, {
            count: smsList.length,
            smslist: smsList,
        });
        return response.data;
    } catch (error) {
        console.error('Error sending bulk SMS:', error);
        throw error;
    }
};

module.exports = router;
