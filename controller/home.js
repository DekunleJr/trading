const User = require("../model/user");
const nodemailer = require("nodemailer");
require("dotenv").config();
const { validationResult } = require("express-validator");
const fs = require("fs");
const path = require("path");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { ethers } = require("ethers");
const { Connection, PublicKey } = require("@solana/web3.js");
const bitcoin = require("bitcoinjs-lib");
const axios = require("axios");

exports.getindex = async (req, res, next) => {
  try {
    res.render("index", {
      path: "/",
      pageTitle: "Home page",
    });
  } catch (err) {
    next(new Error(err));
  }
};

exports.getService = async (req, res, next) => {
  try {
    res.render("service", {
      path: "/service",
      pageTitle: "Service",
    });
  } catch (err) {
    next(new Error(err));
  }
};

exports.getContact = async (req, res, next) => {
  try {
    res.render("contact", {
      path: "/contact",
      pageTitle: "Contact",
    });
  } catch (err) {
    next(new Error(err));
  }
};

exports.getTrade = async (req, res, next) => {
  try {
    const userId = req.session.user._id;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).send("User not found");
    }

    // Fetch ETH & USDT (ERC-20) balance
    const provider = new ethers.providers.JsonRpcProvider(
      process.env.INFURA_API
    );
    const ethBalance = await provider.getBalance(user.cryptoWallet.ETH);
    const ethFormatted = ethers.utils.formatEther(ethBalance);

    // Fetch BNB balance (BSC network)
    const bscProvider = new ethers.providers.JsonRpcProvider(
      "https://bsc-dataseed.binance.org/"
    );
    const bnbBalance = await bscProvider.getBalance(user.cryptoWallet.BNB);
    const bnbFormatted = ethers.utils.formatEther(bnbBalance);

    // Fetch USDT Balance (ERC-20 Token)
    const usdtContract = new ethers.Contract(
      process.env.USDT_CONTRACT_ADDRESS,
      ["function balanceOf(address owner) view returns (uint256)"],
      provider
    );
    const usdtBalance = await usdtContract.balanceOf(user.cryptoWallet.USDT);
    const formattedUsdtBalance = ethers.utils.formatUnits(usdtBalance, 6);

    // Fetch SOL balance
    const solanaConnection = new Connection(
      "https://api.mainnet-beta.solana.com"
    );
    const solPublicKey = new PublicKey(user.cryptoWallet.SOL);
    const solBalance = await solanaConnection.getBalance(solPublicKey);
    const solFormatted = solBalance / 1e9; // Convert lamports to SOL

    // ✅ Fetch BTC Balance
    const btcAddress = user.cryptoWallet.BTC;
    const btcResponse = await axios.get(
      `https://blockchain.info/q/addressbalance/${btcAddress}`
    );
    const btcFormatted = btcResponse.data / 1e8;

    // ✅ Fetch Polygon (MATIC) Balance
    const polygonProvider = new ethers.providers.JsonRpcProvider(
      "https://polygon-rpc.com"
    );
    const maticBalance = await polygonProvider.getBalance(
      user.cryptoWallet.POLYGON
    );
    const maticFormatted = ethers.utils.formatEther(maticBalance);

    // Calculate payout date
    const payoutDate = new Date(user.investmentDate);
    payoutDate.setMonth(payoutDate.getMonth() + 1);

    res.render("trade", {
      path: "/trade",
      pageTitle: "My Trade",
      user: {
        fulname: user.fulname,
        email: user.email,
        investmentAmount: user.investmentAmount,
        payoutDate: payoutDate.toDateString(),
        cryptoWallet: user.cryptoWallet,
        balances: {
          ETH: ethFormatted,
          BNB: bnbFormatted,
          SOL: solFormatted,
          BTC: btcFormatted,
          MATIC: maticFormatted,
          USDT: formattedUsdtBalance,
        },
      },
    });
  } catch (err) {
    console.error("Error fetching wallet balances:", err);
    next(new Error(err));
  }
};

exports.getAdmin = async (req, res, next) => {
  try {
    const users = await User.find();
    res.render("admin", {
      path: "/",
      pageTitle: "Admin page",
      users: users,
    });
  } catch (err) {
    next(new Error(err));
  }
};

