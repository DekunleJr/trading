// --- Existing Imports ---
const { Web3 } = require("web3");
require("dotenv").config();
const { ethers } = require("ethers");
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const axios = require("axios");
const bitcoin = require("bitcoinjs-lib");
const { ECPairFactory } = require("ecpair");
const ecc = require("tiny-secp256k1");
// const Binance = require("node-binance-api"); // Assuming you use this for CEX

const User = require("../model/user");
const {
  decryptPrivateKey,
  deriveEVMPrivateKey,
} = require("../utils/encryption");

// --- Environment Variables & Config ---
const INFURA_API = process.env.INFURA_API;
// ... other RPCs, Contract Addresses, API Keys ...
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;

// Define which currencies operate on which primary chain for DEX swaps
const EVM_CHAIN_MAP = {
  ETH: { rpc: INFURA_API, chain: "Ethereum" },
  USDC: { rpc: INFURA_API, chain: "Ethereum" }, // Assuming ERC20
  USDT: { rpc: INFURA_API, chain: "Ethereum" }, // Assuming ERC20
  POLYGON: { rpc: process.env.POLYGON_RPC_URL, chain: "Polygon" }, // Native MATIC
  BNB: { rpc: process.env.BSC_RPC_URL, chain: "BSC" }, // Native BNB
};
const NON_EVM_CHAINS = ["BTC", "SOL"];

// Placeholder for the actual DEX/CEX swap functions (Implement these based on previous response)
const { swapOnDex } = require("./dexSwapHandler"); // Assume implementation is here
const { swapViaCex } = require("./cexSwapHandler"); // Assume implementation is here

