const User = require("../model/user");
require("dotenv").config();
const { ethers } = require("ethers");
const { Connection, PublicKey } = require("@solana/web3.js");
const bitcoin = require("bitcoinjs-lib");
const { ECPairFactory } = require("ecpair");
const ecc = require("tiny-secp256k1");
const axios = require("axios");
const {
  deriveEVMPrivateKey,
  decryptPrivateKey,
} = require("../utils/encryption");
const {
  sendEVMTransaction,
  sendBitcoinTransaction,
  estimateEVMGas,
} = require("../utils/evm");
const { JsonRpcProvider, Wallet, Contract } = require("ethers");
const UniswapRouterABI =
  require("@uniswap/v2-periphery/build/UniswapV2Router02.json").abi;
const swapOnEVM = async (
  walletAddress,
  privateKey,
  fromCrypto,
  toCrypto,
  amount
) => {
  try {
    const provider = new JsonRpcProvider(process.env.EVM_RPC_URL);
    const wallet = new Wallet(privateKey, provider);
    const uniswapRouter = new Contract(
      process.env.UNISWAP_ROUTER,
      UniswapRouterABI,
      wallet
    );

    const tokenIn = process.env[fromCrypto + "_ADDRESS"];
    const tokenOut = process.env[toCrypto + "_ADDRESS"];
    const amountIn = ethers.utils.parseUnits(amount.toString(), 18);

    await uniswapRouter.swapExactTokensForTokens(
      amountIn,
      0,
      [tokenIn, tokenOut],
      wallet.address,
      Math.floor(Date.now() / 1000) + 60 * 10
    );

    return "EVM Swap Successful";
  } catch (err) {
    console.error("EVM Swap Error:", err);
    return null;
  }
};

const swapOnSolana = async (walletAddress, privateKey, toCrypto, amount) => {
  try {
    const connection = new solanaWeb3.Connection(
      solanaWeb3.clusterApiUrl("mainnet-beta")
    );
    const fromKeypair = solanaWeb3.Keypair.fromSecretKey(
      Buffer.from(privateKey, "hex")
    );

    const swapTransaction = await axios.post(
      "https://quote-api.jup.ag/v4/swap",
      {
        inputMint: process.env[fromCrypto + "_MINT"],
        outputMint: process.env[toCrypto + "_MINT"],
        amount,
        slippageBps: 50,
        userPublicKey: walletAddress,
      }
    );

    const transaction = solanaWeb3.Transaction.from(
      Buffer.from(swapTransaction.data.transaction, "base64")
    );
    transaction.sign(fromKeypair);
    const txid = await connection.sendRawTransaction(transaction.serialize());

    return txid;
  } catch (err) {
    console.error("Solana Swap Error:", err);
    return null;
  }
};

const swapOnBitcoin = async (walletAddress, privateKey, toCrypto, amount) => {
  try {
    const ECPair = ECPairFactory(ecc);
    const keyPair = ECPair.fromWIF(privateKey);
    const psbt = new bitcoin.Psbt();

    const utxos = await getBitcoinUTXOs(walletAddress);
    const fee = 0.0001;
    const outputAmount = amount - fee;

    psbt.addInput({
      hash: utxos[0].txid,
      index: utxos[0].vout,
    });

    psbt.addOutput({
      address: process.env[toCrypto + "_ADDRESS"],
      value: outputAmount * 1e8,
    });

    psbt.signInput(0, keyPair);
    psbt.finalizeAllInputs();

    const txHex = psbt.extractTransaction().toHex();
    return await broadcastBitcoinTransaction(txHex);
  } catch (err) {
    console.error("Bitcoin Swap Error:", err);
    return null;
  }
};

