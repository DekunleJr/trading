// --- START OF FILE controller/send.js ---

const { Web3 } = require("web3");
const TronWeb = require("tronweb");
require("dotenv").config();
const { ethers } = require("ethers");
const {
  decryptPrivateKey,
  deriveEVMPrivateKeyFromMnemonic,
} = require("../utils/encryption");
const User = require("../model/user");

// --- Environment Variables ---
const INFURA_API = process.env.INFURA_API;
const USDT_CONTRACT_ADDRESS_ERC20 = process.env.USDT_CONTRACT_ADDRESS;
const USDC_CONTRACT_ADDRESS_ERC20 = process.env.USDC_CONTRACT_ADDRESS;
const USDT_CONTRACT_ADDRESS_TRC20 = process.env.TRON_USDT_CONTRACT_ADDRESS;

// --- Setup TronWeb ---
const tronWeb = new TronWeb(
  "https://api.trongrid.io",
  "https://api.trongrid.io",
  "https://api.trongrid.io"
);

// --- Minimal ABIs ---
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
// No specific ABI needed for native TRX send helper

// --- Fee Estimation Helper (Ethereum EIP-1559) ---
/**
 * Estimates the network fee for an Ethereum transaction (Native ETH or ERC20).
 * Uses EIP-1559 logic.
 */
const estimateEthFee = async (
  rpcUrl,
  fromAddress,
  toAddress,
  amount = 0,
  tokenContractAddress = null,
  tokenAmount = null,
  erc20Abi = []
) => {
  try {
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    const feeData = await provider.getFeeData();
    const maxFeePerGas = feeData.maxFeePerGas;
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;

    if (!maxFeePerGas || !maxPriorityFeePerGas) {
      throw new Error("Could not retrieve EIP-1559 fee data.");
      // Consider adding fallback to legacy gasPrice if needed, but EIP-1559 is preferred
    }

    let gasLimit;
    let txRequest;

    if (tokenContractAddress && tokenAmount) {
      // ERC20 Estimation
      const tokenContract = new ethers.Contract(
        tokenContractAddress,
        erc20Abi,
        provider
      );
      txRequest = await tokenContract.populateTransaction.transfer(
        toAddress,
        tokenAmount,
        { from: fromAddress }
      );
      gasLimit = await provider.estimateGas(txRequest);
    } else {
      // Native ETH Estimation
      const amountWei = ethers.utils.parseEther(amount.toString());
      txRequest = { from: fromAddress, to: toAddress, value: amountWei };
      gasLimit = await provider.estimateGas(txRequest);
    }

    // Add a buffer to gasLimit (e.g., 20%) for safety
    gasLimit = gasLimit.mul(120).div(100);

    const estimatedFeeWei = gasLimit.mul(maxFeePerGas); // Use maxFeePerGas for worst-case cost estimate
    const estimatedFeeEth = parseFloat(
      ethers.utils.formatEther(estimatedFeeWei)
    );

    console.log(
      `Estimated Fee: GasLimit=${gasLimit.toString()}, MaxFeePerGas=${ethers.utils.formatUnits(
        maxFeePerGas,
        "gwei"
      )} Gwei, Estimated Fee=${estimatedFeeEth.toFixed(8)} ETH`
    );

    return { estimatedFeeEth, gasLimit, maxFeePerGas, maxPriorityFeePerGas };
  } catch (error) {
    console.error("ETH Fee Estimation Error:", error.message || error);
    if (error.code === ethers.errors.UNPREDICTABLE_GAS_LIMIT) {
      console.error(
        "Gas estimation failed. Potential reasons: insufficient native balance for gas, invalid recipient, contract logic error."
      );
    }
    return null;
  }
};

