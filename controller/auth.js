const crypto = require("crypto");
require("dotenv").config();
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const { validationResult } = require("express-validator");
const { ethers } = require("ethers");
const User = require("../model/user");
const TronWeb = require("tronweb");
const { encryptPrivateKey } = require("../utils/encryption");

const tronWeb = new TronWeb(
  "https://api.trongrid.io",
  "https://api.trongrid.io",
  "https://api.trongrid.io"
);

const transporter = nodemailer.createTransport({
  host: "smtp.zoho.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER_2,
    pass: process.env.EMAIL_PASS_2,
  },
});

exports.getLogin = (req, res, next) => {
  const message = req.flash("error")[0] || null;
  res.render("login", {
    path: "/login",
    pageTitle: "Login",
    errorMessage: message,
    oldInput: { email: "", password: "" },
  });
};

exports.getSignup = (req, res, next) => {
  const message = req.flash("error")[0] || null;
  res.render("signup", {
    path: "/signup",
    pageTitle: "Signup",
    errorMessage: message,
    oldInput: {
      fulname: "",
      phone: "",
      password: "",
      email: "",
      investment: "",
      ref: "",
    },
  });
};

exports.postSignup = async (req, res, next) => {
  let { fulname, phone, password, email, investment, ref } = req.body;
  const errors = validationResult(req);

  // Generate a mnemonic (seed phrase)
  const wallet = ethers.Wallet.createRandom();
  const mnemonic = wallet.mnemonic.phrase;
  const hdNode = ethers.utils.HDNode.fromMnemonic(mnemonic);

  // Ethereum & BNB (Both use same derivation path)
  const ethWallet = hdNode.derivePath("m/44'/60'/0'/0/0");
  const usdcWallet = ethWallet.address;

  // 3. Tron Wallet (for USDT_TRC20)
  const tronAccount = await tronWeb.createAccount(); // Creates a new random Tron account
  const tronAddress = tronAccount.address.base58; // Use the base58 address
  const tronPrivateKey = tronAccount.privateKey;

  // Encrypt Tron Private Key before storing
  const encryptedTronPrivateKey = encryptPrivateKey(tronPrivateKey);

  if (!errors.isEmpty()) {
    return res.status(422).render("signup", {
      path: "/signup",
      pageTitle: "Signup",
      errorMessage: errors.array()[0].msg,
      oldInput: { fulname, phone, password, email, investment, ref },
      validationErrors: errors.array(),
    });
  }

  try {
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create new user
    const user = new User({
      fulname,
      phone,
      password: hashedPassword,
      email,
      investment,
      ref,
      mnemonic,
      cryptoWallet: {
        ETH: usdcWallet,
        USDT_ERC20: usdcWallet,
        USDC_ERC20: usdcWallet,
        USDT_TRC20: tronAddress,
        TRX: tronAddress,
      },
      privateKeys: {
        tron: encryptedTronPrivateKey,
      },
    });

    // Save user to database
    await user.save();

    // Send success email
    try {
      await transporter.sendMail({
        to: email,
        from: process.env.EMAIL_USER_2,
        subject: "Signup successful",
        html: `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 0; }
            .container { max-width: 600px; margin: auto; padding: 20px; }
            h1 { color: #333; }
            h3 { color: #555; }
            p { line-height: 1.6; }
            .wallet-info { margin-bottom: 10px; }
            .wallet-info strong { font-weight: bold; }
            .note { color: #777; font-style: italic; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>You signed up successfully!</h1>
            <h3>Wallet Addresses</h3>
            <div class="wallet-info">
              <li><b></b> </li>
                <p><strong>USDT (ERC20 on Ethereum):</strong> ${
                  ethWallet.address
                }</p>
                <p><strong>USDC (ERC20 on Ethereum):</strong> ${
                  ethWallet.address
                }</p>
                <p><strong>ETH Wallet Address:</strong> ${ethWallet.address}</p>
                <p><strong>TRX (Tron Network):</strong> ${tronAddress}</p>
                <p><strong>USDT (TRC20 on Tron):</strong> ${tronAddress}</p>
                <p><strong>Passphrase:</strong> ${mnemonic} <span class="note">[Please keep this safe]</span></p>
                <p><strong>USDT (TRC20 on Tron) Secret Key:</strong> ${tronPrivateKey} <span class="note">[Please keep this safe]</span></p>
                <p>You can now <a href="${req.protocol}://${req.get(
          "host"
        )}/login">login</a> to your account.
                </p>
            </div>
        </div>
    </body>
    </html>
  `,
      });
    } catch (emailError) {
      console.error("Error sending email:", emailError);
    }

    // Redirect to login
    res.redirect("/login");
  } catch (err) {
    console.error("Error in postSignup:", err);
    next(new Error(err)); // Pass error to centralized error handling middleware
  }
};

