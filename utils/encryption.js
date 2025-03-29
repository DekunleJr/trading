const CryptoJS = require("crypto-js");
require("dotenv").config();

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

module.exports = { encryptPrivateKey, decryptPrivateKey };