// --- Controller function to send crypto ---
exports.sendCrypto = async (req, res) => {
  const { toAddress, amount: amountString, currency } = req.body;
  const currencyUpper = currency?.toUpperCase();

  if (!currencyUpper || !amountString || !toAddress) {
    req.flash("error", "Missing required fields (currency, amount, address).");
    return res.status(400).redirect("/trade");
  }

  try {
    const user = await User.findById(req.session.user._id);
    // Ensure all necessary fields are present
    if (
      !user ||
      !user.balances ||
      !user.cryptoWallet ||
      !user.privateKeys ||
      !user.mnemonic
    ) {
      req.flash("error", "User data incomplete or not found.");
      return res.status(400).redirect("/trade");
    }

    // --- Input Validation ---
    const amount = parseFloat(amountString);
    if (isNaN(amount) || amount <= 0) {
      req.flash("error", "Invalid amount entered.");
      return res.status(400).redirect("/trade");
    }
    // Address validation (simplified, add more checks if needed)
    let isValidAddress = false;
    let nativeCurrencyNeeded = null; // 'ETH' or 'TRX'
    switch (currencyUpper) {
      case "ETH":
      case "USDT_ERC20":
      case "USDC_ERC20":
        isValidAddress = ethers.utils.isAddress(toAddress);
        nativeCurrencyNeeded = "ETH";
        break;
      case "TRX":
      case "USDT_TRC20":
        isValidAddress = tronWeb.isAddress(toAddress);
        nativeCurrencyNeeded = "TRX";
        break;
      default:
        req.flash(
          "error",
          `Unsupported currency for sending: ${currencyUpper}`
        );
        return res.status(400).redirect("/trade");
    }
    if (!isValidAddress) {
      req.flash(
        "error",
        `Invalid recipient address format for ${currencyUpper}.`
      );
      return res.status(400).redirect("/trade");
    }

    // --- Balance Check (Token/Coin to be Sent) ---
    const currentTokenBalance = user.balances[currencyUpper] || 0;
    if (amount > currentTokenBalance) {
      req.flash(
        "error",
        `Insufficient ${currencyUpper} balance. You have ${currentTokenBalance.toFixed(
          6
        )}, tried to send ${amount}.`
      );
      return res.status(400).redirect("/trade");
    }

    // --- Network Fee Estimation & NATIVE Balance Check ---
    let feeCheckPassed = false;
    let estimatedFeeDetails = null; // Store details like gasLimit etc. if needed by send helpers
    const currentNativeBalance = user.balances[nativeCurrencyNeeded] || 0;

    if (nativeCurrencyNeeded === "ETH") {
      let tokenContractAddress = null;
      let tokenAmountBaseUnits = null;
      let amountEth = currencyUpper === "ETH" ? amount : 0;

      if (currencyUpper === "USDT_ERC20" || currencyUpper === "USDC_ERC20") {
        tokenContractAddress =
          currencyUpper === "USDC_ERC20"
            ? USDC_CONTRACT_ADDRESS_ERC20
            : USDT_CONTRACT_ADDRESS_ERC20;
        if (!tokenContractAddress) {
          /* ... error ... */ return res.redirect("/trade");
        }
        const decimals = 6; // Assume 6 for USDT/USDC
        try {
          tokenAmountBaseUnits = ethers.utils
            .parseUnits(amount.toString(), decimals)
            .toString();
        } catch (parseError) {
          req.flash("error", `Invalid amount format for ${currencyUpper}.`);
          return res.status(400).redirect("/trade");
        }
      }

      console.log(`Estimating ETH fee for ${currencyUpper} send...`);
      estimatedFeeDetails = await estimateEthFee(
        INFURA_API,
        user.cryptoWallet.ETH,
        currencyUpper === "ETH" ? toAddress : tokenContractAddress, // Recipient or Contract
        amountEth,
        tokenContractAddress,
        tokenAmountBaseUnits,
        erc20Abi
      );

      if (!estimatedFeeDetails) {
        req.flash(
          "error",
          "Could not estimate network fee. Transaction cancelled. Check if you have *any* ETH balance."
        );
        return res.redirect("/trade");
      }

      console.log(`Estimated ETH fee: ${estimatedFeeDetails.estimatedFeeEth}`);
      if (currentNativeBalance < estimatedFeeDetails.estimatedFeeEth) {
        req.flash(
          "error",
          `Insufficient ETH balance for network fee. Required: ~${estimatedFeeDetails.estimatedFeeEth.toFixed(
            6
          )} ETH, You have: ${currentNativeBalance.toFixed(6)}`
        );
        return res.redirect("/trade");
      }
      feeCheckPassed = true;
    } else if (nativeCurrencyNeeded === "TRX") {
      // --- Basic TRX Fee Threshold Check ---
      let minTrxRequired;
      if (currencyUpper === "TRX") {
        minTrxRequired = 1; // Base requirement for native send fee buffer
        // Check if balance covers amount + buffer
        if (currentNativeBalance < amount + minTrxRequired) {
          req.flash(
            "error",
            `Insufficient TRX balance. Required: ${amount} + ~${minTrxRequired} TRX for fee, You have: ${currentNativeBalance.toFixed(
              4
            )}`
          );
          return res.redirect("/trade");
        }
      } else {
        // USDT_TRC20
        minTrxRequired = 15; // Higher threshold for token transfers (Energy cost)
        if (currentNativeBalance < minTrxRequired) {
          req.flash(
            "error",
            `Insufficient TRX balance for network fee. Required: >${minTrxRequired} TRX, You have: ${currentNativeBalance.toFixed(
              4
            )}`
          );
          return res.redirect("/trade");
        }
      }
      console.log(
        `TRX balance check: Have ${currentNativeBalance} TRX, Minimum Required > ${minTrxRequired} TRX (approx). Check passed.`
      );
      console.warn(
        "Using basic TRX balance threshold for fee check. Actual fee may vary."
      );
      feeCheckPassed = true;
      // estimatedFeeDetails remains null for TRX in this basic check
    }

    // Final check ensure fee logic ran
    if (!feeCheckPassed) {
      console.error(`Fee check logic did not complete for ${currencyUpper}`);
      req.flash("error", "Internal error: Fee check could not be performed.");
      return res.redirect("/trade");
    }

    // --- Get Wallet Keys ---
    let privateKey;
    const ethAddress = user.cryptoWallet.ETH; // Always needed for ETH/ERC20 key derivation
    const tronAddress = user.cryptoWallet.TRX; // Always needed for TRX/TRC20 key + address context

    try {
      if (nativeCurrencyNeeded === "ETH") {
        privateKey = deriveEVMPrivateKeyFromMnemonic(user.mnemonic);
        if (!privateKey) throw new Error("Failed to derive ETH key.");
        // Address verification (optional but good)
        const derivedWallet = new ethers.Wallet(privateKey);
        if (derivedWallet.address.toLowerCase() !== ethAddress.toLowerCase()) {
          throw new Error("Derived ETH address mismatch.");
        }
      } else {
        // TRX
        privateKey = decryptPrivateKey(user.privateKeys.tron);
        if (!privateKey) throw new Error("Failed to decrypt Tron key.");
        // Address verification
        const derivedTronAddress = tronWeb.address.fromPrivateKey(privateKey);
        if (derivedTronAddress !== tronAddress) {
          throw new Error("Decrypted Tron key mismatch.");
        }
      }
    } catch (keyError) {
      console.error("Key retrieval/verification error:", keyError);
      req.flash("error", `Wallet access error: ${keyError.message}`);
      return res.redirect("/trade");
    }

    // --- Dispatch Transaction ---
    let transactionStatus = {
      success: false,
      error: "Transaction not initiated.",
    };
    console.log(
      `Attempting to send ${amount} ${currencyUpper} from ${
        nativeCurrencyNeeded === "ETH" ? ethAddress : tronAddress
      } to ${toAddress}`
    );

    switch (currencyUpper) {
      case "ETH":
        transactionStatus = await sendNativeEth(
          INFURA_API,
          ethAddress,
          toAddress,
          amount,
          privateKey,
          estimatedFeeDetails
        );
        break;
      case "USDC_ERC20":
      case "USDT_ERC20":
        const tokenContract =
          currencyUpper === "USDC_ERC20"
            ? USDC_CONTRACT_ADDRESS_ERC20
            : USDT_CONTRACT_ADDRESS_ERC20;
        transactionStatus = await sendErc20Token(
          INFURA_API,
          privateKey,
          tokenContract,
          toAddress,
          amount,
          estimatedFeeDetails
        );
        break;
      case "TRX":
        transactionStatus = await sendNativeTrx(
          privateKey,
          toAddress,
          amount,
          tronAddress
        );
        break;
      case "USDT_TRC20":
        transactionStatus = await sendTrc20Token(
          privateKey,
          USDT_CONTRACT_ADDRESS_TRC20,
          toAddress,
          amount,
          tronAddress
        );
        break;
      default: // Should not be reached
        req.flash(
          "error",
          `Internal Error: No send logic for ${currencyUpper}`
        );
        return res.redirect("/trade");
    }

    // --- Handle Transaction Result ---
    if (transactionStatus.success) {
      // Deduct the SENT amount from the correct balance
      user.balances[currencyUpper] =
        (user.balances[currencyUpper] || 0) - amount;
      if (user.balances[currencyUpper] < 0) user.balances[currencyUpper] = 0;

      // Rely on next balance refresh (getTrade) to show updated NATIVE balance after fee deduction by the network.
      // Avoid double-deducting the fee here unless estimation is perfect and confirmed.

      await user.save();
      req.flash(
        "success",
        `Transaction initiated successfully. Tx Hash: ${transactionStatus.transactionHash}`
      );
      console.log(
        `Send Success: ${amount} ${currencyUpper} to ${toAddress}. Tx: ${transactionStatus.transactionHash}`
      );
    } else {
      req.flash(
        "error",
        `Transaction failed: ${transactionStatus.error || "Unknown error"}`
      );
      console.error(
        `Send Failure: ${currencyUpper} to ${toAddress}. Error: ${transactionStatus.error}`
      );
    }
    return res.redirect("/trade");
  } catch (error) {
    console.error("Critical Send Crypto Error in Controller:", error);
    req.flash("error", `An unexpected server error occurred: ${error.message}`);
    return res.redirect("/trade");
  }
};

