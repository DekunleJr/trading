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
    BTC: String,
    ETH: String,
    BNB: String,
    SOL: String,
    USDT: String,
    USDC: String,
    POLYGON: String,
  },
  balances: {
    BTC: { type: Number, default: 0 },
    ETH: { type: Number, default: 0 },
    BNB: { type: Number, default: 0 },
    SOL: { type: Number, default: 0 },
    USDT: { type: Number, default: 0 },
    USDC: { type: Number, default: 0 },
    POLYGON: { type: Number, default: 0 },
  },
  privateKeys: {
    btc: String,
    sol: String,
  },
  depositCurrency: {
    type: String,
    default: "USDT_ERC20",
  },
  type: String,
  ref: String,
  resetToken: String,
  resetTokenExpiration: Date,
});

module.exports = mongoose.model("User", user);
