const { ethers } = require("ethers");

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

module.exports = { deriveEVMPrivateKey, estimateEVMGas };
