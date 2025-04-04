const User = require("../model/user");
const nodemailer = require("nodemailer");
require("dotenv").config();
const { validationResult } = require("express-validator");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { Connection, PublicKey } = require("@solana/web3.js");
// const bitcoin = require("bitcoinjs-lib");
// const { ECPairFactory } = require("ecpair");
// const ecc = require("tiny-secp256k1");
const axios = require("axios");

const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY;
const NOWPAYMENTS_EMAIL = process.env.NOWPAYMENTS_EMAIL;
const NOWPAYMENTS_PASSWORD = process.env.NOWPAYMENTS_PASSWORD;

// Function to get auth token
async function getAuthToken() {
  try {
    const response = await axios.post(
      "https://api.nowpayments.io/v1/auth",
      {
        email: NOWPAYMENTS_EMAIL, // Admin email
        password: NOWPAYMENTS_PASSWORD, // Admin password
      },
      {
        headers: {
          "x-api-key": NOWPAYMENTS_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data.token;
  } catch (error) {
    console.error("Token Error:", error.response?.data || error.message);
    return null;
  }
}

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

    const balances = {};

    // Fetch ETH & USDT (ERC-20) balance
    const provider = new ethers.providers.JsonRpcProvider(
      process.env.INFURA_API
    );
    if (user.cryptoWallet.ETH) {
      const ethBalance = await provider.getBalance(user.cryptoWallet.ETH);
      balances.ETH = parseFloat(ethers.utils.formatEther(ethBalance));
    }

    // Fetch BNB balance (BSC network)
    const bscProvider = new ethers.providers.JsonRpcProvider(
      "https://bsc-dataseed.binance.org/"
    );
    if (user.cryptoWallet.BNB) {
      const bnbBalance = await bscProvider.getBalance(user.cryptoWallet.BNB);
      balances.BNB = parseFloat(ethers.utils.formatEther(bnbBalance));
    }

    // Fetch USDT Balance (ERC-20 Token)
    if (user.cryptoWallet.USDT) {
      const usdtContract = new ethers.Contract(
        process.env.USDT_CONTRACT_ADDRESS,
        ["function balanceOf(address owner) view returns (uint256)"],
        provider
      );
      const usdtBalance = await usdtContract.balanceOf(user.cryptoWallet.USDT);
      balances.USDT = parseFloat(ethers.utils.formatUnits(usdtBalance, 6));
    }

    // Fetch SOL balance
    if (user.cryptoWallet.SOL) {
      const solanaConnection = new Connection(
        "https://api.mainnet-beta.solana.com"
      );
      const solPublicKey = new PublicKey(user.cryptoWallet.SOL);
      const solBalance = await solanaConnection.getBalance(solPublicKey);
      balances.SOL = solBalance / 1e9; // Convert lamports to SOL
    }

    // ✅ Fetch BTC Balance
    if (user.cryptoWallet.BTC) {
      const btcResponse = await axios.get(
        `https://blockchain.info/q/addressbalance/${user.cryptoWallet.BTC}`
      );
      balances.BTC = btcResponse.data / 1e8;
    }

    // ✅ Fetch Polygon (MATIC) Balance
    const polygonProvider = new ethers.providers.JsonRpcProvider(
      "https://polygon-rpc.com"
    );
    if (user.cryptoWallet.POLYGON) {
      const maticBalance = await polygonProvider.getBalance(
        user.cryptoWallet.POLYGON
      );
      balances.POLYGON = parseFloat(ethers.utils.formatEther(maticBalance));
    }

    // ✅ Save updated balances to the database
    user.balances = {
      BTC: balances.BTC || 0,
      ETH: balances.ETH || 0,
      BNB: balances.BNB || 0,
      SOL: balances.SOL || 0,
      USDT: balances.USDT || 0,
      POLYGON: balances.POLYGON || 0,
    };
    await user.save();

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
        balances,
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

    const user = await User.findById(userId);
    if (!user) {
      req.flash("error", "User not found");
      return res.redirect("/trade");
    }

    const walletAddress = user.cryptoWallet.USDT;
    if (!walletAddress) {
      req.flash("error", "No USDT (ERC-20) wallet address found");
      return res.redirect("/trade");
    }

    if (parseFloat(amount) > user.investmentAmount) {
      req.flash("error", "Insufficient balance");
      return res.redirect("/trade");
    }
    const authToken = await getAuthToken();
    console.log("Auth Token:", authToken);
    if (!authToken) {
      req.flash("error", "Failed to authenticate with NowPayments");
      return res.redirect("/trade");
    }

    console.log("NowPayments API Key:", NOWPAYMENTS_API_KEY);
    // NowPayments API request
    const response = await axios.post(
      "https://api.nowpayments.io/v1/payout",
      {
        withdrawals: {
          currency: "usdterc20",
          amount: parseFloat(amount),
          address: walletAddress,
          ipn_callback_url: "https://nowpayments.io",
        },
        test: true,
      },
      {
        headers: {
          Authorization: `Bearer ${authToken}`,
          "x-api-key": NOWPAYMENTS_API_KEY, // Make sure to store API key in .env
          "Content-Type": "application/json",
        },
      }
    );
    console.log(response.data);

    if (response.data && response.data.status === "success") {
      user.investmentAmount -= parseFloat(amount);
      await user.save();

      req.flash("success", "withdrawal initiated successfully");
    } else {
      req.flash("error", "Failed to initiate withdrawal");
    }

    return res.redirect("/trade");
  } catch (err) {
    console.error("Withdrawal Error:", err);
    req.flash("error", "An error occurred during withdrawal");
    return res.redirect("/trade");
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
  try {
    const { amount } = req.body;
    const user = await User.findById(req.session.user._id);

    if (!user) {
      req.flash("error", "User not found");
      return res.status(400).redirect("/deposit");
    }

    const order_id = user._id;
    const success_url = `${req.protocol}://${req.get(
      "host"
    )}/payment-success?amount=${amount}`;
    const fail_url = `${req.protocol}://${req.get("host")}/trade`;

    console.log("API Key:", NOWPAYMENTS_API_KEY);

    const response = await axios.post(
      "https://api.nowpayments.io/v1/invoice",
      {
        price_amount: amount,
        price_currency: "usdterc20",
        pay_currency: "usdterc20",
        order_id,
        success_url,
        cancel_url: fail_url,
      },
      {
        headers: {
          "x-api-key": NOWPAYMENTS_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    // const response = await axios.get(
    //   "https://api.nowpayments.io/v1/currencies",
    //   {
    //     headers: { "x-api-key": process.env.NOWPAYMENTS_API_KEY },
    //   }
    // );
    // console.log(response.data);

    if (response.data && response.data.invoice_url) {
      return res.redirect(response.data.invoice_url);
    } else {
      req.flash("error", "Deposit request failed");
      return res.status(500).redirect("/deposit");
    }
  } catch (err) {
    // console.log(err.response.data);
    console.error("Withdrawal Error:", err.response.data);
    req.flash("error", "An error occurred during Deposit");
    return res.redirect("/trade");
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
