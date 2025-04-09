const crypto = require("crypto");
require("dotenv").config();
const Withdrawal = require("../model/withdrawal"); // Adjust path
const User = require("../model/user"); // Adjust path

const NOWPAYMENTS_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET;

// --- IPN Signature Verification Middleware (Optional but Recommended) ---
// You could place this logic directly in the handler or create reusable middleware
exports.verifyNowPaymentsSignature = async (req, res, next) => {
  if (!NOWPAYMENTS_IPN_SECRET) {
    console.error("IPN Secret Key is not configured.");
    return res.status(500).send("Internal Server Error: IPN not configured.");
  }

  const providedSignature = req.headers["x-nowpayments-sig"]; // Adjust header name if different
  if (!providedSignature) {
    console.warn("IPN Request received without signature.");
    return res.status(400).send("Signature missing.");
  }

  try {
    // IMPORTANT: NowPayments usually requires the RAW request body for signature verification
    // Ensure you are using middleware that provides req.rawBody or handle it before JSON parsing
    // If using standard bodyParser.json(), this might not work directly.
    // You might need: app.use(bodyParser.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

    // Assuming rawBody is available (Check NowPayments docs for exact hashing method)
    const hmac = crypto.createHmac("sha512", NOWPAYMENTS_IPN_SECRET);
    const digest = Buffer.from(
      hmac.update(req.rawBody || JSON.stringify(req.body)).digest("hex"),
      "utf8"
    ); // Use rawBody if possible, fallback to stringify (less reliable)
    const checksum = Buffer.from(providedSignature, "utf8");

    if (
      checksum.length !== digest.length ||
      !crypto.timingSafeEqual(digest, checksum)
    ) {
      console.warn("Invalid IPN Signature.");
      return res.status(403).send("Invalid signature.");
    }

    console.log("IPN Signature Verified Successfully.");
    next(); // Signature is valid, proceed to handler
  } catch (error) {
    console.error("Error verifying IPN signature:", error);
    return res.status(500).send("Error during signature verification.");
  }
};

// --- IPN Handler ---
// NOTE: Apply the verifyNowPaymentsSignature middleware to the route OR call it here.
// For simplicity, logic is included here but middleware is cleaner.
exports.handleNowPaymentsPayoutIPN = async (req, res, next) => {
  console.log("Received NowPayments Payout IPN:", req.body);
  console.log("IPN Headers:", req.headers);

  // --- 1. Verify Signature (Implement this robustly using middleware or as shown above) ---
  // IMPORTANT: Placeholder - Implement real signature verification!
  const providedSignature = req.headers["x-nowpayments-sig"]; // Adjust if header name differs
  if (!process.env.SKIP_IPN_VERIFICATION) {
    // Add a flag to skip ONLY for local testing if needed
    if (
      !providedSignature /* || !isValidSignature(req.rawBody || JSON.stringify(req.body), providedSignature, NOWPAYMENTS_IPN_SECRET) */
    ) {
      console.warn("IPN Signature verification failed or missing.");
      return res.status(403).send("Invalid or missing signature."); // Respond but don't process
    }
    console.log("IPN Signature looks present (implement full verification).");
  } else {
    console.warn("IPN Signature Verification Skipped (Development Only!)");
  }

  // --- 2. Process Payload ---
  const ipnData = req.body;
  const payoutId = ipnData.id || ipnData.payout_id; // Adjust field name based on actual IPN payload
  const batchId = ipnData.batch_withdrawal_id; // Adjust field name
  const status = ipnData.status; // e.g., 'FINISHED', 'FAILED', 'EXPIRED'
  const transactionHash = ipnData.hash;
  const error = ipnData.error; // Error details if status is FAILED

  if (!payoutId || !status) {
    console.warn("IPN missing required fields (payoutId, status):", ipnData);
    // Acknowledge receipt but indicate bad data
    return res.status(400).send("Missing required IPN data.");
  }

  try {
    // Find the withdrawal record using the NowPayments Payout ID
    const withdrawal = await Withdrawal.findOne({
      nowPaymentsPayoutId: payoutId,
    });

    if (!withdrawal) {
      console.warn(
        `Withdrawal record not found for NowPayments Payout ID: ${payoutId}`
      );
      // Acknowledge receipt, but log that we couldn't find the matching record
      return res.status(200).send("OK - Record not found");
    }

    // Avoid processing old statuses or reprocessing
    if (withdrawal.status === "FINISHED" || withdrawal.status === "FAILED") {
      console.log(
        `Withdrawal ${withdrawal._id} already finalized. Ignoring IPN for status: ${status}`
      );
      return res.status(200).send("OK - Already finalized");
    }

    // Update the withdrawal record
    withdrawal.nowPaymentsStatus = status; // Store the raw status
    if (transactionHash) {
      withdrawal.transactionHash = transactionHash;
    }
    if (error) {
      withdrawal.errorMessage =
        typeof error === "object" ? JSON.stringify(error) : error.toString();
    }

    // Map NowPayments status to your internal status
    let userBalanceUpdated = false;
    if (status.toLowerCase() === "finished") {
      withdrawal.status = "FINISHED";

      // --- CRITICAL: Update User Balance ONLY on Finished ---
      const user = await User.findById(withdrawal.userId);
      if (user) {
        // Ensure balance deduction is idempotent (doesn't happen twice)
        // This check relies on withdrawal status being updated before this point
        console.log(
          `Processing FINISHED status for withdrawal ${withdrawal._id}. Current user balance: ${user.investmentAmount}`
        );

        // Deduct amount - consider using atomic operations if needed
        user.investmentAmount -= withdrawal.amount;
        // Ensure balance doesn't go negative due to potential race conditions/rounding
        if (user.investmentAmount < 0) user.investmentAmount = 0;

        await user.save();
        userBalanceUpdated = true;
        console.log(
          `User ${user._id} balance updated to ${user.investmentAmount} for withdrawal ${withdrawal._id}`
        );
        // TODO: Optionally send user notification (email, etc.)
      } else {
        console.error(
          `User ${withdrawal.userId} not found when trying to update balance for withdrawal ${withdrawal._id}`
        );
        withdrawal.errorMessage =
          (withdrawal.errorMessage || "") +
          " | User balance update failed: User not found.";
        withdrawal.status = "FAILED"; // Mark as failed if user update fails
      }
    } else if (
      status.toLowerCase() === "failed" ||
      status.toLowerCase() === "expired"
    ) {
      withdrawal.status = "FAILED"; // Treat expired as failed for simplicity
      console.log(
        `Withdrawal ${withdrawal._id} marked as FAILED. Reason: ${error}`
      );
      // TODO: Optionally send user notification
    } else {
      // Handle other statuses like 'sending', 'confirming' etc.
      withdrawal.status = "PROCESSING"; // General processing state
      console.log(
        `Withdrawal ${withdrawal._id} status updated to PROCESSING (NowPayments status: ${status})`
      );
    }

    await withdrawal.save();

    // --- 3. Respond to NowPayments ---
    // Respond quickly with 200 OK to acknowledge receipt.
    // Heavy processing should ideally happen async if it takes time.
    res.status(200).send("OK");
  } catch (err) {
    console.error("Error processing NowPayments IPN:", err);
    res.status(200).send("OK - Internal processing error occurred");
  }
};
