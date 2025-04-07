// Required Imports at the top
const { Web3 } = require("web3");
require("dotenv").config();
const {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  PublicKey,
  LAMPORTS_PER_SOL, // Import constant
} = require("@solana/web3.js");
const { ethers } = require("ethers"); // Make sure ethers is imported
const {
  deriveEVMPrivateKey,
  decryptPrivateKey,
} = require("../utils/encryption");
const User = require("../model/user");
const axios = require("axios");
const bitcoin = require("bitcoinjs-lib");
const network = bitcoin.networks.bitcoin;
const { ECPairFactory } = require("ecpair");
const ecc = require("tiny-secp256k1");
const ECPair = ECPairFactory(ecc);
const bs58 = require("bs58"); // Needed for SOL key decoding

// --- Environment Variables ---
const INFURA_API = process.env.INFURA_API; // Ethereum
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL;
const BSC_RPC_URL = process.env.BSC_RPC_URL;
const USDT_CONTRACT_ADDRESS = process.env.USDT_CONTRACT_ADDRESS;
const USDC_CONTRACT_ADDRESS = process.env.USDC_CONTRACT_ADDRESS;
const BLOCKCYPHER_TOKEN = process.env.BLOCKCYPHER_TOKEN;

// --- Helper: Minimal ERC20 ABI ---
const erc20Abi = [
  {
    constant: false,
    inputs: [
      { name: "_to", type: "address" },
      { name: "_value", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ name: "", type: "bool" }],
    type: "function",
  },
  {
    constant: true,
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    type: "function",
  },
  {
    constant: true,
    inputs: [{ name: "_owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "balance", type: "uint256" }],
    type: "function",
  },
];

// --- Controller function to send crypto ---
exports.sendCrypto = async (req, res) => {
  const { toAddress, amount: amountString, currency } = req.body; // Get amount as string initially
  const currencyUpper = currency.toUpperCase(); // Normalize currency name

  try {
    const user = await User.findById(req.session.user._id);
    if (!user) {
      req.flash("error", "User not found");
      return res.status(400).redirect("/trade");
    }

    // --- Input Validation ---
    const amount = parseFloat(amountString);
    if (isNaN(amount) || amount <= 0) {
      req.flash("error", "Invalid amount entered.");
      return res.status(400).redirect("/trade");
    }
    // Validate recipient address based on currency
    if (currencyUpper === "BTC" && !/^(1|3|bc1)/.test(toAddress)) {
      // Basic BTC check
      req.flash(
        "error",
        `Invalid recipient address format for ${currencyUpper}.`
      );
      return res.status(400).redirect("/trade");
    } else if (currencyUpper === "SOL") {
      try {
        new PublicKey(toAddress);
      } catch (e) {
        req.flash(
          "error",
          `Invalid recipient address format for ${currencyUpper}.`
        );
        return res.status(400).redirect("/trade");
      }
    } else if (
      ["ETH", "USDC", "USDT", "POLYGON", "BNB"].includes(currencyUpper)
    ) {
      if (!ethers.utils.isAddress(toAddress)) {
        req.flash(
          "error",
          `Invalid recipient address format for ${currencyUpper}.`
        );
        return res.status(400).redirect("/trade");
      }
    } // Add checks for other currencies if needed

    // --- Balance Check ---
    // const currentBalance = user.balances[currencyUpper] || 0;
    // if (amount > currentBalance) {
    //   req.flash("error", `Insufficient funds. You have ${currentBalance} ${currencyUpper}, tried to send ${amount}.`);
    //   return res.status(400).redirect("/trade");
    // }

    // --- WARNING: Fee Logic ---
    // This 5% deduction is NOT how blockchain fees work.
    // Actual network fees (gas/tx fees) are separate and paid in native currency (ETH/MATIC/BNB/BTC/SOL).
    // This logic only deducts from the *sent* amount and the user's balance display.
    // It does NOT guarantee the user has enough native currency for the actual network fee.
    const fee = amount * 0.05; // Your 5% calculation
    const sendAmount = amount - fee; // Amount the recipient actually gets (before network fee)
    const totalDeduction = amount; // Total amount to deduct from user's displayed balance

    console.log(
      `Sending ${currencyUpper}: Amount=${amount}, Fee(5%)=${fee}, NetSend=${sendAmount}, TotalDeduct=${totalDeduction}`
    );

    // Re-check balance AFTER calculating the total deduction (which is the original amount)
    // if (totalDeduction > currentBalance) {
    //     req.flash("error", "Calculation error: Cannot proceed."); // Should have been caught earlier, but safety check
    //     return res.redirect("/trade");
    // }

    // --- Get Wallet Keys ---
    const walletAddress = user.cryptoWallet[currencyUpper];
    let privateKey;

    try {
      if (currencyUpper === "BTC") {
        privateKey = decryptPrivateKey(user.privateKeys.btc);
      } else if (currencyUpper === "SOL") {
        privateKey = decryptPrivateKey(user.privateKeys.sol);
      } else if (
        ["ETH", "BNB", "USDT", "USDC", "POLYGON"].includes(currencyUpper)
      ) {
        // Assuming deriveEVMPrivateKey works correctly for all these
        privateKey = deriveEVMPrivateKey(user.mnemonic, currencyUpper);
      } else {
        req.flash("error", `Unsupported cryptocurrency: ${currencyUpper}`);
        return res.redirect("/trade");
      }
    } catch (keyError) {
      console.error("Error retrieving/decrypting private key:", keyError);
      req.flash(
        "error",
        "Could not access wallet key. Please check configuration."
      );
      return res.redirect("/trade");
    }

    if (!walletAddress || !privateKey) {
      req.flash(
        "error",
        `Wallet address or key not found for ${currencyUpper}.`
      );
      return res.redirect("/trade");
    }

    // --- Dispatch Transaction ---
    let transactionStatus = {
      success: false,
      error: "Transaction not initiated.",
    };
    let tokenContractAddress = null;

    switch (currencyUpper) {
      case "ETH":
        if (!INFURA_API) {
          transactionStatus = {
            success: false,
            error: "Ethereum RPC (INFURA_API) not configured.",
          };
          break;
        }
        transactionStatus = await sendNativeCoin(
          INFURA_API,
          walletAddress,
          toAddress,
          sendAmount,
          privateKey
        );
        break;

      case "USDC":
        tokenContractAddress = USDC_CONTRACT_ADDRESS;
        if (!tokenContractAddress) {
          transactionStatus = {
            success: false,
            error: "USDC Contract Address not configured.",
          };
          break;
        }
      // Falls through to USDT logic intentionally as both are ERC20 on ETH mainnet
      case "USDT":
        if (!tokenContractAddress) tokenContractAddress = USDT_CONTRACT_ADDRESS; // Set USDT if not already set by USDC fallthrough
        if (!tokenContractAddress) {
          transactionStatus = {
            success: false,
            error: "USDT Contract Address not configured.",
          };
          break;
        }
        if (!INFURA_API) {
          transactionStatus = {
            success: false,
            error: "Ethereum RPC (INFURA_API) not configured.",
          };
          break;
        }
        // Call the ERC20 send function
        transactionStatus = await sendErc20Token(
          INFURA_API,
          privateKey,
          tokenContractAddress,
          toAddress,
          sendAmount
        );
        break;

      case "SOL":
        transactionStatus = await sendSOL(toAddress, sendAmount, privateKey); // Note: `fromAddress` comes from Keypair
        break;

      case "POLYGON": // Assuming sending native MATIC
        if (!POLYGON_RPC_URL) {
          transactionStatus = {
            success: false,
            error: "Polygon RPC URL not configured.",
          };
          break;
        }
        transactionStatus = await sendNativeCoin(
          POLYGON_RPC_URL,
          walletAddress,
          toAddress,
          sendAmount,
          privateKey
        );
        break;

      case "BNB": // Assuming sending native BNB
        if (!BSC_RPC_URL) {
          transactionStatus = {
            success: false,
            error: "BSC RPC URL not configured.",
          };
          break;
        }
        transactionStatus = await sendNativeCoin(
          BSC_RPC_URL,
          walletAddress,
          toAddress,
          sendAmount,
          privateKey
        );
        break;

      case "BTC":
        if (!BLOCKCYPHER_TOKEN) {
          transactionStatus = {
            success: false,
            error: "Blockcypher Token not configured.",
          };
          break;
        }
        transactionStatus = await sendBTC(
          walletAddress,
          toAddress,
          sendAmount,
          privateKey
        );
        break;

      default:
        req.flash(
          "error",
          `Unsupported currency for sending: ${currencyUpper}`
        );
        return res.redirect("/trade");
    }

    // --- Handle Transaction Result ---
    if (transactionStatus.success) {
      // Deduct the TOTAL amount (including the 5% 'fee') from user's displayed balance
      user.balances[currencyUpper] =
        (user.balances[currencyUpper] || 0) - totalDeduction;
      await user.save();

      req.flash(
        "success",
        `Transaction initiated: Sending ${sendAmount.toFixed(
          8
        )} ${currencyUpper} to ${toAddress}. Hash/Sig: ${
          transactionStatus.transactionHash ||
          transactionStatus.transactionSignature
        }`
      );
    } else {
      req.flash(
        "error",
        `Transaction failed: ${transactionStatus.error || "Unknown error"}`
      );
    }
    return res.redirect("/trade");
  } catch (error) {
    console.error("Critical Send Crypto Error:", error);
    req.flash(
      "error",
      error.message || "An unexpected error occurred during the transaction"
    );
    return res.redirect("/trade");
  }
};

// --- Refactored Native Coin Send Function (ETH, MATIC, BNB) ---
const sendNativeCoin = async (
  rpcUrl,
  fromAddress,
  toAddress,
  amount,
  secretKey
) => {
  const web3 = new Web3(rpcUrl);
  let gasLimit;
  let gasPrice; // Or use EIP-1559 fields

  try {
    const senderAccount = web3.eth.accounts.privateKeyToAccount(secretKey);
    // Verify derived address matches stored address
    if (senderAccount.address.toLowerCase() !== fromAddress.toLowerCase()) {
      console.error(
        `Address mismatch! Stored: ${fromAddress}, Derived: ${senderAccount.address}`
      );
      return {
        success: false,
        error: "Derived address does not match stored address.",
      };
    }

    const amountInWei = web3.utils.toWei(amount.toString(), "ether");

    // Estimate Gas
    try {
      gasLimit = await web3.eth.estimateGas({
        from: senderAccount.address, // Use derived address for estimation
        to: toAddress,
        value: amountInWei,
      });
    } catch (gasError) {
      console.error("Native Coin Gas Estimation Error:", gasError);
      return {
        success: false,
        error: `Gas estimation failed: ${gasError.message}`,
      };
    }

    // Get Gas Price (consider EIP-1559 later)
    gasPrice = await web3.eth.getGasPrice();

    // Build Transaction
    const txObject = {
      from: senderAccount.address, // Use derived address
      to: toAddress,
      value: amountInWei,
      gas: gasLimit,
      gasPrice: gasPrice,
    };

    // Sign and Send
    const signedTx = await web3.eth.accounts.signTransaction(
      txObject,
      secretKey
    );
    const receipt = await web3.eth.sendSignedTransaction(
      signedTx.rawTransaction
    );

    console.log("Native Coin Send Successful:", receipt.transactionHash);
    return { success: true, transactionHash: receipt.transactionHash };
  } catch (error) {
    console.error("Native Coin Send Error:", error);
    return { success: false, error: error.message || "Transaction failed" };
  }
};

// --- NEW: ERC20 Token Send Function (USDT, USDC) ---
const sendErc20Token = async (
  rpcUrl,
  senderPrivateKey,
  tokenContractAddress,
  recipientAddress,
  amount
) => {
  const web3 = new Web3(rpcUrl);
  try {
    // 1. Load Sender Wallet & Validate Address
    const senderAccount =
      web3.eth.accounts.privateKeyToAccount(senderPrivateKey);
    const senderAddress = senderAccount.address;

    // 2. Create Contract Instance
    const tokenContract = new web3.eth.Contract(erc20Abi, tokenContractAddress);

    // 3. Get Token Decimals
    let decimals;
    try {
      decimals = await tokenContract.methods.decimals().call();
    } catch (decimalError) {
      console.error(
        `Error fetching decimals for token ${tokenContractAddress}:`,
        decimalError
      );
      return { success: false, error: "Could not fetch token decimals." };
    }

    // 4. Calculate Amount in Base Units
    const amountString = amount.toString();
    // Use ethers for robust parsing and BN for safety
    // const amountInBaseUnits = web3.utils.toBN(
    //   ethers.utils.parseUnits(amountString, decimals)
    // );

    // 4. Calculate Amount in Base Units (Handle Decimals)
    // ...
    const amountBigNumberEthers = ethers.utils.parseUnits(
      amountString,
      decimals
    );
    // Convert the ethers BigNumber string representation to native BigInt
    const amountInBaseUnits = BigInt(amountBigNumberEthers.toString()); // <<< CORRECTED LINE

    // 5. Encode 'transfer' Function Call
    const transferData = tokenContract.methods
      .transfer(recipientAddress, amountInBaseUnits)
      .encodeABI();

    // 6. Estimate Gas Limit
    let gasLimit;
    try {
      gasLimit = await tokenContract.methods
        .transfer(recipientAddress, amountInBaseUnits)
        .estimateGas({ from: senderAddress });
      // Add buffer (optional but recommended)
      gasLimit = Math.ceil(gasLimit * 1.2);
    } catch (gasError) {
      console.error("ERC20 Gas estimation failed:", gasError);
      return {
        success: false,
        error: `Gas estimation failed: ${gasError.message}`,
      };
    }

    // 7. Get Gas Price
    const gasPrice = await web3.eth.getGasPrice();

    // 8. Construct Transaction Object
    const txObject = {
      from: senderAddress,
      to: tokenContractAddress, // To the token contract
      value: "0", // Value is 0 for token transfers
      gas: gasLimit,
      gasPrice: gasPrice,
      data: transferData, // Encoded function call
    };

    // 9. Sign Transaction
    const signedTx = await web3.eth.accounts.signTransaction(
      txObject,
      senderPrivateKey
    );

    // 10. Send Signed Transaction
    const receipt = await web3.eth.sendSignedTransaction(
      signedTx.rawTransaction
    );

    console.log("ERC20 Token Send Successful:", receipt.transactionHash);
    return { success: true, transactionHash: receipt.transactionHash };
  } catch (error) {
    console.error("ERC20 Send Error:", error);
    return {
      success: false,
      error: error.message || "An unknown error occurred during sending.",
    };
  }
};

// --- Solana Send Function ---
// Helper to convert hex private key to Uint8Array for Solana
function hexToUint8Array(hex) {
  if (hex.startsWith("0x")) hex = hex.slice(2); // Remove 0x prefix if present
  if (hex.length % 2 !== 0) throw new Error("Invalid hex string length");
  const len = hex.length / 2;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  // Solana Keypair expects a 64-byte secret key (private + public)
  // If hexToUint8Array only returns 32 bytes (just private), need to derive full keypair
  // For now, assuming decryptPrivateKey returns the 64-byte secret
  if (bytes.length !== 64) {
    console.warn(
      `Expected 64 bytes for SOL secret key, got ${bytes.length}. Assuming it's just the private key part.`
    );
    // If it's just 32-byte private, Keypair.fromSeed might be needed,
    // but Keypair.fromSecretKey is more common if the full key is stored/derived.
    // Let's try fromSecretKey, it might handle 32 bytes internally for some formats.
  }
  return bytes;
}

const sendSOL = async (toAddress, amount, secretKeyHex) => {
  // Renamed param
  const connection = new Connection("https://api.mainnet-beta.solana.com");
  try {
    const secretKeyBytes = hexToUint8Array(secretKeyHex); // Convert hex
    const wallet = Keypair.fromSecretKey(secretKeyBytes); // Use converted bytes

    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: new PublicKey(toAddress),
        lamports: Math.floor(amount * LAMPORTS_PER_SOL), // Use constant and floor
      })
    );

    // Set recent blockhash - REQUIRED
    transaction.recentBlockhash = (
      await connection.getLatestBlockhash()
    ).blockhash;
    transaction.feePayer = wallet.publicKey; // Explicitly set fee payer

    // Sign and send (sendTransaction handles signing if signer is provided)
    const signature = await connection.sendTransaction(transaction, [wallet], {
      skipPreflight: false,
    }); // Don't skip preflight initially

    console.log("SOL Transaction Sent. Signature:", signature);
    console.log(
      `Explorer URL: https://explorer.solana.com/tx/${signature}?cluster=mainnet-beta`
    );

    // Confirm Transaction
    const confirmation = await connection.confirmTransaction(
      {
        signature: signature,
        lastValidBlockHeight: (
          await connection.getLatestBlockhash()
        ).lastValidBlockHeight,
      },
      "confirmed"
    ); // Use 'confirmed' or 'finalized'

    if (confirmation.value.err) {
      throw new Error(
        `SOL Transaction Confirmation Failed: ${confirmation.value.err}`
      );
    }

    console.log("SOL Transaction Confirmed.");
    return { success: true, transactionSignature: signature };
  } catch (error) {
    console.error("SOL Send Error:", error);
    // Provide more specific error if possible
    let errorMessage = error.message || "Transaction failed";
    if (error.logs) {
      // Include logs if available
      errorMessage += ` Logs: ${error.logs.join("\n")}`;
    }
    return { success: false, error: errorMessage };
  }
};