const sendGasFeeEVM = async (fromWallet, toWallet, gasFee) => {
  try {
    const provider = new ethers.providers.JsonRpcProvider(
      process.env.INFURA_URL
    );
    const signer = new ethers.Wallet(fromWallet.privateKey, provider);

    const tx = await signer.sendTransaction({
      to: toWallet,
      value: ethers.utils.parseEther(gasFee.toString()),
    });

    return tx.hash;
  } catch (error) {
    console.error("EVM Gas Fee Error:", error);
    return null;
  }
};

const NETWORK = bitcoin.networks.bitcoin;

const sendGasFeeBTC = async (fromWallet, toWallet, gasFee) => {
  try {
    // 1. Get UTXOs (Unspent Transaction Outputs)
    const utxos = await axios.get(
      `https://blockstream.info/api/address/${fromWallet.address}/utxo`
    );

    if (!utxos.data.length) {
      throw new Error("No UTXOs available in the wallet.");
    }

    // 2. Prepare Transaction
    const psbt = new bitcoin.Psbt({ network: NETWORK });
    let totalInput = 0;

    for (const utxo of utxos.data) {
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        witnessUtxo: {
          script: Buffer.from(utxo.scriptpubkey, "hex"),
          value: utxo.value,
        },
      });
      totalInput += utxo.value;
      if (totalInput >= gasFee) break; // Stop when input covers the gas fee
    }

    if (totalInput < gasFee) {
      throw new Error("Insufficient balance for gas fee.");
    }

    // 3. Add Output (send gas fee to recipient)
    psbt.addOutput({
      address: toWallet, // Recipient
      value: gasFee, // Gas fee amount
    });

    // 4. Add Change (return leftover BTC to sender)
    const change = totalInput - gasFee - 500; // 500 sats estimated miner fee
    if (change > 0) {
      psbt.addOutput({
        address: fromWallet.address, // Sender's change address
        value: change,
      });
    }

    // 5. Sign Transaction
    psbt.signAllInputs(fromWallet.keyPair);
    psbt.finalizeAllInputs();

    // 6. Broadcast Transaction
    const rawTx = psbt.extractTransaction().toHex();
    const broadcastResponse = await axios.post(
      "https://blockstream.info/api/tx",
      rawTx
    );

    return broadcastResponse.data; // TX Hash
  } catch (error) {
    console.error("BTC Gas Fee Error:", error);
    return null;
  }
};
const sendGasFeeSOL = async (fromWallet, toWallet, gasFee) => {
  try {
    const connection = new solanaWeb3.Connection(
      solanaWeb3.clusterApiUrl("mainnet-beta")
    );
    const transaction = new solanaWeb3.Transaction().add(
      solanaWeb3.SystemProgram.transfer({
        fromPubkey: new solanaWeb3.PublicKey(fromWallet),
        toPubkey: new solanaWeb3.PublicKey(toWallet),
        lamports: solanaWeb3.LAMPORTS_PER_SOL * gasFee,
      })
    );

    return "fake-solana-tx-hash"; // Replace with actual Solana transaction logic
  } catch (error) {
    console.error("Solana Gas Fee Error:", error);
    return null;
  }
};

const GAS_FEE_WALLET = {
  ETH: "0x9f390E913e85261E32Cd0a64e38Fca5d53858caD",
  BNB: "0x9f390E913e85261E32Cd0a64e38Fca5d53858caD",
  SOL: "5Dckd69iYdCQRx47aRWvqjCykhXPnJBdQ5ezuNefgNhV",
  BTC: "bc1qfx397j2q4v39rsytz87m50rskqqpx7f4gcatx4",
  POLYGON: "0x9f390E913e85261E32Cd0a64e38Fca5d53858caD",
};

const estimateSolanaGas = async () => {
  try {
    // Solana transaction fees are low and mostly fixed (~0.000005 SOL)
    return 0.000005;
  } catch (error) {
    console.error("Solana Gas Fee Error:", error);
    return null;
  }
};

