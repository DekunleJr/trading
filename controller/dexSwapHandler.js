const { ethers } = require("ethers");
// require('dotenv').config();

const DEX_ROUTER_ADDRESS = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"; // Uniswap V2 Router on Ethereum Mainnet
const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"; // WETH on Ethereum Mainnet
const DEX_ROUTER_ABI = [
  /* ... Uniswap V2 Router ABI snippets ... */
]; // Get relevant functions like swapExactTokensForTokens, swapExactETHForTokens, getAmountsOut, etc.
const ERC20_ABI = [
  /* ... approve, decimals, balanceOf ... */
];

const provider = new ethers.providers.JsonRpcProvider(process.env.INFURA_API); // Or your chosen RPC

async function swapOnDex(
  senderPrivateKey,
  fromTokenAddress,
  toTokenAddress,
  amountInString
) {
  const wallet = new ethers.Wallet(senderPrivateKey, provider);
  const senderAddress = await wallet.getAddress();

  // Determine if swapping native ETH or ERC20
  const isSendingNative = fromTokenAddress.toUpperCase() === "ETH";
  const fromAddress = isSendingNative ? WETH_ADDRESS : fromTokenAddress; // Use WETH for path if sending ETH
  const toAddress =
    toTokenAddress.toUpperCase() === "ETH" ? WETH_ADDRESS : toTokenAddress; // Use WETH for path if receiving ETH

  // 1. Get Decimals (for input amount conversion)
  let amountInWei;
  if (!isSendingNative) {
    const fromContract = new ethers.Contract(fromAddress, ERC20_ABI, wallet);
    const decimals = await fromContract.decimals();
    amountInWei = ethers.utils.parseUnits(amountInString, decimals);
  } else {
    amountInWei = ethers.utils.parseEther(amountInString); // ETH uses 18 decimals
  }

  const routerContract = new ethers.Contract(
    DEX_ROUTER_ADDRESS,
    DEX_ROUTER_ABI,
    wallet
  );

  // 2. Approval (Only if sending ERC20)
  if (!isSendingNative) {
    console.log(`Checking/Setting allowance for ${fromAddress}...`);
    const fromContract = new ethers.Contract(fromAddress, ERC20_ABI, wallet);
    const currentAllowance = await fromContract.allowance(
      senderAddress,
      DEX_ROUTER_ADDRESS
    );
    if (currentAllowance.lt(amountInWei)) {
      // lt = less than
      console.log("Allowance is insufficient, sending approve transaction...");
      const approveTx = await fromContract.approve(
        DEX_ROUTER_ADDRESS,
        amountInWei
      ); // Approve the exact amount or ethers.constants.MaxUint256
      console.log("Approve tx sent:", approveTx.hash);
      await approveTx.wait(); // Wait for approval to be mined
      console.log("Approval confirmed.");
    } else {
      console.log("Sufficient allowance already set.");
    }
  }

  // 3. Define Swap Path
  const path = [fromAddress, toAddress]; // Simple direct path; might need intermediate tokens (e.g., WETH) for some pairs: [TOKEN_A, WETH, TOKEN_B]

  // 4. Estimate Output & Set Slippage
  let amountsOut;
  try {
    amountsOut = await routerContract.getAmountsOut(amountInWei, path);
  } catch (estimateError) {
    console.error(
      "Could not estimate output amount (likely insufficient liquidity or bad path):",
      estimateError
    );
    return {
      success: false,
      error: "Could not estimate swap output. Check liquidity or token pair.",
    };
  }

  const amountOutMin = amountsOut[path.length - 1].mul(995).div(1000); // Example: 0.5% slippage tolerance (99.5% of estimated output)
  console.log(
    `Estimated amount out: ${ethers.utils.formatUnits(
      amountsOut[path.length - 1] /* get 'to' token decimals */
    )}`
  );
  console.log(
    `Minimum amount out (0.5% slippage): ${ethers.utils.formatUnits(
      amountOutMin /* get 'to' token decimals */
    )}`
  );

  // 5. Prepare and Send Swap Transaction
  const deadline = Math.floor(Date.now() / 1000) + 60 * 10; // 10 minutes from now
  let swapTx;

  try {
    const overrides = {};
    if (isSendingNative) {
      overrides.value = amountInWei; // Attach native ETH value
    }
    // Add gas estimation/settings here (provider.getGasPrice(), etc.)
    // overrides.gasLimit = await routerContract.estimateGas...(); // Estimate gas for the specific swap function
    // overrides.gasPrice = await provider.getGasPrice();

    console.log("Preparing swap transaction...");

    if (isSendingNative && toAddress === WETH_ADDRESS) {
      // ETH -> WETH (Deposit) - Special case, not really a swap via router
      console.warn("Use WETH contract 'deposit' function for ETH -> WETH");
      return {
        success: false,
        error: "Use WETH contract 'deposit' function directly.",
      };
    } else if (isSendingNative) {
      // ETH -> ERC20
      swapTx = await routerContract.swapExactETHForTokens(
        amountOutMin,
        path, // Path starts with WETH
        senderAddress, // Recipient
        deadline,
        overrides
      );
    } else if (toAddress === WETH_ADDRESS) {
      // ERC20 -> ETH
      swapTx = await routerContract.swapExactTokensForETH(
        amountInWei,
        amountOutMin,
        path, // Path ends with WETH
        senderAddress,
        deadline,
        overrides
      );
    } else {
      // ERC20 -> ERC20
      swapTx = await routerContract.swapExactTokensForTokens(
        amountInWei,
        amountOutMin,
        path,
        senderAddress,
        deadline,
        overrides
      );
    }

    console.log("Swap transaction sent:", swapTx.hash);
    const receipt = await swapTx.wait(); // Wait for transaction to be mined
    console.log("Swap transaction confirmed:", receipt.transactionHash);
    return { success: true, transactionHash: receipt.transactionHash };
  } catch (swapError) {
    console.error("On-chain swap failed:", swapError);
    // Attempt to decode revert reason if possible
    let reason = swapError.reason || swapError.message || "Unknown swap error";
    if (swapError.data) {
      // try { reason = ethers.utils.toUtf8String('0x' + swapError.data.substr(138)); } catch {} // Basic attempt
    }
    return { success: false, error: `Swap execution failed: ${reason}` };
  }
}

module.exports = {
  swapOnDex,
};

// --- How you might call it in your controller ---
// case "USDC": // Swapping FROM USDC
//    if (toUpper === 'USDT') {
//         transactionStatus = await swapOnDex(privateKey, USDC_CONTRACT_ADDRESS, USDT_CONTRACT_ADDRESS, sendAmountString);
//    } else if (toUpper === 'ETH') {
//         transactionStatus = await swapOnDex(privateKey, USDC_CONTRACT_ADDRESS, 'ETH', sendAmountString);
//    } else { // etc }
//    break;
// case "ETH": // Swapping FROM ETH
//     if (toUpper === 'USDC') {
//         transactionStatus = await swapOnDex(privateKey, 'ETH', USDC_CONTRACT_ADDRESS, sendAmountString);
//     } // etc
//     break;
