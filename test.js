const User = require("../model/user");
const nodemailer = require("nodemailer");
require("dotenv").config();
const { validationResult } = require("express-validator");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

// Import Crypto Cloud
const cryptoCloud = axios.create({
  baseURL: "https://api.cryptocloud.plus/v1",
  headers: { Authorization: `Token ${process.env.CRYPTOCLOUD_API_KEY}` },
});

exports.postDeposit = async (req, res, next) => {
  const { amount, paymentMethod } = req.body;
  // const user = req.session.user;

  try {
    if (paymentMethod === "fiat") {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: "Account Deposit",
              },
              unit_amount: amount * 100, // Convert to cents
            },
            quantity: 1,
          },
        ],
        success_url: `${req.protocol}://${req.get(
          "host"
        )}/payment-success?amount=${amount}`,
        cancel_url: `${req.protocol}://${req.get("host")}/`,
      });

      res.redirect(303, session.url);
    } else {
      res.redirect("/crypto");
    }
  } catch (err) {
    console.error("Deposit :", err);
    next(new Error(err));
  }
};

exports.paymentSuccess = async (req, res, next) => {
  try {
    const userId = req.session.user._id;
    const amount = parseFloat(req.query.amount);
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).send("User not found");
    }
    user.investmentAmount += amount;
    user.investmentDate = new Date();
    await user.save();
    res.render("payment-success", {
      pageTitle: "Payment Success",
      user,
      amount,
    });
  } catch (err) {
    next(new Error(err));
  }
};

exports.postWithdraw = async (req, res, next) => {
  try {
    const userId = req.session.user._id;
    const {
      amount,
      cryptoType,
      accountNumber,
      bankName,
      accountHolder,
      withdrawalType,
    } = req.body;

    // Find the user
    const user = await User.findById(userId);
    if (!user) {
      req.flash("error", "User not found");
      return res.redirect("/trade");
    }

    const withdrawAmount = parseFloat(amount);

    // Check if the user has enough balance
    if (withdrawAmount > user.investmentAmount) {
      req.flash("error", "Insufficient balance");
      return res.redirect("/trade");
    }

    if (withdrawalType === "crypto") {
      // Check if the selected crypto wallet exists
      const walletAddress = user.cryptoWallet[cryptoType];
      if (!walletAddress) {
        req.flash("error", "Invalid wallet selection");
        return res.redirect("/trade");
      }

      // Step 1: Deduct the amount from the Stripe balance
      const transfer = await stripe.stripe.payouts.create({
        amount: withdrawAmount * 100, // Convert to cents
        currency: "usd",
        destination: process.env.STRIPE_CONNECTED_ACCOUNT, // Your Stripe account
      });

      // Step 2: Deduct from user's investment
      user.investmentAmount -= withdrawAmount;
      await user.save();

      // Step 3: Convert USD to Crypto & Send to Selected Wallet
      const exchangeRate = await getExchangeRate("USD", cryptoType);
      const cryptoAmount = withdrawAmount / exchangeRate;

      console.log(`Sent ${cryptoAmount} ${cryptoType} to ${walletAddress}`);

      return res.json({
        success: true,
        message: `Withdrawal successful: ${cryptoAmount} ${cryptoType} sent to ${walletAddress}`,
      });
    } else if (withdrawalType === "bank") {
      // Handle Bank Transfer
      if (!bankName || !accountNumber || !accountHolder) {
        req.flash("error", "Bank details are required");
        return res.redirect("/trade");
      }

      // Step 1: Deduct from user's investment
      user.investmentAmount -= withdrawAmount;
      user.investmentDate = new Date();
      await user.save();

      // if (process.env.BANK_TRANSFER_ACCOUNT === "") {
      //   next(new Error());
      // }

      // Step 2: Initiate Bank Transfer (Assuming a payment gateway like Paystack, Flutterwave, or Stripe)
      const transfer = await stripe.transfers.create({
        amount: withdrawAmount * 100,
        currency: "usd",
        destination: process.env.BANK_TRANSFER_ACCOUNT, // Replace with your bank account integration
        metadata: {
          bank_name: bankName,
          account_number: accountNumber,
          account_holder: accountHolder,
        },
      });

      console.log("Bank Transfer Successful:", transfer.id);

      req.flash("success", "Withdrawal request submitted successfully!");
    } else {
      req.flash("error", "Invalid withdrawal type");
      return res.redirect("/trade");
    }
  } catch (err) {
    console.error("Error processing withdrawal:", err);
    next(new Error(err));
  }
};
