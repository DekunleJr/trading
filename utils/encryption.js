const CryptoJS = require("crypto-js");
require("dotenv").config();
const { ethers } = require("ethers");

const SECRET_KEY = process.env.SECRET_KEY; // Use a strong secret key

// Encrypt a private key before storing it
const encryptPrivateKey = (privateKey) => {
  return CryptoJS.AES.encrypt(privateKey, SECRET_KEY).toString();
};

// Decrypt private key when needed
const decryptPrivateKey = (encryptedKey) => {
  try {
    const bytes = CryptoJS.AES.decrypt(encryptedKey, SECRET_KEY);
    return bytes.toString(CryptoJS.enc.Utf8);
  } catch (error) {
    console.error("Decryption Error:", error);
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

module.exports = { deriveEVMPrivateKey, encryptPrivateKey, decryptPrivateKey };
