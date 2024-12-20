// controller/createCustomer.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// PUT: Update a customer
const editCustomer = async (req, res) => {
  const customerId = req.params.id; // Get the customer ID from the URL
  const {
    firstName,
    lastName,
    email,
    phoneNumber,
    gender,
    county,
    town,
    status,
    location,
    estateName,           // Optional field for estate name
    building,              // Optional field for building name
    houseNumber,           // Optional field for house number
    category,
    monthlyCharge,
    garbageCollectionDay,  
    collected,
    closingBalance
   

    

  } = req.body;

  // Check if the customer ID is provided
  if (!customerId) {
    return res.status(400).json({ message: 'Customer ID is required' });
  }

  try {
    // Find and update the customer using Prisma
    const updatedCustomer = await prisma.customer.update({
      where: { id: customerId },
      data: {
    firstName,
    lastName,
    email,
    phoneNumber,
    gender,
    county,
    town,
    status,
    location,
    estateName,           // Optional field for estate name
    building,              // Optional field for building name
    houseNumber,           // Optional field for house number
    category,
    monthlyCharge,
    garbageCollectionDay,  
    collected,
    closingBalance
      },
    });

    // Check if the customer was not found
    if (!updatedCustomer) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    // Return the updated customer data
    res.status(200).json(updatedCustomer);
  } catch (error) {
    console.error('Error updating customer:', error);
    res.status(500).json({ message: 'Error updating customer' });
  }
};

module.exports = { editCustomer };
