const express = require("express");
const router = express.Router();
const controller = require("../controller/home");
const auth = require("../controller/isAuth");
const isAdmin = require("../controller/isAdmin");
const payment = require("../controller/payment");

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

router.get("/crypto", auth, controller.getCrypto);

router.post("/upload", auth, controller.postCrypto);

router.get("/edit-user/:userId", isAdmin, controller.getEditUser);

router.post("/swap", auth, payment.swapCrypto);

router.post("/send", auth, payment.sendCrypto);

module.exports = router;
