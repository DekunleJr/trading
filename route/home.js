const express = require("express");
const router = express.Router();
const controller = require("../controller/code");
const auth = require("../controller/isAuth");
const isAdmin = require("../controller/isAdmin");
const swapCrypto = require("../controller/swap");
const sendCrypto = require("../controller/send");
const apiController = require("../controller/apiController");

router.get("/", controller.getindex);

router.get("/contact", controller.getContact);

router.get("/service", controller.getService);

router.get("/trade", auth, controller.getTrade);

router.get("/admin", isAdmin, controller.getAdmin);

router.post("/contact", controller.postContact);

router.post("/withdraw", controller.postWithdraw);

router.post("/delete-user", isAdmin, controller.postDeleteUser);

router.post("/deposit", auth, controller.postDeposit);

router.get("/payment-success", auth, controller.paymentSuccess);

router.post("/edit", isAdmin, controller.postEditUser);

router.get("/withdrawals", auth, controller.getWithdrawals);

router.post(
  "/nowpayments-payout-ipn",
  apiController.verifyNowPaymentsSignature,
  apiController.handleNowPaymentsPayoutIPN
);

router.get("/edit-user/:userId", isAdmin, controller.getEditUser);

router.post("/swap", auth, swapCrypto.swapCrypto);

router.post("/send", auth, sendCrypto.sendCrypto);

module.exports = router;