const estimateBitcoinGas = async () => {
  try {
    // Get Bitcoin gas fees from a public API
    const { data } = await axios.get(
      "https://mempool.space/api/v1/fees/recommended"
    );
    return data.fastestFee; // satoshis per byte
  } catch (error) {
    console.error("Bitcoin Gas Fee Error:", error);
    return null;
  }
};

const cryptoIds = {
  BTC: "bitcoin",
  ETH: "ethereum",
  BNB: "binancecoin",
  USDT: "tether",
  USDC: "usd-coin",
  SOL: "solana",
  MATIC: "matic-network",
  POLYGON: "matic-network",
};

const getCryptoPrice = async (fromCrypto, toCrypto) => {
  try {
    // Convert crypto symbols to CoinGecko IDs
    const fromId = cryptoIds[fromCrypto.toUpperCase()];
    const toId = cryptoIds[toCrypto.toUpperCase()];

    if (!fromId || !toId) {
      console.error("Invalid cryptocurrency symbol provided.");
      return null;
    }

    // Fetch data from CoinGecko
    const response = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${fromId},${toId}&vs_currencies=usd`
    );

    console.log("CoinGecko API Response:", response.data);

    // Ensure the response contains data
    if (!response.data[fromId] || !response.data[toId]) {
      console.error("Failed to retrieve conversion rate.");
      return null;
    }

    return response.data[toId].usd / response.data[fromId].usd;
  } catch (error) {
    console.error("Error fetching crypto price:", error);
    return null;
  }
};

exports.swapCrypto = async (req, res) => {
  try {
    const { fromCrypto, toCrypto, amount } = req.body;
    const user = await User.findById(req.session.user._id);

    if (!user) {
      req.flash("error", "User not found");
      return res.redirect("/trade");
    }

    // Validate user wallet
    if (!user.cryptoWallet[fromCrypto]) {
      req.flash("error", `No wallet found for ${fromCrypto}`);
      return res.redirect("/trade");
    }

    // Estimate conversion rate
    const conversionRate = await getCryptoPrice(
      fromCrypto.toLowerCase(),
      toCrypto.toLowerCase()
    );
    console.log(conversionRate);
    if (!conversionRate) {
      req.flash("error", "Failed to fetch conversion rate");
      return res.redirect("/trade");
    }

    // Calculate estimated amount after conversion
    const estimatedToAmount = amount * conversionRate;

    console.log(`estimatedToAmount: ${estimatedToAmount}`);

    // Determine private key based on blockchain
    let privateKey;
    if (fromCrypto === "BTC") {
      privateKey = decryptPrivateKey(user.privateKeys.btc);
    } else if (fromCrypto === "SOL") {
      privateKey = decryptPrivateKey(user.privateKeys.sol);
    } else if (["ETH", "BNB", "USDT", "USDC", "POLYGON"].includes(fromCrypto)) {
      privateKey = deriveEVMPrivateKey(user.mnemonic, fromCrypto);
    } else {
      req.flash("error", "Unsupported cryptocurrency");
      return res.redirect("/trade");
    }

    // Estimate Gas Fee
    let gasFee;
    if (["ETH", "BNB", "POLYGON"].includes(fromCrypto)) {
      gasFee = await estimateEVMGas(fromCrypto);
    } else if (fromCrypto === "SOL") {
      gasFee = await estimateSolanaGas();
    } else if (fromCrypto === "BTC") {
      gasFee = await estimateBitcoinGas();
    } else if (["USDT", "USDC"].includes(fromCrypto)) {
      gasFee = await estimateEVMGas(fromCrypto, true);
    } else {
      req.flash("error", "Unsupported cryptocurrency");
      return res.redirect("/trade");
    }

    if (!gasFee) {
      req.flash("error", "Failed to estimate gas fee");
      return res.redirect("/trade");
    }

    // Deduct gas fee from user's balance
    if (user.balances[fromCrypto] < amount + gasFee) {
      req.flash("error", "Insufficient balance including gas fee");
      return res.redirect("/trade");
    }

    // Transfer Gas Fee to Your Address First
    let gasTxHash;
    if (["ETH", "BNB", "POLYGON"].includes(fromCrypto)) {
      gasTxHash = await sendGasFeeEVM(
        user.cryptoWallet[fromCrypto],
        GAS_FEE_WALLET[fromCrypto],
        gasFee
      );
    } else if (fromCrypto === "BTC") {
      gasTxHash = await sendGasFeeBTC(
        user.cryptoWallet[fromCrypto],
        GAS_FEE_WALLET[fromCrypto],
        gasFee
      );
    } else if (fromCrypto === "SOL") {
      gasTxHash = await sendGasFeeSOL(
        user.cryptoWallet[fromCrypto],
        GAS_FEE_WALLET[fromCrypto],
        gasFee
      );
    }

    if (!gasTxHash) {
      req.flash("error", "Gas fee transfer failed");
      return res.redirect("/trade");
    }

    // Proceed with Swap After Gas Fee Deduction
    let swapTxHash;
    if (["ETH", "BNB", "USDT", "USDC", "POLYGON"].includes(fromCrypto)) {
      swapTxHash = await swapOnEVM(
        user.cryptoWallet[fromCrypto],
        privateKey,
        fromCrypto,
        toCrypto,
        amount
      );
    } else if (fromCrypto === "BTC") {
      swapTxHash = await swapOnBitcoin(
        user.cryptoWallet[fromCrypto],
        privateKey,
        toCrypto,
        amount
      );
    } else if (fromCrypto === "SOL") {
      swapTxHash = await swapOnSolana(
        user.cryptoWallet[fromCrypto],
        privateKey,
        toCrypto,
        amount
      );
    }

    if (!swapTxHash) {
      req.flash("error", "Swap transaction failed");
      return res.redirect("/trade");
    }

    req.flash(
      "error",
      `Swapped ${amount} ${fromCrypto} to ${toCrypto}. Tx: ${swapTxHash}`
    );
    res.redirect("/trade");
  } catch (error) {
    console.error("Swap Error:", error);
    req.flash("error", "Swap failed due to an error");
    res.redirect("/trade");
  }
};

exports.sendCrypto = async (req, res) => {
  try {
    const { cryptoType, walletAddress, amount } = req.body;
    const user = await User.findById(req.session.user._id);

    if (!user) {
      req.flash("error", "User not found");
      return res.redirect("/trade");
    }

    // Validate user wallet
    if (!user.cryptoWallet[cryptoType]) {
      req.flash("error", `No wallet found for ${cryptoType}`);
      return res.redirect("/trade");
    }

    // Determine private key based on blockchain
    let privateKey;
    if (cryptoType === "BTC") {
      privateKey = decryptPrivateKey(user.privateKeys.btc);
    } else if (cryptoType === "SOL") {
      privateKey = decryptPrivateKey(user.privateKeys.sol);
    } else if (["ETH", "BNB", "USDT", "USDC", "MATIC"].includes(cryptoType)) {
      privateKey = deriveEVMPrivateKey(user.mnemonic, cryptoType);
    } else {
      req.flash("error", "Unsupported cryptocurrency");
      return res.redirect("/trade");
    }

    // Estimate Gas Fee
    let gasFee;
    if (["ETH", "BNB", "MATIC"].includes(cryptoType)) {
      gasFee = await estimateEVMGas(cryptoType);
    } else if (cryptoType === "SOL") {
      gasFee = await estimateSolanaGas();
    } else if (cryptoType === "BTC") {
      gasFee = await estimateBitcoinGas();
    } else if (["USDT", "USDC"].includes(cryptoType)) {
      gasFee = await estimateEVMGas(cryptoType, true);
    } else {
      req.flash("error", "Unsupported cryptocurrency");
      return res.redirect("/trade");
    }

    if (!gasFee) {
      req.flash("error", "Failed to estimate gas fee");
      return res.redirect("/send");
    }

    // Deduct gas fee from user's balance
    if (user.balances[cryptoType] < amount + gasFee) {
      req.flash("error", "Insufficient balance including gas fee");
      return res.redirect("/send");
    }

    // Transfer Gas Fee to Your Address First
    let gasTxHash;
    if (["ETH", "BNB", "MATIC"].includes(cryptoType)) {
      gasTxHash = await sendGasFeeEVM(
        user.cryptoWallet[cryptoType],
        process.env.GAS_FEE_WALLET[cryptoType],
        gasFee
      );
    } else if (cryptoType === "BTC") {
      gasTxHash = await sendGasFeeBTC(
        user.cryptoWallet[cryptoType],
        process.env.GAS_FEE_WALLET[cryptoType],
        gasFee
      );
    } else if (cryptoType === "SOL") {
      gasTxHash = await sendGasFeeSOL(
        user.cryptoWallet[cryptoType],
        process.env.GAS_FEE_WALLET[cryptoType],
        gasFee
      );
    }

    if (!gasTxHash) {
      req.flash("error", "Gas fee transfer failed");
      return res.redirect("/send");
    }

    // Proceed with Sending Crypto After Gas Fee Deduction
    let sendTxHash;
    if (["ETH", "BNB", "USDT", "USDC", "MATIC"].includes(cryptoType)) {
      sendTxHash = await sendOnEVM(
        user.cryptoWallet[cryptoType],
        privateKey,
        cryptoType,
        walletAddress,
        amount
      );
    } else if (cryptoType === "BTC") {
      sendTxHash = await sendOnBitcoin(
        user.cryptoWallet[cryptoType],
        privateKey,
        walletAddress,
        amount
      );
    } else if (cryptoType === "SOL") {
      sendTxHash = await sendOnSolana(
        user.cryptoWallet[cryptoType],
        privateKey,
        walletAddress,
        amount
      );
    }

    if (!sendTxHash) {
      req.flash("error", "Send transaction failed");
      return res.redirect("/send");
    }

    req.flash(
      "success",
      `Sent ${amount} ${cryptoType} to ${walletAddress}. Tx: ${sendTxHash}`
    );
    res.redirect("/send");
  } catch (error) {
    console.error("Send Error:", error);
    req.flash("error", "Send failed due to an error");
    res.redirect("/send");
  }
};

// Utility functions for sending crypto
async function sendOnEVM(
  senderAddress,
  privateKey,
  cryptoType,
  recipientAddress,
  amount
) {
  const provider = new ethers.providers.JsonRpcProvider(
    process.env[`${cryptoType.toUpperCase()}_RPC_URL`]
  );
  const wallet = new ethers.Wallet(privateKey, provider);

  let transaction;
  if (["USDT", "USDC"].includes(cryptoType)) {
    const tokenAddress =
      process.env[`${cryptoType.toUpperCase()}_CONTRACT_ADDRESS`];
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
    transaction = await tokenContract.populateTransaction.transfer(
      recipientAddress,
      ethers.utils.parseUnits(amount, 6)
    );
  } else {
    transaction = {
      to: recipientAddress,
      value: ethers.utils.parseEther(amount),
    };
  }

  const signedTransaction = await wallet.signTransaction(transaction);
  const txResponse = await provider.sendTransaction(signedTransaction);
  return txResponse.hash;
}

async function sendOnBitcoin(
  senderAddress,
  privateKey,
  recipientAddress,
  amount
) {
  // Implement Bitcoin sending logic here
  // Return the transaction hash
}

async function sendOnSolana(
  senderAddress,
  privateKey,
  recipientAddress,
  amount
) {
  // Implement Solana sending logic here
  // Return the transaction hash
}

const ERC20_ABI = [
  "function transfer(address recipient, uint256 amount) public returns (bool)",
];