exports.postContact = async (req, res, next) => {
  try {
    const { name, email, description } = req.body;

    const transporter = nodemailer.createTransport({
      host: "smtp.zoho.com",
      port: 465,
      secure: true,
      auth: {
        user: process.env.EMAIL_USER_2,
        pass: process.env.EMAIL_PASS_2,
      },
    });
    const mailOptions = {
      from: process.env.EMAIL_USER_2,
      to: process.env.EMAIL_USER,
      subject: `New message from ${name}`,
      text: `Name: ${name}\nEmail: ${email}\n\nMessage:\n${description}`,
    };
    await transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        return res.status(500).send("Failed to send message");
      }
      res.redirect("/");
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

exports.postDeleteUser = async (req, res, next) => {
  const userId = req.body.userId;

  try {
    const user = await User.findById(userId);
    if (!user) {
      req.flash("error", "user not found");
      return next(new Error("user not found."));
    }
    await User.findByIdAndDelete(userId);
    res.redirect("/admin");
  } catch (err) {
    next(new Error(err));
  }
};

exports.postEditUser = async (req, res, next) => {
  let { email, investmentAmount, investmentDate, withdrawal, userId } =
    req.body;
  const errors = validationResult(req);

  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).render("404", { pageTitle: "User Not Found" }); // Handle missing user
    }

    if (!errors.isEmpty()) {
      res.render("edit-user", {
        pageTitle: "Edit User",
        path: "edit-user",
        errorMessage: message,
        user: user,
      });
    }
    user.email = email;
    user.investmentAmount = investmentAmount;
    user.investmentDate = investmentDate;
    user.withdrawal = withdrawal;

    await user.save();

    // Redirect to login
    res.redirect("/admin");
  } catch (err) {
    console.error("Error in editing :", err);
    next(); // Pass error to centralized error handling middleware
  }
};

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

    // Find the user and update investmentAmount
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).send("User not found");
    }

    user.investmentAmount += amount;
    user.investmentDate = new Date();
    await user.save(); // Save to database

    res.render("payment-success", {
      pageTitle: "Payment Success",
      user,
      amount,
    });
  } catch (err) {
    next(new Error(err));
  }
};

exports.getCrypto = async (req, res, next) => {
  try {
    res.render("crypto", {
      path: "/crypto",
      pageTitle: "payment page",
    });
  } catch (err) {
    next(new Error(err));
  }
};

exports.postCrypto = async (req, res, next) => {
  try {
    const user = req.session.user;
    const name = user.fulname;
    const email = user.email;

    if (!req.file) {
      return res.status(400).send("No file uploaded!");
    }

    const filePath = path.join(
      __dirname,
      "..",
      "public",
      "img",
      req.file.filename
    );

    setTimeout(() => {
      fs.unlink(filePath, (err) => {
        if (err) {
          console.error("Error deleting file:", err);
        } else {
          console.log("File deleted:", filePath);
        }
      });
    }, 60000);

    // Configure Zoho Mail SMTP
    const transporter = nodemailer.createTransport({
      host: "smtp.zoho.com",
      port: 465,
      secure: true,
      auth: {
        user: process.env.EMAIL_USER_2,
        pass: process.env.EMAIL_PASS_2,
      },
    });

    const mailOptions = {
      from: process.env.EMAIL_USER_2, // Sender
      to: process.env.EMAIL_USER, // Admin email
      subject: `New Payment Screenshot from ${name}`,
      text: `Name: ${name}\nEmail: ${email}\n\nMessage:\nAttached to this mail is a screenshot of payment from ${name}`,
      attachments: [
        {
          filename: req.file.originalname,
          path: filePath,
        },
      ],
    };

    // Send email
    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.error("Email sending failed:", error);
        return res.status(500).send("Failed to send email.");
      }
      console.log("Email sent:", info.response);
      res.redirect("/trade");
    });
  } catch (err) {
    next(new Error(err));
  }
};

exports.getEditUser = async (req, res, next) => {
  const message = req.flash("error")[0] || null;
  try {
    const userId = req.params.userId; // Get user ID from URL
    const user = await User.findById(userId); // Fetch user from DB

    if (!user) {
      return res.status(404).render("404", { pageTitle: "User Not Found" }); // Handle missing user
    }

    res.render("edit-user", {
      pageTitle: "Edit User",
      path: "edit-user",
      errorMessage: message,
      user: user,
    });
  } catch (err) {
    next(new Error(err));
  }
};