const sendBTC = async (fromAddress, toAddress, amount, secretKey) => {
  try {
    // const keyPair = bitcoin.ECPair.fromWIF(secretKey, network);
    const keyPair = ECPair.fromWIF(secretKey, network);
    console.log("KeyPair:", keyPair);
    // 1. Get unspent outputs (UTXOs) for the sender's wallet using Blockcypher API
    const utxosResponse = await axios.get(
      `https://api.blockcypher.com/v1/btc/main/addrs/${fromAddress}?unspentOnly=true`,
      {
        headers: {
          Authorization: `Bearer ${BLOCKCYPHER_TOKEN}`,
        },
      }
    );
    const utxos = utxosResponse.data.txrefs;

    if (!utxos || utxos.length === 0) {
      throw new Error("No unspent outputs found for the sender address");
    }

    // 2. Create the transaction inputs (using the UTXOs)
    const inputs = utxos.map((utxo) => ({
      txid: utxo.tx_hash,
      vout: utxo.tx_output_n,
      scriptPubKey: utxo.script,
      amount: utxo.value,
    }));

    // 3. Calculate the total value of inputs
    const inputTotal = inputs.reduce((sum, input) => sum + input.amount, 0);

    // 4. Deduct the transaction fee (e.g., 0.0001 BTC) from the input total
    const fee = 10000; // You can calculate this dynamically based on transaction size
    const sendAmount = amount * 1e8; // Convert BTC to satoshis (1 BTC = 100,000,000 satoshis)

    if (inputTotal - fee < sendAmount) {
      throw new Error("Insufficient funds after deducting fee");
    }

    // 5. Create the transaction outputs (sending to the receiver)
    const outputs = [
      {
        address: toAddress,
        value: sendAmount, // Value to send (in satoshis)
      },
      {
        address: fromAddress, // Change back to the sender
        value: inputTotal - sendAmount - fee, // Amount sent back to the sender as change
      },
    ];

    // 6. Create the transaction using bitcoinjs-lib
    const txb = new bitcoin.TransactionBuilder(network);
    inputs.forEach((input) => {
      txb.addInput(input.txid, input.vout);
    });

    outputs.forEach((output) => {
      txb.addOutput(output.address, output.value);
    });

    // 7. Sign the transaction with the sender's private key
    inputs.forEach((input, index) => {
      txb.sign(index, keyPair);
    });

    // 8. Build the raw transaction (hex format)
    const txHex = txb.build().toHex();

    // 9. Broadcast the transaction to Blockcypher

    const broadcastResponse = await axios.post(
      "https://api.blockcypher.com/v1/btc/main/txs/push",
      { tx: txHex, token: BLOCKCYPHER_TOKEN }
    );

    // 10. Return the transaction result
    if (broadcastResponse.data.tx.hash) {
      return {
        success: true,
        transactionHash: broadcastResponse.data.tx.hash,
      };
    } else {
      throw new Error("Failed to broadcast transaction");
    }
  } catch (error) {
    console.error("BTC Send Error:", error);
    return { success: false };
  }
};

// Make sure hexToUint8Array is defined if needed for SOL, or adjust SOL key handling
// function hexToUint8Array(hex) { ... } defined previously