exports.postLogin = async (req, res, next) => {
  const { email, password } = req.body;
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return res.status(422).render("login", {
      path: "/login",
      pageTitle: "Login",
      errorMessage: errors.array()[0].msg,
      oldInput: { email, password },
      validationErrors: errors.array(),
    });
  }

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(422).render("login", {
        path: "/login",
        pageTitle: "Login",
        errorMessage: "Email not registered",
        oldInput: { email, password },
        validationErrors: [],
      });
    }

    const doMatch = await bcrypt.compare(password, user.password);
    if (doMatch) {
      req.session.isLoggedIn = true;
      req.session.user = user;
      return req.session.save(() => {
        res.redirect("/trade");
      });
    }

    res.status(422).render("login", {
      path: "/login",
      pageTitle: "Login",
      errorMessage: "Invalid email or password!",
      oldInput: { email, password },
      validationErrors: [],
    });
  } catch (err) {
    console.log(err);
  }
};

exports.postLogout = (req, res, next) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
};

exports.getReset = async (req, res, next) => {
  const message = req.flash("error")[0] || null;
  res.render("reset", {
    path: "/reset",
    pageTitle: "Reset Password",
    errorMessage: message,
  });
};

// POST Reset
exports.postReset = async (req, res, next) => {
  try {
    const buffer = await crypto.randomBytes(32);
    const token = buffer.toString("hex");
    const user = await User.findOne({ email: req.body.email });

    if (!user) {
      req.flash("error", "No account with this email found");
      return res.redirect("/reset");
    }

    user.resetToken = token;
    user.resetTokenExpiration = Date.now() + 3600000;
    await user.save();

    res.redirect("/");
    await transporter.sendMail({
      to: req.body.email,
      from: process.env.EMAIL_USER_2,
      subject: "Password Reset",
      html: `
        <h3>You requested a password reset.</h3>
        <p>Click <a href="http://localhost:4000/reset/${token}">here</a> to set a new password.</p>
      `,
    });
  } catch (err) {
    next(new Error(err));
  }
};

exports.getNewPassword = async (req, res, next) => {
  const token = req.params.token;
  try {
    const user = await User.findOne({
      resetToken: token,
      resetTokenExpiration: { $gt: Date.now() },
    });

    if (!user) {
      req.flash("error", "Token is invalid or expired.");
      return res.redirect("/reset");
    }

    const message = req.flash("error")[0] || null;
    res.render("password", {
      path: "/password",
      pageTitle: "New Password",
      errorMessage: message,
      userId: user._id.toString(),
      passwordToken: token,
    });
  } catch (err) {
    next(new Error(err));
  }
};

exports.postNewPassword = async (req, res, next) => {
  const { password, userId, passwordToken } = req.body;

  try {
    const user = await User.findOne({
      resetToken: passwordToken,
      resetTokenExpiration: { $gt: Date.now() },
      _id: userId,
    });

    if (!user) {
      req.flash("error", "Invalid or expired token.");
      return res.redirect("/reset");
    }

    user.password = await bcrypt.hash(password, 12);
    user.resetToken = undefined;
    user.resetTokenExpiration = undefined;
    await user.save();

    res.redirect("/login");
  } catch (err) {
    next(new Error(err));
  }
};
