const bitcoin = require("bitcoinjs-lib");
const axios = require("axios");
require("dotenv").config();

// BlockCypher API (or use your Bitcoin Node)
const API_URL = "https://api.blockcypher.com/v1/btc/main/txs/push";
const NETWORK = bitcoin.networks.bitcoin; // Use bitcoin.networks.testnet for testnet

async function sendBitcoinTransaction(
  senderPrivateKey,
  recipientAddress,
  amount,
  utxoTxId,
  utxoIndex
) {
  try {
    // Convert private key to key pair
    const keyPair = bitcoin.ECPair.fromWIF(senderPrivateKey, NETWORK);

    // Create a new transaction builder
    const txb = new bitcoin.TransactionBuilder(NETWORK);
    txb.addInput(utxoTxId, utxoIndex); // UTXO to spend
    txb.addOutput(recipientAddress, Math.floor(amount * 1e8)); // Convert BTC to Satoshis

    // Sign the transaction
    txb.sign(0, keyPair);

    // Build and serialize transaction
    const tx = txb.build();
    const txHex = tx.toHex();

    // Broadcast transaction
    const response = await axios.post(API_URL, { tx: txHex });
    return response.data.tx.hash;
  } catch (error) {
    console.error("Transaction error:", error.response?.data || error.message);
    throw new Error("Failed to send Bitcoin transaction");
  }
}

const estimateEVMGas = async (network, isToken = false) => {
  try {
    // Get gas price from API
    const gasPriceResponse = await axios.get(
      `https://api.gasstation.io/v2/${network}`
    );
    const gasPrice = gasPriceResponse.data.fast; // Fast transaction speed gas price

    // Adjust gas limit based on transaction type
    const gasLimit = isToken ? 65000 : 21000; // Higher gas for ERC-20 transfers

    // Calculate estimated gas fee (gas price * gas limit)
    const estimatedGas = gasPrice * gasLimit;

    return estimatedGas; // Return gas fee in native currency (ETH, BNB, etc.)
  } catch (error) {
    console.error(`${network} Gas Fee Error:`, error);
    return null;
  }
};

module.exports = {
  estimateEVMGas,
  sendBitcoinTransaction,
};
