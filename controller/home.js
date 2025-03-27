const User = require("../model/user");
const nodemailer = require("nodemailer");
require("dotenv").config();
const { validationResult } = require("express-validator");
const fs = require("fs");
const path = require("path");
// const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { ethers } = require("ethers");
const { Connection, PublicKey } = require("@solana/web3.js");
// const bitcoin = require("bitcoinjs-lib");
const axios = require("axios");

// Import Crypto Cloud
const cryptoCloud = axios.create({
  baseURL: "https://api.cryptocloud.plus/v1",
  headers: { Authorization: `Token ${process.env.CRYPTOCLOUD_API_KEY}` },
});

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
    const message = req.flash("error")[0] || null;

    res.render("trade", {
      path: "/trade",
      pageTitle: "My Trade",
      errorMessage: message,
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
    const { amount } = req.body;
    const cryptoType = "USDT";
    const user = await User.findById(userId);
    if (!user) {
      req.flash("error", "User not found");
      return res.redirect("/trade");
    }
    const walletAddress = user.cryptoWallet.USDT;
    if (parseFloat(amount) > user.investmentAmount) {
      req.flash("error", "Insufficient balance");
      return res.redirect("/trade");
    }
    const response = await cryptoCloud.post("/payout/create", {
      amount,
      currency: cryptoType,
      wallet: walletAddress,
      order_id: userId,
    });
    user.investmentAmount -= parseFloat(amount);
    await user.save();
    res.json({
      success: true,
      message: "Withdrawal initiated",
      payoutId: response.data.id,
    });
  } catch (err) {
    console.error("Withdrawal Error:", err);
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
  const { amount } = req.body;
  try {
    const requestData = {
      amount,
      currency: "USDT",
      order_id: req.session.user._id.toString(),
      project_id: process.env.CRYPTOCLOUD_PROJECT_ID,
      success_url: `${req.protocol}://${req.get(
        "host"
      )}/payment-success?amount=${amount}`,
      fail_url: `${req.protocol}://${req.get("host")}/`,
    };

    console.log("Sending request to Crypto Cloud:", requestData);

    const response = await cryptoCloud.post("/invoice/create", requestData);
    console.log("Crypto Cloud Response:", response.data);

    res.redirect(response.data.url);
  } catch (err) {
    console.error("Deposit Error Response:", err.response?.data || err);
    next(new Error(err));
  }

  // try {
  //   const response = await cryptoCloud.post("/invoice/create", {
  //     amount,
  //     currency: "USDT", // Change based on accepted fiat/crypto
  //     order_id: req.session.user._id,
  //     project_id: process.env.CRYPTOCLOUD_PROJECT_ID,
  //     success_url: `${req.protocol}://${req.get(
  //       "host"
  //     )}/payment-success?amount=${amount}`,
  //     fail_url: `${req.protocol}://${req.get("host")}/`,
  //   });
  //   res.redirect(response.data.url);
  // } catch (err) {
  //   console.error("Deposit Error:", err);
  //   next(new Error(err));
  // }
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

exports.swapCrypto = async (req, res, next) => {
  try {
    const { fromCrypto, toCrypto, amount } = req.body;
    const user = await User.findById(req.session.user._id);

    if (!user) {
      req.flash("error", "User not found");
      return res.status(400).redirect("/trade");
    }

    // Check if user has wallet addresses for both cryptos
    if (!user.cryptoWallet[fromCrypto] || !user.cryptoWallet[toCrypto]) {
      req.flash("error", "Wallet address not found for selected crypto");
      return res.status(400).redirect("/trade");
    }

    const fromWallet = user.cryptoWallet[fromCrypto]; // Sender's wallet address
    const toWallet = user.cryptoWallet[toCrypto]; // Receiver's wallet address

    // Fetch exchange rate from Binance API
    const exchangeRateResponse = await axios.get(
      `https://api.binance.us/api/v3/ticker/price?symbol=${fromCrypto}${toCrypto}`
    );

    if (!exchangeRateResponse.data.price) {
      req.flash("error", "Failed to fetch exchange rate");
      return res.status(500).redirect("/trade");
    }

    const exchangeRate = parseFloat(exchangeRateResponse.data.price);
    const convertedAmount = amount * exchangeRate;

    // Process swap using Crypto Cloud (including wallet addresses)
    const response = await cryptoCloud.post("/swap", {
      from: fromCrypto,
      to: toCrypto,
      amount,
      from_wallet: fromWallet, // User's wallet for deduction
      to_wallet: toWallet, // User's wallet for receiving converted crypto
      order_id: user._id,
    });

    if (response.data.status !== "success") {
      req.flash("error", "Crypto swap failed");
      return res.status(500).redirect("/trade");
    }

    req.flash(
      "success",
      `Successfully swapped ${amount} ${fromCrypto} to ${convertedAmount.toFixed(
        6
      )} ${toCrypto}`
    );
    res.redirect("/trade");
  } catch (err) {
    next(new Error(err));
  }
};

exports.sendCrypto = async (req, res, next) => {
  try {
    const { cryptoType, amount, walletAddress, sendCryptoType } = req.body;
    const user = await User.findById(req.session.user._id);

    if (!user) {
      req.flash("error", "User not found");
      return res.redirect("/trade");
    }

    if (!user.cryptoWallet[cryptoType]) {
      req.flash("error", "No wallet address found for ${cryptoType}");
      return res.redirect("/trade");
    }

    // Process transaction via Crypto Cloud
    const response = await cryptoCloud.post("/payout/create", {
      amount,
      currency: sendCryptoType,
      wallet: walletAddress,
      order_id: user._id,
    });

    if (response.data.status !== "success") {
      req.flash("error", "Crypto transfer failed");
      return res.redirect("/trade");
    }

    req.flash("success", `Sent ${amount} ${cryptoType} to ${walletAddress}`);
    res.redirect("/trade");
  } catch (error) {
    console.error("Send Crypto Error:", error);
    req.flash("error", "Transaction error");
    next(new Error(error));
  }
};
