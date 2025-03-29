const User = require("../model/user");
require("dotenv").config();
const { ethers } = require("ethers");
const { Connection, PublicKey } = require("@solana/web3.js");
// const bitcoin = require("bitcoinjs-lib");
const { ECPairFactory } = require("ecpair");
const ecc = require("tiny-secp256k1");
const axios = require("axios");

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

const sendGasFeeBTC = async (fromWallet, toWallet, gasFee) => {
  try {
    // Send BTC transaction (requires UTXO-based processing)
    return "fake-btc-tx-hash"; // Replace with actual BTC transaction logic
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

const deriveEVMPrivateKey = (mnemonic, crypto) => {
  const hdNode = ethers.utils.HDNode.fromMnemonic(mnemonic);
  const derivationPaths = {
    ETH: "m/44'/60'/0'/0/0",
    BNB: "m/44'/60'/0'/0/1",
    POLYGON: "m/44'/60'/0'/0/2",
  };

  const wallet = hdNode.derivePath(
    derivationPaths[crypto] || derivationPaths.ETH
  );
  return wallet.privateKey;
};

const GAS_FEE_WALLET = {
  ETH: "YOUR_ETH_WALLET_ADDRESS",
  BNB: "YOUR_BNB_WALLET_ADDRESS",
  SOL: "YOUR_SOL_WALLET_ADDRESS",
  BTC: "YOUR_BTC_WALLET_ADDRESS",
  POLYGON: "YOUR_POLYGON_WALLET_ADDRESS",
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
    if (!conversionRate) {
      req.flash("error", "Failed to fetch conversion rate");
      return res.redirect("/trade");
    }

    // Calculate estimated amount after conversion
    const estimatedToAmount = amount * conversionRate;

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
      gasFee = await estimateEVMGas(fromCrypto, amount);
    } else if (fromCrypto === "SOL") {
      gasFee = await estimateSolanaGas();
    } else if (fromCrypto === "BTC") {
      gasFee = await estimateBitcoinGas();
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
      "success",
      `Swapped ${amount} ${fromCrypto} to ${toCrypto}. Tx: ${swapTxHash}`
    );
    res.redirect("/trade");
  } catch (error) {
    console.error("Swap Error:", error);
    req.flash("error", "Swap failed due to an error");
    res.redirect("/trade");
  }
};

exports.sendCrypto = async (req, res, next) => {
  try {
    const { cryptoType, amount, walletAddress } = req.body;
    const user = await User.findById(req.session.user._id);

    if (!user) {
      req.flash("error", "User not found");
      return res.redirect("/trade");
    }

    if (
      !user.cryptoWallet[cryptoType] ||
      user.cryptoBalances[cryptoType] === undefined
    ) {
      req.flash("error", `No wallet or balance found for ${cryptoType}`);
      return res.redirect("/trade");
    }

    const fromWallet = user.cryptoWallet[cryptoType]; // Sender's wallet address
    const fromBalance = user.cryptoBalances[cryptoType];

    if (fromBalance < amount) {
      req.flash("error", `Insufficient ${cryptoType} balance`);
      return res.redirect("/trade");
    }

    // Configure provider & wallet for sending transaction
    const provider = new ethers.providers.JsonRpcProvider(
      process.env.INFURA_API
    );
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider); // User's private key

    // Convert amount to correct format (ETH, BNB, etc.)
    const amountToSend = ethers.utils.parseEther(amount.toString());

    // Create & send transaction
    const tx = await wallet.sendTransaction({
      to: walletAddress,
      value: amountToSend,
    });

    // Wait for transaction confirmation
    await tx.wait();

    // Deduct from database balance
    user.cryptoBalances[cryptoType] -= amount;
    await user.save();

    req.flash(
      "success",
      `Sent ${amount} ${cryptoType} to ${walletAddress}. TX Hash: ${tx.hash}`
    );
    res.redirect("/trade");
  } catch (error) {
    console.error("Send Crypto Error:", error);
    req.flash("error", "Transaction error");
    return res.redirect("/trade");
  }
};
