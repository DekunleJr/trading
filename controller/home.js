const User = require("../model/user");
const nodemailer = require("nodemailer");
require("dotenv").config();
const { validationResult } = require("express-validator");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { Connection, PublicKey } = require("@solana/web3.js");
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
const erc20Abi = ["function balanceOf(address owner) view returns (uint256)"];

exports.getTrade = async (req, res, next) => {
  let user;

  try {
    const userId = req.session.user._id;
    user = await User.findById(userId);

    if (!user) {
      // Handle user not found before attempting balance fetches
      req.flash("error", "User not found. Please log in again.");
      return res.redirect("/login");
    }

    const currentBalances = {
      BTC: user.balances?.BTC ?? 0,
      ETH: user.balances?.ETH ?? 0,
      BNB: user.balances?.BNB ?? 0,
      SOL: user.balances?.SOL ?? 0,
      USDT: user.balances?.USDT ?? 0,
      POLYGON: user.balances?.POLYGON ?? 0,
      USDC: user.balances?.USDC ?? 0,
    };

    const liveBalances = {};

    // --- Attempt to fetch live balances individually ---

    // Fetch ETH Balance
    try {
      if (user.cryptoWallet?.ETH && process.env.INFURA_API) {
        const provider = new ethers.providers.JsonRpcProvider(
          process.env.INFURA_API
        );
        const ethBalanceWei = await provider.getBalance(user.cryptoWallet.ETH);
        liveBalances.ETH = parseFloat(ethers.utils.formatEther(ethBalanceWei));
        console.log(`Successfully fetched ETH balance for ${userId}`);
      } else if (!user.cryptoWallet?.ETH) {
        console.log(
          `Skipping ETH fetch: No ETH wallet address for user ${userId}`
        );
      } else {
        console.warn(`Skipping ETH fetch: INFURA_API key not configured.`);
      }
    } catch (err) {
      console.error(
        `Failed to fetch ETH balance for ${userId}: ${err.message} (Code: ${err.code})`
      );
      // Keep the balance from DB (already in currentBalances)
    }

    // Fetch BNB balance
    try {
      if (user.cryptoWallet?.BNB) {
        const bscProvider = new ethers.providers.JsonRpcProvider(
          "https://bsc-dataseed.binance.org/"
        );
        const bnbBalanceWei = await bscProvider.getBalance(
          user.cryptoWallet.BNB
        );
        liveBalances.BNB = parseFloat(ethers.utils.formatEther(bnbBalanceWei));
        console.log(`Successfully fetched BNB balance for ${userId}`);
      } else {
        console.log(
          `Skipping BNB fetch: No BNB wallet address for user ${userId}`
        );
      }
    } catch (err) {
      console.error(
        `Failed to fetch BNB balance for ${userId}: ${err.message} (Code: ${err.code})`
      );
    }

    // Fetch USDT Balance (ERC-20 Token)
    try {
      if (
        user.cryptoWallet?.USDT &&
        process.env.USDT_CONTRACT_ADDRESS &&
        process.env.INFURA_API
      ) {
        const provider = new ethers.providers.JsonRpcProvider(
          process.env.INFURA_API
        ); // Reuse provider if INFURA is needed
        const usdtContract = new ethers.Contract(
          process.env.USDT_CONTRACT_ADDRESS,
          ["function balanceOf(address owner) view returns (uint256)"],
          provider
        );
        const usdtBalanceUnits = await usdtContract.balanceOf(
          user.cryptoWallet.USDT
        );
        // Assuming USDT has 6 decimals
        liveBalances.USDT = parseFloat(
          ethers.utils.formatUnits(usdtBalanceUnits, 6)
        );
        console.log(`Successfully fetched USDT balance for ${userId}`);
      } else if (!user.cryptoWallet?.USDT) {
        console.log(
          `Skipping USDT fetch: No USDT wallet address for user ${userId}`
        );
      } else {
        console.warn(
          `Skipping USDT fetch: Missing USDT_CONTRACT_ADDRESS or INFURA_API env variables.`
        );
      }
    } catch (err) {
      console.error(
        `Failed to fetch USDT balance for ${userId}: ${err.message} (Code: ${err.code})`
      );
    }

    // Fetch USDC Balance (ERC-20 Token) - NEW
    try {
      if (
        user.cryptoWallet?.USDC &&
        process.env.USDC_CONTRACT_ADDRESS &&
        process.env.INFURA_API
      ) {
        const provider = new ethers.providers.JsonRpcProvider(
          process.env.INFURA_API
        );
        // Check provider
        const usdcContract = new ethers.Contract(
          process.env.USDC_CONTRACT_ADDRESS,
          erc20Abi, // Use defined ABI
          provider
        );
        // Often the same address as ETH/USDT, but use the specific field
        const usdcBalanceUnits = await usdcContract.balanceOf(
          user.cryptoWallet.USDC
        );
        liveBalances.USDC = parseFloat(
          ethers.utils.formatUnits(usdcBalanceUnits, 6)
        );
        console.log(`Successfully fetched USDC balance for ${userId}`);
      } else if (!user.cryptoWallet?.USDC) {
        console.log(
          `Skipping USDC fetch: No USDC wallet address for user ${userId}`
        );
      } else {
        console.warn(
          `Skipping USDC fetch: Missing USDC_CONTRACT_ADDRESS env variable or INFURA_API key.`
        );
      }
    } catch (err) {
      console.error(
        `Failed to fetch USDC balance for ${userId}: ${err.message} (Code: ${err.code})`
      );
    }

    // Fetch SOL balance
    try {
      if (user.cryptoWallet?.SOL) {
        const solanaConnection = new Connection(
          "https://api.mainnet-beta.solana.com"
        );
        const solPublicKey = new PublicKey(user.cryptoWallet.SOL);
        const solBalanceLamports = await solanaConnection.getBalance(
          solPublicKey
        );
        liveBalances.SOL = solBalanceLamports / 1e9; // Convert lamports to SOL
        console.log(`Successfully fetched SOL balance for ${userId}`);
      } else {
        console.log(
          `Skipping SOL fetch: No SOL wallet address for user ${userId}`
        );
      }
    } catch (err) {
      console.error(
        `Failed to fetch SOL balance for ${userId}: ${err.message}`
      );
    }

    // Fetch BTC Balance
    try {
      if (user.cryptoWallet?.BTC) {
        const btcResponse = await axios.get(
          `https://blockchain.info/q/addressbalance/${user.cryptoWallet.BTC}`
        );
        // Ensure data exists and is a number before division
        if (typeof btcResponse.data === "number") {
          liveBalances.BTC = btcResponse.data / 1e8;
          console.log(`Successfully fetched BTC balance for ${userId}`);
        } else {
          console.error(
            `Failed to fetch BTC balance for ${userId}: Invalid response data type - ${typeof btcResponse.data}`
          );
        }
      } else {
        console.log(
          `Skipping BTC fetch: No BTC wallet address for user ${userId}`
        );
      }
    } catch (err) {
      // Axios errors often have response details
      const errorMsg = err.response
        ? `${err.message} (Status: ${err.response.status})`
        : err.message;
      console.error(`Failed to fetch BTC balance for ${userId}: ${errorMsg}`);
    }

    // Fetch Polygon (MATIC) Balance
    try {
      if (user.cryptoWallet?.POLYGON) {
        const polygonProvider = new ethers.providers.JsonRpcProvider(
          "https://polygon-rpc.com"
        );
        const maticBalanceWei = await polygonProvider.getBalance(
          user.cryptoWallet.POLYGON
        );
        liveBalances.POLYGON = parseFloat(
          ethers.utils.formatEther(maticBalanceWei)
        );
        console.log(`Successfully fetched MATIC balance for ${userId}`);
      } else {
        console.log(
          `Skipping MATIC fetch: No POLYGON wallet address for user ${userId}`
        );
      }
    } catch (err) {
      console.error(
        `Failed to fetch MATIC balance for ${userId}: ${err.message} (Code: ${err.code})`
      );
    }

    // --- Merge live balances with DB balances ---
    // Live data takes precedence over potentially stale DB data
    const finalBalances = {
      ...currentBalances,
      ...liveBalances,
    };

    // --- Save updated balances back to the database (best effort) ---
    // Only save if there were actual changes or if balances were initially missing
    const hasChanges =
      JSON.stringify(user.balances) !== JSON.stringify(finalBalances);
    if (hasChanges) {
      user.balances = finalBalances;
      try {
        await user.save();
        console.log(`Updated balances saved to DB for user ${userId}`);
      } catch (saveError) {
        console.error(
          `Failed to save updated balances for user ${userId}: ${saveError.message}`
        );
      }
    }

    // --- Prepare data for rendering ---
    let payoutDateStr = "N/A";
    if (user.investmentDate) {
      const payoutDate = new Date(user.investmentDate);
      payoutDate.setMonth(payoutDate.getMonth() + 1);
      payoutDateStr = payoutDate.toDateString();
    } else {
      console.log(`User ${userId} does not have an investmentDate set.`);
    }

    const message = req.flash("error")[0] || req.flash("success")[0] || null;

    // --- Render the page ---
    res.render("trade", {
      path: "/trade",
      pageTitle: "My Trade",
      errorMessage: message,
      csrfToken: req.csrfToken(),
      user: {
        fulname: user.fulname,
        email: user.email,
        investmentAmount: user.investmentAmount || 0,
        payoutDate: payoutDateStr,
        cryptoWallet: user.cryptoWallet || {},
        balances: finalBalances,
      },
    });
  } catch (err) {
    console.error("Critical error in getTrade controller:", err);
    next(new Error(err));
  }
};

