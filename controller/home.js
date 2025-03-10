const User = require("../model/user");
const nodemailer = require("nodemailer");
// const axios = require("axios");
const { validationResult } = require("express-validator");
const fs = require("fs");
const path = require("path");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

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

    // Calculate 50% return and payout date (1 month from investment date)
    const payoutDate = new Date(user.investmentDate);
    payoutDate.setMonth(payoutDate.getMonth() + 1); // Add 1 month
    res.render("trade", {
      path: "/trade",
      pageTitle: "My Trade",
      user: {
        fulname: user.fulname,
        email: user.email,
        investmentAmount: user.investmentAmount,
        payoutDate: payoutDate.toDateString(),
      },
    });
  } catch (err) {
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
    const { name, email, amount, address } = req.body;
    const user = await User.findOne({ email: req.body.email });

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
      text: `Name: ${name}\nEmail: ${email}\n\nMessage:\n The user ${name} with email ${email} is requesting to be paid ${amount} to is wallet address which is ${address}`,
    };
    user.withdrawal = "Yes";
    await user.save();
    await transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        return res.status(500).send("Failed to send message");
      }
      res.redirect("/trade");
    });
  } catch (err) {
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
    // next(new Error(err));
    console.log(err);
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
    next(err); // Pass error to centralized error handling middleware
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
        cancel_url: `${req.protocol}://${req.get("host")}/deposit-cancel`,
      });

      res.redirect(303, session.url);
    } else {
      res.redirect("/crypto");
    }
  } catch (err) {
    console.error("Deposit :", err);
    next(err);
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
      path: "/",
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
    next();
  }
};