// --- Helper Function: Send Native ETH ---
const sendNativeEth = async (
  rpcUrl,
  fromAddress,
  toAddress,
  amount,
  privateKey,
  feeInfo
) => {
  const web3 = new Web3(rpcUrl);
  try {
    const amountWei = web3.utils.toWei(amount.toString(), "ether");
    const txObject = {
      from: fromAddress,
      to: toAddress,
      value: amountWei,
      gas: feeInfo.gasLimit.toString(), // Use estimated gasLimit
      maxFeePerGas: feeInfo.maxFeePerGas.toString(), // Use EIP-1559 field
      maxPriorityFeePerGas: feeInfo.maxPriorityFeePerGas.toString(), // Use EIP-1559 field
      // chainId: await web3.eth.getChainId() // Important for some networks/wallets
    };
    // Get nonce
    txObject.nonce = await web3.eth.getTransactionCount(fromAddress, "latest");

    const signedTx = await web3.eth.accounts.signTransaction(
      txObject,
      privateKey
    );
    const receipt = await web3.eth.sendSignedTransaction(
      signedTx.rawTransaction
    );
    console.log("Native ETH Send Successful, Hash:", receipt.transactionHash);
    return { success: true, transactionHash: receipt.transactionHash };
  } catch (error) {
    console.error("sendNativeEth Error:", error);
    return {
      success: false,
      error: error.message || "Native ETH transaction failed",
    };
  }
};

