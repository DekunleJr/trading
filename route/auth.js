const express = require("express");
const { check, body } = require("express-validator");
const User = require("../model/user");

const controller = require("../controller/auth");

const router = express.Router();

router.get("/login", controller.getLogin);

router.get("/signup", controller.getSignup);

router.get("/reset", controller.getReset);

router.post(
  "/signup",
  [
    check("email")
      .isEmail()
      .withMessage("Please enter a valid email")
      .custom((value, { req }) => {
        return User.findOne({ email: value }).then((userDoc) => {
          if (userDoc) {
            return Promise.reject(
              "E-Mail exists already, please pick a different one."
            );
          }
        });
      })
      .normalizeEmail(),
    body("password", "Enter atleast 8 characters containing numbers and text")
      .isLength({ min: 8 })
      .isAlphanumeric()
      .trim(),
    check("confirm_password")
      .custom((value, { req }) => value === req.body.password)
      .withMessage("Passwords do not match")
      .trim(),
  ],
  controller.postSignup
);

router.post(
  "/login",
  [
    check("email")
      .isEmail()
      .withMessage("Please enter a valid email")
      .normalizeEmail(),
    body("password", "Enter atleast 8 characters containing numbers and text")
      .isLength({ min: 6 })
      .isAlphanumeric()
      .trim(),
  ],
  controller.postLogin
);

router.post("/logout", controller.postLogout);

router.post("/reset", controller.postReset);

router.get("/reset/:token", controller.getNewPassword);

router.post(
  "/password",
  [
    body("password", "Enter atleast 8 characters containing numbers and text")
      .isLength({ min: 8 })
      .isAlphanumeric()
      .trim(),
    check("confirm_password")
      .custom((value, { req }) => value === req.body.password)
      .withMessage("Passwords do not match")
      .trim(),
  ],
  controller.postNewPassword
);

module.exports = router;