exports.getAdmin = async (req, res, next) => {
  const message = req.flash("error")[0] || null;
  const success = req.flash("success")[0] || null;
  try {
    const users = await User.find();
    res.render("admin", {
      path: "/",
      pageTitle: "Admin page",
      users: users,
      errorMessage: message,
      successMessage: success,
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
    // console.log("Auth Token:", authToken);
    if (!authToken) {
      req.flash("error", "Failed to authenticate with NowPayments");
      return res.redirect("/trade");
    }
    // NowPayments API request
    const response = await axios.post(
      "https://api.nowpayments.io/v1/payout",
      {
        withdrawals: [
          {
            currency: "usdterc20",
            amount: parseFloat(amount),
            address: walletAddress,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${authToken}`,
          "x-api-key": NOWPAYMENTS_API_KEY, // Make sure to store API key in .env
          "Content-Type": "application/json",
        },
      }
    );
    console.log("respose data:", response.data);

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
  const {
    userId,
    fulname,
    email,
    phone,
    investment,
    investmentAmount,
    investmentDate,
    type,
    ref,
  } = req.body;
  const errors = validationResult(req);

  let user;
  try {
    user = await User.findById(userId);
    if (!user) {
      req.flash("error", "User not found.");
      return res.redirect("/admin");
    }
  } catch (err) {
    console.error("Error finding user for edit:", err);
    const error = new Error(
      "Could not find the user specified. Please try again."
    );
    error.httpStatusCode = 500;
    return next(error);
  }

  if (!errors.isEmpty()) {
    console.log("Validation Errors:", errors.array());
    return res.status(422).render("edit-user", {
      pageTitle: "Edit User",
      path: "/edit-user",
      user: {
        _id: userId,
        fulname: fulname,
        email: email,
        phone: phone,
        investment: investment,
        investmentAmount: investmentAmount,
        investmentDate: investmentDate,
        type: type,
        ref: ref,
      },
      errorMessage: errors.array()[0].msg,
      validationErrors: errors.array(),
      csrfToken: req.csrfToken(),
    });
  }
  // --- End Validation Handling ---

  // 3. Update user properties
  try {
    // Assign potentially updated values
    user.fulname = fulname;
    user.email = email;
    user.phone = phone;
    user.investment = investment;
    user.investmentAmount = investmentAmount;
    user.investmentDate = investmentDate;
    user.type = type;
    user.ref = ref;

    // 4. Save the updated user
    await user.save();

    // 5. Redirect on success
    req.flash("success", "User details updated successfully.");
    res.redirect("/admin"); // Redirect back to the admin user list
  } catch (err) {
    console.error("Error saving updated user:", err);
    // Handle potential saving errors (e.g., database connection issue, validation hook failure)
    const error = new Error("Failed to update user details. Please try again.");
    error.httpStatusCode = 500;
    return next(error); // Pass to error handling middleware
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
  const message = req.flash("error")[0] || req.flash("success")[0] || null;
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