// --- Helper Function: Send ERC20 Token ---
const sendErc20Token = async (
  rpcUrl,
  senderPrivateKey,
  tokenContractAddress,
  recipientAddress,
  amount,
  feeInfo
) => {
  const web3 = new Web3(rpcUrl);
  try {
    const senderAccount =
      web3.eth.accounts.privateKeyToAccount(senderPrivateKey);
    const senderAddress = senderAccount.address;
    const tokenContract = new web3.eth.Contract(erc20Abi, tokenContractAddress);

    let decimals = 6; // Assume 6 for USDT/USDC, fetch if needed or pass from estimate call
    try {
      decimals = await tokenContract.methods
        .decimals()
        .call()
        .then((d) => parseInt(d));
    } catch {
      /* ignore */
    }
    if (isNaN(decimals)) decimals = 6;

    const amountInBaseUnits = ethers.utils.parseUnits(
      amount.toString(),
      decimals
    );
    const transferData = tokenContract.methods
      .transfer(recipientAddress, amountInBaseUnits.toString())
      .encodeABI();

    const txObject = {
      from: senderAddress,
      to: tokenContractAddress,
      value: "0",
      gas: feeInfo.gasLimit.toString(),
      maxFeePerGas: feeInfo.maxFeePerGas.toString(),
      maxPriorityFeePerGas: feeInfo.maxPriorityFeePerGas.toString(),
      data: transferData,
      // chainId: await web3.eth.getChainId()
    };
    txObject.nonce = await web3.eth.getTransactionCount(
      senderAddress,
      "latest"
    );

    const signedTx = await web3.eth.accounts.signTransaction(
      txObject,
      senderPrivateKey
    );
    const receipt = await web3.eth.sendSignedTransaction(
      signedTx.rawTransaction
    );
    console.log("ERC20 Token Send Successful, Hash:", receipt.transactionHash);
    return { success: true, transactionHash: receipt.transactionHash };
  } catch (error) {
    console.error("sendErc20Token Error:", error);
    let errorMessage = error.message || "ERC20 transaction failed";
    // Add specific revert reason parsing if possible
    return { success: false, error: errorMessage };
  }
};

