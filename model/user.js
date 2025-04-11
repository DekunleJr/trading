const mongoose = require("mongoose");

const Schema = mongoose.Schema;

const user = new Schema({
  fulname: {
    type: String,
    required: true,
  },
  phone: {
    type: Number,
    required: true,
    unique: true,
  },
  password: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
  },
  investment: {
    type: String,
  },
  investmentAmount: {
    type: Number,
    default: 0,
  },
  investmentDate: {
    type: Date,
    default: Date.now,
  },
  mnemonic: String,
  cryptoWallet: {
    ETH: { type: String, required: true },
    USDT_ERC20: { type: String, required: true },
    USDC_ERC20: { type: String, required: true },
    USDT_TRC20: { type: String, required: true },
    TRX: { type: String, required: true },
  },
  balances: {
    ETH: { type: Number, default: 0 },
    USDT_ERC20: { type: Number, default: 0 },
    USDC_ERC20: { type: Number, default: 0 },
    USDT_TRC20: { type: Number, default: 0 },
    TRX: { type: Number, default: 0 },
  },
  privateKeys: {
    tron: { type: String, required: true },
  },
  depositCurrency: {
    type: String,
    enum: ["USDT_ERC20", "USDC_ERC20", "USDT_TRC20", "ETH"],
    default: "USDT_ERC20",
  },
  type: {
    type: String,
    default: "user",
  },
  ref: String,
  resetToken: String,
  resetTokenExpiration: Date,
});

module.exports = mongoose.model("User", user);
