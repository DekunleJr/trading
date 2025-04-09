const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const withdrawalSchema = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: "User", // Make sure 'User' matches your user model name
    required: true,
    index: true, // Index for faster lookups by user
  },
  amount: {
    type: Number,
    required: true,
  },
  currency: {
    type: String, // e.g., 'usdterc20'
    required: true,
  },
  address: {
    // The destination address
    type: String,
    required: true,
  },
  nowPaymentsPayoutId: {
    // The specific withdrawal ID from NowPayments
    type: String,
    required: true,
    unique: true, // Ensure we don't process the same payout ID twice via IPN
    index: true,
  },
  nowPaymentsBatchId: {
    // The batch ID from NowPayments
    type: String,
    required: true,
  },
  status: {
    type: String,
    enum: ["INITIATED", "PROCESSING", "FINISHED", "FAILED", "EXPIRED"], // Possible statuses
    default: "INITIATED",
    required: true,
  },
  transactionHash: {
    // Blockchain transaction hash (populated on completion)
    type: String,
    default: null,
  },
  nowPaymentsStatus: {
    // Store the raw status from NowPayments IPN
    type: String,
  },
  errorMessage: {
    // Store error message if payout failed
    type: String,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Update the 'updatedAt' field before saving
withdrawalSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model("Withdrawal", withdrawalSchema);