// --- Helper Function: Send Native TRX ---
const sendNativeTrx = async (
  senderPrivateKey,
  recipientAddress,
  amount,
  senderAddress
) => {
  tronWeb.setPrivateKey(senderPrivateKey);
  tronWeb.setAddress(senderAddress);
  try {
    const amountInSun = tronWeb.toSun(amount);
    console.log(
      `Sending ${amount} TRX (${amountInSun} SUN) from ${senderAddress} to ${recipientAddress}`
    );
    const transaction = await tronWeb.transactionBuilder.sendTrx(
      recipientAddress,
      amountInSun,
      senderAddress
    );
    // Assuming transactionBuilder.sendTrx creates AND signs AND broadcasts when PK is set
    if (!transaction || !transaction.txID) {
      // Fallback signing/sending if needed (check TronWeb version docs)
      // const signedTx = await tronWeb.trx.sign(transaction, senderPrivateKey);
      // const result = await tronWeb.trx.sendRawTransaction(signedTx);
      // if(!result || !result.txid) throw new Error("Broadcast failed or missing txid");
      // transaction.txID = result.txid;
      // -- OR --
      throw new Error("sendTrx did not return a transaction ID directly.");
    }
    console.log("Native TRX Send Successful, TxID:", transaction.txID);
    return { success: true, transactionHash: transaction.txID };
  } catch (error) {
    console.error("sendNativeTrx Error:", error);
    let msg = error.message || "Native TRX transaction failed.";
    if (
      typeof error === "string" &&
      error.includes("balance is not sufficient")
    )
      msg = "Insufficient TRX balance for amount + fee.";
    return { success: false, error: msg };
  } finally {
    tronWeb.setPrivateKey("");
    tronWeb.setAddress("");
  }
};

// --- Helper Function: Send TRC20 Token ---
const sendTrc20Token = async (
  senderPrivateKey,
  tokenContractAddress,
  recipientAddress,
  amount,
  senderAddress
) => {
  tronWeb.setPrivateKey(senderPrivateKey);
  tronWeb.setAddress(senderAddress);
  try {
    const contract = await tronWeb.contract().at(tokenContractAddress);
    let decimals = 6; // Assume 6 for USDT TRC20
    try {
      decimals = await contract
        .decimals()
        .call()
        .then((d) => parseInt(d));
    } catch {
      /* ignore */
    }
    if (isNaN(decimals)) decimals = 6;

    const amountInSun = ethers.utils
      .parseUnits(amount.toString(), decimals)
      .toString(); // Use ethers for parsing consistency

    console.log(
      `Sending ${amount} TRC20 (${amountInSun} base units) from ${senderAddress} to ${recipientAddress}`
    );

    // Use triggerSmartContract which handles signing when PK is set
    const tx = await tronWeb.transactionBuilder.triggerSmartContract(
      tokenContractAddress,
      "transfer(address,uint256)",
      {
        // Set a reasonable fee limit (e.g., 100 TRX = 100,000,000 SUN)
        // This MUST be covered by the sender's TRX balance.
        feeLimit: 100_000_000,
        callValue: 0, // Not sending TRX itself
      },
      [
        { type: "address", value: recipientAddress },
        { type: "uint256", value: amountInSun },
      ],
      senderAddress // Specify sender address
    );

    if (!tx || !tx.result || !tx.result.result) {
      throw new Error("Transaction preparation failed (triggerSmartContract).");
    }
    if (!tx.transaction || !tx.transaction.txID) {
      throw new Error(
        "Transaction broadcasting failed or did not return txID."
      );
    }

    // Assuming triggerSmartContract also signs and broadcasts when PK is set
    console.log("TRC20 Token Send Successful, TxID:", tx.transaction.txID);
    return { success: true, transactionHash: tx.transaction.txID };
  } catch (error) {
    console.error("sendTrc20Token Error:", error);
    let msg = error.message || "TRC20 transaction failed.";
    // Check common Tron contract errors
    if (typeof error === "string") {
      if (error.includes("REVERT opcode executed"))
        msg =
          "Transaction reverted (Insufficient token balance or other contract issue).";
      else if (error.includes("balance is not sufficient"))
        msg = "Insufficient TRX balance for network fee.";
    } else if (
      error.error === "CONTRACT_VALIDATE_ERROR" &&
      error.message?.includes("balance is not sufficient")
    ) {
      msg = "Insufficient TRC20 token balance.";
    }
    return { success: false, error: msg };
  } finally {
    tronWeb.setPrivateKey("");
    tronWeb.setAddress("");
  }
};

// --- END OF FILE controller/send.js ---
