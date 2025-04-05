// const Web3 = require("web3");
const { Web3 } = require("web3");
require("dotenv").config();
const {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  PublicKey,
  clusterApiUrl,
} = require("@solana/web3.js");

const { ethers } = require("ethers");
const {
  deriveEVMPrivateKey,
  decryptPrivateKey,
} = require("../utils/encryption"); // Your decryption utility
const User = require("../model/user"); // Assuming you have a User model
const axios = require("axios");
const bitcoin = require("bitcoinjs-lib");
const network = bitcoin.networks.bitcoin; // Mainnet
const INFURA_API = process.env.INFURA_API;
const { ECPairFactory } = require("ecpair");
const ecc = require("tiny-secp256k1");
const ECPair = ECPairFactory(ecc);

// Controller function to send crypto
exports.sendCrypto = async (req, res) => {
  const { toAddress, amount, currency } = req.body; // user provides these in the body
  try {
    // Fetch the user's wallet data (address and secret key)
    const user = await User.findById(req.session.user._id); // Assuming user is authenticated and userId is in session
    if (!user) {
      req.flash("error", "User not found");
      return res.status(400).redirect("/trade");
    }

    // check amount

    if (parseFloat(amount) > user.balances[currency]) {
      req.flash("error", "Insufficient funds");
      return res.redirect("/trade");
    }

    // Get the sender's wallet address and secret key
    const walletAddress = user.cryptoWallet[currency];

    let privateKey;
    if (currency === "BTC") {
      privateKey = decryptPrivateKey(user.privateKeys.btc);
    } else if (currency === "SOL") {
      privateKey = decryptPrivateKey(user.privateKeys.sol);
    } else if (["ETH", "BNB", "USDT", "USDC", "POLYGON"].includes(currency)) {
      privateKey = deriveEVMPrivateKey(user.mnemonic, currency);
    } else {
      req.flash("error", "Unsupported cryptocurrency");
      return res.redirect("/trade");
    }

    // Calculate the gas fee (5% of the amount)
    const fee = amount * 0.05;
    const sendAmount = amount - fee;

    // Make sure the user has sufficient balance
    if (amount <= user.balances[currency]) {
      req.flash("error", "Insufficient funds after gas fee");
      return res.redirect("/trade");
    }

    // Depending on the currency type, handle the transaction
    let transactionStatus;

    switch (currency.toLowerCase()) {
      case "eth":
      case "usdt": // ETH-based tokens
        transactionStatus = await sendETH(
          walletAddress,
          toAddress,
          sendAmount,
          privateKey,
          currency
        );
        break;

      case "sol":
        transactionStatus = await sendSOL(
          walletAddress,
          toAddress,
          sendAmount,
          privateKey
        );
        break;

      case "polygon":
        transactionStatus = await sendPolygon(
          walletAddress,
          toAddress,
          sendAmount,
          privateKey
        );
        break;

      case "bnb":
        transactionStatus = await sendBNB(
          walletAddress,
          toAddress,
          sendAmount,
          privateKey
        );
        break;

      case "btc":
        transactionStatus = await sendBTC(
          walletAddress,
          toAddress,
          sendAmount,
          privateKey
        );
        break;

      default:
        req.flash("error", "Unsupported currency");
        return res.redirect("/trade");
    }

    if (transactionStatus.success) {
      // Deduct the amount (after fee) from user's balance
      user.balances[currency] -= amount;
      await user.save();

      req.flash(
        "success",
        `Successfully sent ${sendAmount} ${currency} to ${toAddress}`
      );
    } else {
      req.flash("error", "Transaction failed");
    }
    return res.redirect("/trade");
  } catch (error) {
    console.error("Send Crypto Error:", error);
    req.flash(
      "error",
      error.message || "An error occurred during the transaction"
    );
    return res.redirect("/trade");
  }
};

