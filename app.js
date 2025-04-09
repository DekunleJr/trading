const express = require("express");
const helmet = require("helmet");
const path = require("path");
const fs = require("fs");
require("dotenv").config();
const bodyParser = require("body-parser");
const mongoose = require("mongoose");
const session = require("express-session");
const MongoDBStore = require("connect-mongodb-session")(session);
const csrf = require("csurf");
const flash = require("connect-flash");
const multer = require("multer");
const compression = require("compression");
const morgan = require("morgan");
require("./cron/investmentCron");

const errorController = require("./controller/error");
const User = require("./model/user.js");

const MONGODB_URI = process.env.MONGODB_URI;

const app = express();
const store = new MongoDBStore({
  uri: MONGODB_URI,
  collection: "sessions",
});
const csrfProtection = csrf();

const fileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "public/img");
  },
  filename: (req, file, cb) => {
    cb(null, new Date().toDateString() + "-" + file.originalname);
  },
});

const fileFilter = (req, file, cb) => {
  if (
    file.mimetype === "image/jpeg" ||
    file.mimetype === "image/jpg" ||
    file.mimetype === "image/png"
  ) {
    cb(null, true);
  } else {
    cb(null, false);
  }
};

app.set("view engine", "ejs");
app.set("views", "views");

const routes = require("./route/home.js");
const authRoutes = require("./route/auth.js");

const accessLogStream = fs.createWriteStream(
  path.join(__dirname, "access.log"),
  { flags: "a" }
);

app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);
app.use(compression());
app.use(morgan("combined", { stream: accessLogStream }));

app.use(bodyParser.urlencoded({ extended: false }));
app.use(
  bodyParser.json({
    verify: (req, res, buf, encoding) => {
      try {
        // Only store rawBody for specific routes if needed, e.g., IPN routes
        if (req.path.includes("/api/nowpayments-payout-ipn")) {
          // Adjust path condition
          req.rawBody = buf.toString(encoding || "utf8");
        }
      } catch (e) {
        console.error("Raw body verification failed:", e);
        res.status(400).send("Invalid request body"); // Prevent further processing
        throw e; // Re-throw to stop request handling
      }
    },
  })
);
app.use(
  multer({ storage: fileStorage, fileFilter: fileFilter }).single("image")
);
app.use(express.static(path.join(__dirname, "public")));

app.get("/favicon.ico", (req, res) => {
  res.status(204).end();
});

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: store,
    cookie: {
      secure: false,
      httpOnly: true,
      sameSite: "lax",
    },
  })
);
app.use(csrfProtection);
app.use(flash());

app.use((req, res, next) => {
  if (!req.session.user || req.path === "/500") {
    return next();
  }
  User.findById(req.session.user._id)
    .then((user) => {
      req.user = user;
      next();
    })
    .catch((err) => console.log(err));
});

app.use((req, res, next) => {
  res.locals.isAuthenticated = req.session.isLoggedIn;
  res.locals.csrfToken = req.csrfToken();
  res.locals.userRole = req.session.user ? req.session.user.type : null;
  next();
});

app.use(authRoutes);
app.use(routes);

app.use("/500", errorController.get500);

app.use(errorController.error);

app.use((error, req, res, next) => {
  console.error("Server Error:", error);
  res.status(500).render("500", {
    pageTitle: "Server Error",
    path: "/500",
  });
});
mongoose
  .connect(MONGODB_URI)
  .then((result) => {
    app.listen(process.env.PORT);
    console.log(`connected on ${process.env.PORT}`);
  })
  .catch((err) => {
    console.error("Error connecting to MongoDB Atlas:", err);
    console.log("Error Stack:", err.stack);
  });
