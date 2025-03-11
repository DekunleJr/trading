const crypto = require("crypto");
require("dotenv").config();
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const { validationResult } = require("express-validator");
const User = require("../model/user");

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
  console.log(errors);

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
    });

    // Save user to database
    await user.save();

    // Send success email
    try {
      await transporter.sendMail({
        to: email,
        from: process.env.EMAIL_USER_2,
        subject: "Signup successful",
        html: "<h1>You signed up successfully!</h1>",
      });
    } catch (emailError) {
      console.error("Error sending email:", emailError);
    }

    // Redirect to login
    res.redirect("/login");
  } catch (err) {
    console.error("Error in postSignup:", err);
    next(err); // Pass error to centralized error handling middleware
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
      from: process.env.EMAIL_USER,
      subject: "Password Reset",
      html: `
        <h3>You requested a password reset.</h3>
        <p>Click <a href="https://tradereturn.org/reset/${token}">here</a> to set a new password.</p>
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