// --- Unified On-Chain Swap Controller ---
exports.swapCrypto = async (req, res) => {
  const { fromCrypto, toCrypto, amount: amountString } = req.body;
  const fromUpper = fromCrypto?.toUpperCase();
  const toUpper = toCrypto?.toUpperCase();

  try {
    const user = await User.findById(req.session.user._id);
    if (!user) {
      req.flash("error", "User not found");
      return res.status(400).redirect("/trade");
    }

    // --- Input Validation ---
    const amountToSwap = parseFloat(amountString);
    if (isNaN(amountToSwap) || amountToSwap <= 0) {
      req.flash("error", "Invalid swap amount entered.");
      return res.status(400).redirect("/trade");
    }
    // Check if currencies are known/supported in the system
    const allSupported = Object.keys(user.cryptoWallet); // Get all wallets user has configured
    if (!allSupported.includes(fromUpper) || !allSupported.includes(toUpper)) {
      req.flash(
        "error",
        "One or both selected currencies are not configured for your wallet."
      );
      return res.status(400).redirect("/trade");
    }
    if (fromUpper === toUpper) {
      req.flash("error", "Cannot swap a currency for itself.");
      return res.status(400).redirect("/trade");
    }

    // --- Database Balance Check (Informational Only for On-Chain) ---
    // This check is preliminary. The actual on-chain balance matters most.
    const currentDbBalance = user.balances[fromUpper] || 0;
    if (amountToSwap > currentDbBalance) {
      // Warn user, but maybe allow proceeding if they know their on-chain balance is sufficient
      console.warn(
        `User ${user._id} attempting to swap ${amountToSwap} ${fromUpper}, but DB balance shows ${currentDbBalance}. Proceeding based on user input.`
      );
      req.flash(
        "error",
        `Insufficient ${fromUpper} balance recorded (${currentDbBalance}). Please update balances or ensure sufficient on-chain funds.`
      );
      return res.status(400).redirect("/trade");
    }

    // --- Determine Swap Type (Same-Chain DEX vs. Cross-Chain CEX) ---
    let isSameChainSwap = false;
    let chainInfo = null;

    const fromChain =
      EVM_CHAIN_MAP[fromUpper]?.chain ||
      (NON_EVM_CHAINS.includes(fromUpper) ? fromUpper : null);
    const toChain =
      EVM_CHAIN_MAP[toUpper]?.chain ||
      (NON_EVM_CHAINS.includes(toUpper) ? toUpper : null);

    console.log(
      `Swap Type Check: From ${fromUpper} (Chain: ${fromChain}) To ${toUpper} (Chain: ${toChain})`
    );

    // Simplistic check: Are both on the *same* mapped EVM chain?
    if (
      fromChain &&
      fromChain === toChain &&
      EVM_CHAIN_MAP[fromUpper] &&
      EVM_CHAIN_MAP[toUpper]
    ) {
      // Example: ETH <-> USDC (both Ethereum), MATIC <-> SomePolygonToken (if configured)
      isSameChainSwap = true;
      chainInfo = EVM_CHAIN_MAP[fromUpper]; // Get RPC info for the chain
      console.log(`Determined: Same-Chain Swap on ${chainInfo.chain}`);
    } else {
      isSameChainSwap = false;
      console.log("Determined: Cross-Chain Swap (will use CEX API route)");
    }

    // --- Get Private Key ---
    let privateKey;
    try {
      if (NON_EVM_CHAINS.includes(fromUpper)) {
        privateKey = decryptPrivateKey(
          user.privateKeys[fromUpper.toLowerCase()]
        );
      } else if (EVM_CHAIN_MAP[fromUpper]) {
        // Handle all EVM chains
        privateKey = deriveEVMPrivateKey(user.mnemonic, fromUpper); // Assuming derivation works per-currency/chain
      } else {
        throw new Error(`Unsupported currency for key retrieval: ${fromUpper}`);
      }
    } catch (keyError) {
      console.error(
        "Error retrieving/decrypting private key for swap:",
        keyError
      );
      req.flash(
        "error",
        "Could not access wallet key for the 'from' currency."
      );
      return res.redirect("/trade");
    }
    if (!privateKey) {
      req.flash("error", `Could not retrieve private key for ${fromUpper}.`);
      return res.redirect("/trade");
    }

    // --- Execute Swap based on Type ---
    let transactionStatus = { success: false, error: "Swap not initiated." };

    if (isSameChainSwap) {
      // --- Execute Same-Chain DEX Swap ---
      if (!chainInfo?.rpc) {
        req.flash(
          "error",
          `RPC URL not configured for chain ${chainInfo?.chain}.`
        );
        return res.redirect("/trade");
      }
      console.log(
        `Initiating DEX swap on ${chainInfo.chain} via ${chainInfo.rpc}`
      );

      // We need the actual contract addresses or 'ETH'/'MATIC'/'BNB' symbols
      const fromTokenParam = fromUpper; // e.g., 'ETH', 'USDC', 'MATIC'
      const toTokenParam = toUpper; // e.g., 'USDC', 'ETH', 'SomeOtherToken'

      // !!! Call the actual swapOnDex implementation !!!
      // This function needs to handle approvals, paths, slippage etc.
      // It needs chain-specific Router/WETH addresses.
      transactionStatus = await swapOnDex(
        chainInfo.rpc, // Pass the correct RPC
        privateKey,
        fromTokenParam, // Address or native symbol
        toTokenParam, // Address or native symbol
        amountString // Pass amount as string for precision
      );
    } else {
      // --- Execute Cross-Chain CEX Swap ---
      console.log("Initiating Cross-Chain swap via CEX API");
      if (!BINANCE_API_KEY || !BINANCE_API_SECRET) {
        // Check CEX keys
        req.flash("error", "CEX API Keys (Binance) are not configured.");
        return res.redirect("/trade");
      }

      const userFromAddress = user.cryptoWallet[fromUpper];
      const userToReceiveAddress = user.cryptoWallet[toUpper]; // Target address for CEX withdrawal

      if (!userFromAddress || !userToReceiveAddress) {
        req.flash(
          "error",
          `Missing wallet address for ${
            !userFromAddress ? fromUpper : toUpper
          }.`
        );
        return res.redirect("/trade");
      }

      // !!! Call the actual swapViaCex implementation !!!
      // This function needs to handle deposit address gen, initiating user's send,
      // monitoring (complex!), trading, withdrawing.
      transactionStatus = await swapViaCex(
        user._id,
        userFromAddress,
        userToReceiveAddress, // Where CEX should send the final crypto
        fromUpper,
        toUpper,
        amountToSwap, // Amount user wants to deposit to CEX
        privateKey // Needed to initiate the *deposit* send from user's wallet
        // We might need the 'toCrypto' private key if CEX withdrawal requires signing? Usually not.
      );
    }

    // --- Handle Result ---
    if (transactionStatus.success) {
      console.log(
        `On-chain swap initiated successfully. Result:`,
        transactionStatus
      );
      // DO NOT update database balance here for on-chain swaps.
      // Reconciliation should happen based on confirmed events.
      req.flash(
        "success",
        `On-chain swap from ${fromUpper} to ${toUpper} initiated. ${
          transactionStatus.transactionHash
            ? `Tx Hash: ${transactionStatus.transactionHash}`
            : ""
        }${
          transactionStatus.transactionSignature
            ? `Tx Sig: ${transactionStatus.transactionSignature}`
            : ""
        }${
          transactionStatus.withdrawalId
            ? `CEX Withdrawal ID: ${transactionStatus.withdrawalId}`
            : ""
        }${
          transactionStatus.message
            ? ` Status: ${transactionStatus.message}`
            : " Check blockchain/exchange for confirmation."
        }`
      );
    } else {
      console.error(`On-chain swap failed. Error: ${transactionStatus.error}`);
      req.flash(
        "error",
        `On-chain swap failed: ${transactionStatus.error || "Unknown error"}`
      );
    }
    return res.redirect("/trade");
  } catch (error) {
    console.error("Critical On-Chain Swap Controller Error:", error);
    req.flash(
      "error",
      error.message || "An unexpected error occurred during the swap process"
    );
    return res.redirect("/trade");
  }
};
