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
  withdrawal: {
    type: String,
    default: "No",
  },
  type: String,
  ref: String,
  resetToken: String,
  resetTokenExpiration: Date,
});

module.exports = mongoose.model("User", user);