// ETH and USDT (ERC-20) send function
const sendETH = async (fromAddress, toAddress, amount, secretKey, currency) => {
  // const web3 = new Web3(INFURA_API);
  const web3 = new Web3(INFURA_API);
  const wallet = web3.eth.accounts.privateKeyToAccount(secretKey);
  web3.eth.accounts.wallet.add(wallet);

  const gasPrice = await web3.eth.getGasPrice();
  const gasLimit = await web3.eth.estimateGas({
    from: fromAddress,
    to: toAddress,
    value: web3.utils.toWei(amount.toString(), "ether"),
  });

  try {
    const tx = await web3.eth.sendTransaction({
      from: fromAddress,
      to: toAddress,
      value: web3.utils.toWei(amount.toString(), "ether"),
      gas: gasLimit,
      gasPrice: gasPrice,
    });

    return { success: true, transactionHash: tx.transactionHash };
  } catch (error) {
    console.error("ETH Send Error:", error);
    return { success: false };
  }
};

const bs58 = require("bs58");

// If secretKey is a hex string like "a3b4..."
function hexToUint8Array(hex) {
  if (hex.length % 2 !== 0) throw new Error("Invalid hex string");
  const bytes = new Uint8Array(hex.length / 2);
  console.log("Hex:", hex);
  console.log("Bytes:", bytes);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

// SOL send function
const sendSOL = async (fromAddress, toAddress, amount, secretKey) => {
  // const connection = new Client("https://api.mainnet-beta.solana.com");
  const connection = new Connection("https://api.mainnet-beta.solana.com");
  const secretKeyBytes = hexToUint8Array(secretKey);
  console.log(secretKeyBytes);

  const wallet = Keypair.fromSecretKey(secretKeyBytes);
  // const wallet = Keypair.fromSecretKey(new Uint8Array(secretKey)); // Decrypt and convert to Keypair

  try {
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: new PublicKey(toAddress),
        lamports: amount * 1e9, // Convert SOL to lamports (1 SOL = 1e9 lamports)
      })
    );

    const signature = await connection.sendTransaction(transaction, [wallet]);
    await connection.confirmTransaction(signature);

    return { success: true, transactionSignature: signature };
  } catch (error) {
    console.error("SOL Send Error:", error);
    return { success: false };
  }
};

// Polygon (ERC-20) send function (same as ETH)
const sendPolygon = async (fromAddress, toAddress, amount, secretKey) => {
  const web3 = new Web3(
    `https://polygon-mainnet.infura.io/v3/${process.env.API_ID}`
  );
  const wallet = web3.eth.accounts.privateKeyToAccount(secretKey);
  web3.eth.accounts.wallet.add(wallet);

  const gasPrice = await web3.eth.getGasPrice();
  const gasLimit = await web3.eth.estimateGas({
    from: fromAddress,
    to: toAddress,
    value: web3.utils.toWei(amount.toString(), "ether"),
  });

  try {
    const tx = await web3.eth.sendTransaction({
      from: fromAddress,
      to: toAddress,
      value: web3.utils.toWei(amount.toString(), "ether"),
      gas: gasLimit,
      gasPrice: gasPrice,
    });

    return { success: true, transactionHash: tx.transactionHash };
  } catch (error) {
    console.error("ETH Send Error:", error);
    return { success: false };
  }
};

// BNB (Binance Smart Chain) send function (same as ETH)
const sendBNB = async (fromAddress, toAddress, amount, secretKey) => {
  const web3 = new Web3(`https://mainnet.infura.io/v3/${process.env.API_ID}`);
  const wallet = web3.eth.accounts.privateKeyToAccount(secretKey);
  web3.eth.accounts.wallet.add(wallet);

  const gasPrice = await web3.eth.getGasPrice();
  const gasLimit = await web3.eth.estimateGas({
    from: fromAddress,
    to: toAddress,
    value: web3.utils.toWei(amount.toString(), "ether"),
  });

  try {
    const tx = await web3.eth.sendTransaction({
      from: fromAddress,
      to: toAddress,
      value: web3.utils.toWei(amount.toString(), "ether"),
      gas: gasLimit,
      gasPrice: gasPrice,
    });

    return { success: true, transactionHash: tx.transactionHash };
  } catch (error) {
    console.error("ETH Send Error:", error);
    return { success: false };
  }
};

const BLOCKCYPHER_TOKEN = process.env.BLOCKCYPHER_TOKEN;

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

    // const broadcastResponse = await axios.post(
    //   "https://api.blockcypher.com/v1/btc/main/txs/send",
    //   { tx: txHex },
    //   {
    //     headers: {
    //       Authorization: `Bearer ${BLOCKCYPHER_TOKEN}`,
    //     },
    //   }
    // );

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
