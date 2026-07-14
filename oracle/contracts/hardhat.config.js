require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const HEDERA_PRIVATE_KEY = process.env.HEDERA_PRIVATE_KEY || "";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    // Hedera Testnet — free HBAR from faucet.hedera.com
    hederaTestnet: {
      url: "https://testnet.hashio.io/api",
      chainId: 296,
      accounts: HEDERA_PRIVATE_KEY ? [HEDERA_PRIVATE_KEY] : [],
      gas: 500000,
      gasPrice: 10_000_000_000,   // 10 Gwei — required by Hedera fee model
    },
    // Hedera Mainnet
    hederaMainnet: {
      url: "https://mainnet.hashio.io/api",
      chainId: 295,
      accounts: HEDERA_PRIVATE_KEY ? [HEDERA_PRIVATE_KEY] : [],
      gas: 500000,
      gasPrice: 10_000_000_000,
    },
  },
  paths: {
    sources: "./src",
    artifacts: "./artifacts",
    cache: "./cache",
    tests: "./tests",
  },
};
