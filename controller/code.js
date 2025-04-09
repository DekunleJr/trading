const User = require("../model/user");
const nodemailer = require("nodemailer");
require("dotenv").config();
const { validationResult } = require("express-validator");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { Connection, PublicKey } = require("@solana/web3.js");
const axios = require("axios");
const Withdrawal = require("../model/withdrawal"); // Ensure path is correct

const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY;
const NOWPAYMENTS_EMAIL = process.env.NOWPAYMENTS_EMAIL;
const NOWPAYMENTS_PASSWORD = process.env.NOWPAYMENTS_PASSWORD;

// Function to get auth token
async function getAuthToken() {
  try {
    const response = await axios.post(
      "https://api.nowpayments.io/v1/auth",
      {
        email: NOWPAYMENTS_EMAIL,
        password: NOWPAYMENTS_PASSWORD,
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

// --- Currency Mapping ---
// Keys should match format stored in user.depositCurrency
// Values are NowPayments PAYOUT tickers (Verify these!)
const currencyMapping = {
  BTC: "btc",
  ETH: "eth",
  USDT: "usdterc20", // Default USDT if simple symbol stored
  USDT_ERC20: "usdterc20",
  USDT_TRC20: "usdttrc20",
  BNB: "bnbmainnet", // Verify ticker
  SOL: "sol",
  USDC: "usdcerc20", // Default USDC if simple symbol stored
  USDC_ERC20: "usdcerc20", // Use Latin 'c', verify ticker
  MATIC: "matic", // Verify ticker
  // Add all other supported currency/network combinations
};
// Create a list of allowed keys used in postDeposit validation
const ALLOWED_DEPOSIT_CURRENCY_KEYS = Object.keys(currencyMapping);

// --- Controller Functions ---

exports.getWithdrawals = async (req, res, next) => {
  try {
    const userId = req.session.user._id;
    const withdrawals = await Withdrawal.find({ userId: userId }).sort({
      createdAt: -1,
    });

    res.render("withdrawals", {
      pageTitle: "Withdrawal History",
      path: "/withdrawals",
      withdrawals: withdrawals,
      csrfToken: req.csrfToken(),
      isAuthenticated: req.session.isLoggedIn,
      // Pass user object if needed by layout/nav
      user: req.session.user,
    });
  } catch (err) {
    console.error("Error fetching withdrawals:", err);
    const error = new Error("Could not retrieve withdrawal history.");
    error.httpStatusCode = 500;
    return next(error); // Pass error object directly
  }
};

exports.getindex = async (req, res, next) => {
  try {
    res.render("index", {
      path: "/",
      pageTitle: "Home page",
      isAuthenticated: req.session.isLoggedIn,
      user: req.session.user,
    });
  } catch (err) {
    next(err); // Pass error object directly
  }
};

exports.getService = async (req, res, next) => {
  try {
    res.render("service", {
      path: "/service",
      pageTitle: "Service",
      isAuthenticated: req.session.isLoggedIn,
      user: req.session.user,
    });
  } catch (err) {
    next(err);
  }
};

exports.getContact = async (req, res, next) => {
  try {
    res.render("contact", {
      path: "/contact",
      pageTitle: "Contact",
      csrfToken: req.csrfToken(), // Pass CSRF token for the form
      isAuthenticated: req.session.isLoggedIn,
      user: req.session.user,
    });
  } catch (err) {
    next(err);
  }
};

const erc20Abi = ["function balanceOf(address owner) view returns (uint256)"];

exports.getTrade = async (req, res, next) => {
  let user;
  const userId = req.session.user?._id; // Use optional chaining

  if (!userId) {
    req.flash("error", "Session expired. Please log in.");
    return res.redirect("/login");
  }

  try {
    user = await User.findById(userId);

    if (!user) {
      req.flash("error", "User not found. Please log in again.");
      // Clear potentially invalid session
      req.session.destroy((err) => {
        if (err) console.error("Session destroy error:", err);
        return res.redirect("/login");
      });
      return; // Stop execution
    }

    // Use balances from DB as default/fallback
    const currentBalances = {
      BTC: user.balances?.BTC ?? 0,
      ETH: user.balances?.ETH ?? 0,
      BNB: user.balances?.BNB ?? 0,
      SOL: user.balances?.SOL ?? 0,
      USDT: user.balances?.USDT ?? 0,
      POLYGON: user.balances?.POLYGON ?? 0, // Check schema field name consistency
      USDC: user.balances?.USDC ?? 0,
    };

    const liveBalances = {};
    const fetchPromises = []; // Array to hold balance fetching promises

    // --- Prepare Balance Fetch Promises ---

    // ETH
    if (user.cryptoWallet?.ETH && process.env.INFURA_API) {
      fetchPromises.push(
        (async () => {
          try {
            const provider = new ethers.providers.JsonRpcProvider(
              process.env.INFURA_API
            );
            const ethBalanceWei = await provider.getBalance(
              user.cryptoWallet.ETH
            );
            liveBalances.ETH = parseFloat(
              ethers.utils.formatEther(ethBalanceWei)
            );
          } catch (err) {
            console.error(
              `Failed to fetch ETH balance for ${userId}: ${err.message} (Code: ${err.code})`
            );
          }
        })()
      );
    }

    // BNB
    if (user.cryptoWallet?.BNB) {
      fetchPromises.push(
        (async () => {
          try {
            const bscProvider = new ethers.providers.JsonRpcProvider(
              "https://bsc-dataseed.binance.org/"
            );
            const bnbBalanceWei = await bscProvider.getBalance(
              user.cryptoWallet.BNB
            );
            liveBalances.BNB = parseFloat(
              ethers.utils.formatEther(bnbBalanceWei)
            );
          } catch (err) {
            console.error(
              `Failed to fetch BNB balance for ${userId}: ${err.message} (Code: ${err.code})`
            );
          }
        })()
      );
    }

    // USDT (ERC20)
    if (
      user.cryptoWallet?.USDT &&
      process.env.USDT_CONTRACT_ADDRESS &&
      process.env.INFURA_API
    ) {
      fetchPromises.push(
        (async () => {
          try {
            const provider = new ethers.providers.JsonRpcProvider(
              process.env.INFURA_API
            );
            const usdtContract = new ethers.Contract(
              process.env.USDT_CONTRACT_ADDRESS,
              erc20Abi,
              provider
            );
            // Use USDT field if it holds the ETH-compatible address
            const usdtBalanceUnits = await usdtContract.balanceOf(
              user.cryptoWallet.USDT
            );
            liveBalances.USDT = parseFloat(
              ethers.utils.formatUnits(usdtBalanceUnits, 6)
            ); // Assuming 6 decimals
          } catch (err) {
            console.error(
              `Failed to fetch USDT balance for ${userId}: ${err.message} (Code: ${err.code})`
            );
          }
        })()
      );
    }

    // USDC (ERC20)
    if (
      user.cryptoWallet?.USDC &&
      process.env.USDC_CONTRACT_ADDRESS &&
      process.env.INFURA_API
    ) {
      fetchPromises.push(
        (async () => {
          try {
            const provider = new ethers.providers.JsonRpcProvider(
              process.env.INFURA_API
            );
            const usdcContract = new ethers.Contract(
              process.env.USDC_CONTRACT_ADDRESS,
              erc20Abi,
              provider
            );
            const usdcBalanceUnits = await usdcContract.balanceOf(
              user.cryptoWallet.USDC
            );
            liveBalances.USDC = parseFloat(
              ethers.utils.formatUnits(usdcBalanceUnits, 6)
            ); // Assuming 6 decimals
          } catch (err) {
            console.error(
              `Failed to fetch USDC balance for ${userId}: ${err.message} (Code: ${err.code})`
            );
          }
        })()
      );
    }

    // SOL
    if (user.cryptoWallet?.SOL) {
      fetchPromises.push(
        (async () => {
          try {
            const solanaConnection = new Connection(
              "https://api.mainnet-beta.solana.com"
            );
            const solPublicKey = new PublicKey(user.cryptoWallet.SOL);
            const solBalanceLamports = await solanaConnection.getBalance(
              solPublicKey
            );
            liveBalances.SOL = solBalanceLamports / 1e9;
          } catch (err) {
            console.error(
              `Failed to fetch SOL balance for ${userId}: ${err.message}`
            );
          }
        })()
      );
    }

    // BTC
    if (user.cryptoWallet?.BTC) {
      fetchPromises.push(
        (async () => {
          try {
            const btcResponse = await axios.get(
              `https://blockchain.info/q/addressbalance/${user.cryptoWallet.BTC}`
            );
            if (typeof btcResponse.data === "number") {
              liveBalances.BTC = btcResponse.data / 1e8;
            } else {
              console.error(
                `Failed to fetch BTC balance for ${userId}: Invalid response data type - ${typeof btcResponse.data}`
              );
            }
          } catch (err) {
            const errorMsg = err.response
              ? `${err.message} (Status: ${err.response.status})`
              : err.message;
            console.error(
              `Failed to fetch BTC balance for ${userId}: ${errorMsg}`
            );
          }
        })()
      );
    }

    // POLYGON (MATIC)
    if (user.cryptoWallet?.POLYGON) {
      fetchPromises.push(
        (async () => {
          try {
            const polygonProvider = new ethers.providers.JsonRpcProvider(
              "https://polygon-rpc.com"
            );
            const maticBalanceWei = await polygonProvider.getBalance(
              user.cryptoWallet.POLYGON
            );
            liveBalances.POLYGON = parseFloat(
              ethers.utils.formatEther(maticBalanceWei)
            );
          } catch (err) {
            console.error(
              `Failed to fetch MATIC balance for ${userId}: ${err.message} (Code: ${err.code})`
            );
          }
        })()
      );
    }

    // --- Execute all balance fetches concurrently ---
    await Promise.allSettled(fetchPromises); // Waits for all to finish, regardless of success/failure

    // --- Merge live balances with DB balances ---
    const finalBalances = {
      ...currentBalances,
      ...liveBalances, // Live data overwrites DB data where available
    };

    // --- Save updated balances back to the database (best effort) ---
    const currentDbBalancesString = JSON.stringify(user.balances || {});
    const finalBalancesString = JSON.stringify(finalBalances);

    if (currentDbBalancesString !== finalBalancesString) {
      user.balances = finalBalances;
      try {
        await user.save();
        console.log(`Saved updated balances for user ${userId}`);
      } catch (saveError) {
        console.error(
          `Failed to save updated balances for user ${userId}: ${saveError.message}`
        );
        // Don't fail the page load, just log the error
      }
    }

    // --- Prepare data for rendering ---
    let payoutDateStr = "N/A"; // Default value
    // Review this payout date logic based on requirements
    if (user.investmentDate instanceof Date && !isNaN(user.investmentDate)) {
      const payoutDate = new Date(user.investmentDate);
      payoutDate.setMonth(payoutDate.getMonth() + 1); // Example: one month later
      payoutDateStr = payoutDate.toLocaleDateString(); // Use locale-specific date format
    } else {
      console.log(`User ${userId} investmentDate is invalid or not set.`);
    }

    const message = req.flash("error")[0] || req.flash("success")[0] || null;

    // --- Render the page ---
    res.render("trade", {
      path: "/trade",
      pageTitle: "My Trade",
      errorMessage: message,
      csrfToken: req.csrfToken(),
      isAuthenticated: req.session.isLoggedIn, // Pass auth status
      user: {
        // Pass only necessary user data to the template
        fulname: user.fulname,
        email: user.email, // Be cautious if displaying email
        investmentAmount: user.investmentAmount ?? 0, // Ensure default
        payoutDate: payoutDateStr,
        cryptoWallet: user.cryptoWallet || {},
        balances: finalBalances,
        depositCurrency: user.depositCurrency || "USDT_ERC20", // Provide a sensible default?
      },
    });
  } catch (err) {
    // Catch errors from User.findById or other unexpected issues
    console.error("Critical error in getTrade controller:", err);
    next(err); // Pass to generic error handler
  }
};

exports.getAdmin = async (req, res, next) => {
  const message = req.flash("error")[0] || null;
  const success = req.flash("success")[0] || null;
  try {
    // Consider adding pagination for large number of users
    const users = await User.find();
    res.render("admin", {
      path: "/admin", // Use consistent path
      pageTitle: "Admin - User Management",
      users: users,
      errorMessage: message,
      successMessage: success,
      csrfToken: req.csrfToken(),
      isAuthenticated: req.session.isLoggedIn,
      user: req.session.user,
    });
  } catch (err) {
    next(err);
  }
};

exports.postContact = async (req, res, next) => {
  try {
    const { name, email, description } = req.body;

    // Add basic validation
    if (!name || !email || !description) {
      req.flash("error", "Please fill in all fields.");
      return res.redirect("/contact");
    }

    const transporter = nodemailer.createTransport({
      host: "smtp.zoho.com",
      port: 465,
      secure: true, // true for 465, false for other ports
      auth: {
        user: process.env.EMAIL_USER_2, // Make sure these are set in .env
        pass: process.env.EMAIL_PASS_2,
      },
    });

    const mailOptions = {
      from: `"TradeReturn Contact" <${process.env.EMAIL_USER_2}>`, // Use a display name
      to: process.env.EMAIL_USER, // Your receiving email
      replyTo: email, // Set reply-to to the sender's email
      subject: `New Contact Form Message from ${name}`,
      text: `Name: ${name}\nEmail: ${email}\n\nMessage:\n${description}`,
      // Optional: Add an HTML version
      // html: `<p><strong>Name:</strong> ${name}</p><p><strong>Email:</strong> ${email}</p><p><strong>Message:</strong></p><p>${description.replace(/\n/g, '<br>')}</p>`
    };

    // Use async/await with sendMail for cleaner flow
    try {
      let info = await transporter.sendMail(mailOptions);
      console.log("Message sent: %s", info.messageId);
      req.flash("success", "Your message has been sent successfully!");
      res.redirect("/contact"); // Redirect back to contact page
    } catch (mailError) {
      console.error("Failed to send contact email:", mailError);
      req.flash(
        "error",
        "Failed to send message. Please try again later or contact support directly."
      );
      res.redirect("/contact");
    }
  } catch (err) {
    // Catch unexpected errors in the overall process
    next(err);
  }
};

// --- DELETED Older/Commented out postWithdraw function ---

exports.postDeleteUser = async (req, res, next) => {
  const userId = req.body.userId;

  if (!userId) {
    req.flash("error", "User ID missing.");
    return res.redirect("/admin");
  }

  try {
    // Optional: Check if the user performing the delete is an admin
    // if (req.session.user.type !== 'admin') { ... return error ... }

    const deletedUser = await User.findByIdAndDelete(userId);

    if (!deletedUser) {
      req.flash("error", "User not found or already deleted.");
    } else {
      req.flash(
        "success",
        `User ${deletedUser.fulname || userId} deleted successfully.`
      );
    }
    res.redirect("/admin");
  } catch (err) {
    console.error(`Error deleting user ${userId}:`, err);
    req.flash("error", "An error occurred while deleting the user.");
    res.redirect("/admin"); // Redirect back even on error
    // Optionally pass to error handler: next(err);
  }
};

exports.postEditUser = async (req, res, next) => {
  // 1. Destructure all relevant fields from req.body
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

  // 2. --- Validation Handling (Example using express-validator) ---
  // Make sure you have validation rules defined in your route for this controller
  const errors = validationResult(req);

  // Fetch user data *before* checking errors to repopulate form if needed
  let userToEdit;
  try {
    userToEdit = await User.findById(userId);
    if (!userToEdit) {
      req.flash("error", "User not found.");
      return res.redirect("/admin");
    }
  } catch (err) {
    console.error("Error finding user for edit:", err);
    const error = new Error("Could not find the user specified.");
    error.httpStatusCode = 500;
    return next(error);
  }

  if (!errors.isEmpty()) {
    console.log("Validation Errors on Edit:", errors.array());
    // Re-render edit page with errors and *submitted* data
    return res.status(422).render("edit-user", {
      // Adjust view path if needed
      pageTitle: "Edit User",
      path: "/admin/edit-user", // Adjust path identifier
      // editing: true, // Pass flags if your view uses them
      hasError: true,
      // Pass back submitted data to repopulate form correctly
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
      csrfToken: req.csrfToken(), // Pass CSRF token back
      isAuthenticated: req.session.isLoggedIn, // Pass needed layout vars
      // loggedInUser: req.session.user // Pass user if needed by layout
    });
  }
  // --- End Validation Handling ---

  // 3. Update user properties
  try {
    userToEdit.fulname = fulname;
    userToEdit.email = email; // Consider uniqueness check if email is unique key
    userToEdit.phone = phone;
    userToEdit.investment = investment;
    // Ensure numeric conversion robustness
    userToEdit.investmentAmount = !isNaN(parseFloat(investmentAmount))
      ? parseFloat(investmentAmount)
      : 0;
    userToEdit.investmentDate = investmentDate; // Mongoose handles date conversion
    userToEdit.type = type;
    userToEdit.ref = ref;

    // 4. Save the updated user
    await userToEdit.save();

    // 5. Redirect on success
    req.flash("success", "User details updated successfully.");
    res.redirect("/admin");
  } catch (err) {
    console.error("Error saving updated user:", err);
    // Handle potential saving errors (DB connection, validation hooks)
    req.flash("error", "Failed to update user details. Please try again.");
    // Re-render form with error, preserving *original* user data from DB before edit attempt
    res.status(500).render("edit-user", {
      pageTitle: "Edit User",
      path: "/admin/edit-user",
      hasError: true,
      user: userToEdit, // Pass original user object back
      errorMessage: "Failed to update user details. Please try again.",
      validationErrors: [], // No validation errors here, it's a save error
      csrfToken: req.csrfToken(),
      isAuthenticated: req.session.isLoggedIn,
      // loggedInUser: req.session.user
    });
    // Or use next(err) if you have middleware to handle this rendering
  }
};

exports.postDeposit = async (req, res, next) => {
  try {
    const { amount, currency } = req.body;
    const userId = req.session.user?._id;

    if (!userId) {
      req.flash("error", "Session expired. Please log in.");
      return res.redirect("/login");
    }

    // 2. Basic Validation
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      req.flash("error", "Invalid deposit amount.");
      return res.status(400).redirect("/deposit"); // Consider rendering deposit page with error
    }

    if (!currency || !ALLOWED_DEPOSIT_CURRENCY_KEYS.includes(currency)) {
      req.flash("error", `Invalid or unsupported currency selected.`);
      return res.status(400).redirect("/deposit");
    }

    const user = await User.findById(userId);
    if (!user) {
      // Should not happen if session is valid, but good check
      req.flash("error", "User not found");
      return res.status(404).redirect("/login");
    }

    // 3. Get the correct NowPayments currency code
    const payCurrencyCode = currencyMapping[currency]; // Use the correct mapping
    if (!payCurrencyCode) {
      // Should be caught by initial validation, but safety check
      req.flash(
        "error",
        `Internal error: Unsupported currency code mapping for ${currency}.`
      );
      return res.status(500).redirect("/deposit");
    }

    // 4. Prepare URLs and Order ID
    const order_id = `dep-${user._id}-${Date.now()}`; // Unique Order ID
    // ** SECURITY WARNING: Do not pass amount/currency in success URL for balance updates! **
    // The IPN should be used to verify payment and update balance.
    const success_url = `${req.protocol}://${req.get(
      "host"
    )}/payment-success?amount=${amount}&currency=${currency}&order_id=${order_id}`;
    const cancel_url = `${req.protocol}://${req.get("host")}/trade`;

    // 5. Construct the NowPayments Payload
    // This assumes the user enters the amount IN the selected crypto currency
    const payload = {
      price_amount: parseFloat(amount),
      price_currency: payCurrencyCode, // Price is in the crypto itself
      pay_currency: payCurrencyCode, // User pays with the same crypto
      order_id: order_id,
      success_url: success_url,
      cancel_url: cancel_url,
    };

    // Check for mock/skip flag (use a clearer name)
    const SKIP_INVOICE_CREATION = process.env.SKIP_INVOICE_CREATION === "true";

    if (SKIP_INVOICE_CREATION) {
      console.warn(
        "Skipping NowPayments invoice creation (SKIP_INVOICE_CREATION=true)"
      );
      // ** FOR TESTING ONLY - Simulate success but DO NOT update balance here **
      req.flash(
        "info",
        "Skipped payment gateway. Redirecting to success page (TESTING ONLY)."
      );
      return res.redirect(success_url);
    }

    // 6. Make the API Call
    const response = await axios.post(
      "https://api.nowpayments.io/v1/invoice",
      payload,
      {
        headers: {
          "x-api-key": NOWPAYMENTS_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    // 7. Handle the Response
    if (response.data && response.data.invoice_url) {
      // Optional: Store invoice details (invoice_id, order_id, status) in your DB
      console.log(
        `Invoice created for order ${order_id}, URL: ${response.data.invoice_url}`
      );
      return res.redirect(response.data.invoice_url);
    } else {
      const errorMessage = response.data?.message || "Invoice creation failed.";
      console.error(
        `Invoice creation failed for order ${order_id}:`,
        response.data
      );
      req.flash("error", `Deposit request failed: ${errorMessage}`);
      return res.status(500).redirect("/deposit");
    }
  } catch (err) {
    // 8. Handle Errors
    let errorMsg = "An error occurred during the deposit process.";
    if (err.response?.data) {
      console.error("NowPayments Invoice API Error:", err.response.data);
      errorMsg = `Deposit Error: ${
        err.response.data.message || "Unknown API error"
      }`;
    } else {
      console.error("Deposit Process Error:", err);
    }
    req.flash("error", errorMsg);
    return res.redirect("/deposit");
  }
};

// --- THIS IS THE CORRECT, ACTIVE postWithdraw ---
exports.postWithdraw = async (req, res, next) => {
  try {
    const userId = req.session.user?._id;
    if (!userId) {
      req.flash("error", "Session expired. Please log in.");
      return res.redirect("/login");
    }

    const { amount } = req.body;
    const parsedAmount = parseFloat(amount);

    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      req.flash("error", "Invalid withdrawal amount.");
      return res.redirect("/trade");
    }

    const user = await User.findById(userId).select(
      "+cryptoWallet +depositCurrency"
    );
    if (!user) {
      req.flash("error", "User not found.");
      req.session.destroy((err) => {
        if (err) console.error("Session destroy error:", err);
        return res.redirect("/login");
      });
      return; // Stop execution
    }

    const userDepositCurrency = user.depositCurrency;
    if (!userDepositCurrency) {
      req.flash(
        "error",
        "Withdrawal currency not specified. Please contact support or check profile."
      );
      return res.redirect("/trade");
    }
    const mappingLookupKey = userDepositCurrency; // Use exact format from DB

    const nowPaymentsTicker = currencyMapping[mappingLookupKey];
    if (!nowPaymentsTicker) {
      console.error(
        `No NowPayments payout mapping for user currency: ${mappingLookupKey}`
      );
      req.flash(
        "error",
        `Withdrawals for currency ${mappingLookupKey} are not currently supported.`
      );
      return res.redirect("/trade");
    }

    let walletLookupSymbol = userDepositCurrency.toUpperCase();
    if (
      walletLookupSymbol === "USDT_ERC20" ||
      walletLookupSymbol === "USDT_TRC20"
    ) {
      walletLookupSymbol = "USDT";
    } else if (walletLookupSymbol === "USDC_ERC20") {
      walletLookupSymbol = "USDC";
    }
    // Add more normalization if needed based on cryptoWallet keys

    if (!user.cryptoWallet || typeof user.cryptoWallet !== "object") {
      req.flash(
        "error",
        "User crypto wallet information is missing or invalid."
      );
      return res.redirect("/trade");
    }
    const walletAddress = user.cryptoWallet[walletLookupSymbol];
    if (!walletAddress) {
      req.flash(
        "error",
        `No ${walletLookupSymbol} wallet address found in your profile for withdrawals.`
      );
      return res.redirect("/trade");
    }

    // ** Balance Check: Needs review based on whether investmentAmount is unified **
    if (parsedAmount > user.investmentAmount) {
      req.flash("error", "Insufficient balance.");
      return res.redirect("/trade");
    }

    const authToken = await getAuthToken();
    if (!authToken) {
      req.flash("error", "Failed to authenticate with payment processor.");
      return res.redirect("/trade");
    }

    const ipnCallbackUrl = `${req.protocol}://${req.get(
      "host"
    )}/api/nowpayments-payout-ipn`; // Use base URL from .env

    const payoutData = {
      ipn_callback_url: ipnCallbackUrl,
      withdrawals: [
        {
          currency: nowPaymentsTicker,
          amount: parsedAmount,
          address: walletAddress,
          // unique_external_id: `wd-${userId}-${Date.now()}` // Example unique ID
        },
      ],
    };

    let response;
    try {
      response = await axios.post(
        `${NOWPAYMENTS_API_BASE_URL}/payout`, // Use variable if defined elsewhere
        payoutData,
        {
          headers: {
            Authorization: `Bearer ${authToken}`,
            "x-api-key": NOWPAYMENTS_API_KEY,
            "Content-Type": "application/json",
          },
        }
      );
      console.log("NowPayments Payout Response:", response.data);
    } catch (apiError) {
      console.error(
        "NowPayments Payout API Error Data:",
        apiError.response?.data
      );
      console.error(
        "NowPayments Payout API Error Status:",
        apiError.response?.status
      );
      req.flash(
        "error",
        `Withdrawal failed: ${apiError.response?.data?.message || "API Error"}`
      );
      return res.redirect("/trade");
    }

    if (response.data?.id && response.data?.withdrawals?.length > 0) {
      const payoutDetails = response.data.withdrawals[0];

      const newWithdrawal = new Withdrawal({
        userId: userId,
        amount: parsedAmount,
        currency: nowPaymentsTicker,
        address: walletAddress,
        nowPaymentsPayoutId: payoutDetails.id,
        nowPaymentsBatchId: response.data.id,
        status: "INITIATED",
        nowPaymentsStatus: payoutDetails.status,
      });
      await newWithdrawal.save();

      console.log(
        `Withdrawal (${nowPaymentsTicker}) initiated, DB ID: ${newWithdrawal._id}, NP ID: ${payoutDetails.id}`
      );
      req.flash(
        "success",
        "Withdrawal initiated successfully. Please monitor the status on the Withdrawals page."
      );
      return res.redirect("/withdrawals");
    } else {
      console.error(
        "Unexpected NowPayments payout response format:",
        response.data
      );
      req.flash(
        "error",
        "Withdrawal response unclear. Please check status or contact support."
      );
      return res.redirect("/trade");
    }
  } catch (err) {
    console.error("Withdrawal Controller Internal Error:", err);
    const error = new Error(
      "An internal error occurred during withdrawal process."
    );
    error.httpStatusCode = 500;
    error.originalError = err;
    return next(error);
  }
};

exports.paymentSuccess = async (req, res, next) => {
  try {
    // ** SECURITY FIX: DO NOT UPDATE BALANCE HERE **
    // This page should only CONFIRM to the user that they are being redirected
    // after initiating payment. The actual success and balance update must
    // come from a verified IPN callback from NowPayments.

    const userId = req.session.user?._id;
    const order_id = req.query.order_id; // Get order_id for display/reference

    if (!userId) {
      // Handle case where user returns but session expired
      return res.render("payment-pending", {
        // Render a generic pending page
        pageTitle: "Payment Processing",
        message:
          "Your payment is processing. You will be notified once confirmed.",
        orderId: order_id,
      });
    }

    const user = await User.findById(userId); // Fetch user for display name etc.

    // Render a view telling the user the payment is processing
    res.render("payment-success", {
      // Rename view if needed e.g., 'payment-processing'
      pageTitle: "Payment Initiated",
      user: user, // For display purposes maybe
      orderId: order_id,
      message:
        "Your payment transaction has been initiated. Your account will be updated once the payment is confirmed on the blockchain. Please check your deposit history or notifications later.",
      isAuthenticated: req.session.isLoggedIn, // Pass needed layout vars
    });
  } catch (err) {
    console.error("Error in paymentSuccess display page:", err);
    // Render a generic error or success page even if user fetch fails
    res.render("payment-pending", {
      pageTitle: "Payment Processing",
      message:
        "Your payment is processing. You will be notified once confirmed.",
      orderId: req.query.order_id,
    });
    // next(err); // Optionally pass to error handler
  }
};

exports.getEditUser = async (req, res, next) => {
  const editUserId = req.params.userId; // ID of user being edited
  const loggedInUserId = req.session.user?._id;
  const loggedInUserType = req.session.user?.type; // Assuming type is stored

  if (!loggedInUserId || loggedInUserType !== "admin") {
    // Basic authorization
    req.flash("error", "Unauthorized access.");
    return res.redirect("/");
  }

  const message = req.flash("error")[0] || req.flash("success")[0] || null; // Get flash messages

  try {
    const userToEdit = await User.findById(editUserId);

    if (!userToEdit) {
      req.flash("error", "User to edit not found.");
      return res.status(404).redirect("/admin");
    }

    res.render("edit-user", {
      // Adjust view path if needed
      pageTitle: `Edit User - ${userToEdit.fulname}`,
      path: "/admin/edit-user", // Adjust path identifier
      message: message, // Pass flash message correctly
      errorMessage: message && message.type === "error" ? message.text : null, // Or simplify based on view logic
      successMessage:
        message && message.type === "success" ? message.text : null, // Or simplify based on view logic
      user: userToEdit, // The user data to populate the form
      csrfToken: req.csrfToken(),
      isAuthenticated: req.session.isLoggedIn,
      // Pass loggedInUser if needed by layout
      loggedInUser: req.session.user,
    });
  } catch (err) {
    console.error(`Error fetching user ${editUserId} for edit:`, err);
    req.flash("error", "Error retrieving user details.");
    res.redirect("/admin");
    // next(err); // Optionally pass to error handler
  }
};

// --- END OF FILE home.js ---
