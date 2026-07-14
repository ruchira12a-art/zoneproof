/**
 * Deploy RezoningOracle to Hedera EVM.
 *
 * Usage:
 *   npx hardhat run scripts/deploy.js --network hederaTestnet
 *
 * Required env vars:
 *   HEDERA_PRIVATE_KEY   — deployer account private key (hex, no 0x prefix)
 *   ORACLE_ADDRESS       — EOA that CRE workflow will use to call commitBatch()
 *                          (can be same as deployer for testnet)
 *
 * After deploy, copy CONTRACT_ADDRESS into oracle/.env as REZONING_ORACLE_ADDRESS
 */

const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();

  console.log("Deploying RezoningOracle...");
  console.log("  Network  :", hre.network.name);
  console.log("  Deployer :", deployer.address);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("  Balance  :", hre.ethers.formatEther(balance), "HBAR");

  // Oracle address — who is allowed to call commitBatch()
  // For testnet: use same deployer address
  // For mainnet: use the CRE workflow EOA
  const oracleAddress = process.env.ORACLE_ADDRESS || deployer.address;
  console.log("  Oracle   :", oracleAddress);

  const RezoningOracle = await hre.ethers.getContractFactory("RezoningOracle");

  // Hedera requires explicit gas — estimateGas is unreliable on hashio relay
  const contract = await RezoningOracle.deploy(oracleAddress, {
    gasLimit:  1_000_000,
    gasPrice:  1_500_000_000_000n,  // 1500 Gwei — above Hedera testnet minimum
  });
  await contract.waitForDeployment();

  const address = await contract.getAddress();

  console.log("\n✅ RezoningOracle deployed!");
  console.log("  Contract address :", address);
  console.log("  Oracle address   :", oracleAddress);
  console.log("\nAdd to oracle/.env:");
  console.log(`  REZONING_ORACLE_ADDRESS=${address}`);
  console.log(`  HEDERA_NETWORK=${hre.network.name}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
