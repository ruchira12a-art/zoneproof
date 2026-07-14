import { ethers } from "ethers";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load compiled artifact
const artifact = JSON.parse(readFileSync(
  "/Users/manojsrinivasa/Desktop/Projects/townhall/oracle/contracts/artifacts/src/RezoningOracle.sol/RezoningOracle.json",
  "utf8"
));

const PRIVATE_KEY    = "0xab0b65f2bc135bd585fc7a911cae0c6e53221358e3156006ae3a9bf2c504fab9";
const ORACLE_ADDRESS = "0x85652f8479dc8dbd89adaee37d42e7c91a534294";
const RPC_URL        = "https://testnet.hashio.io/api";

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);

console.log("Deployer :", wallet.address);
const balance = await provider.getBalance(wallet.address);
console.log("Balance  :", ethers.formatEther(balance), "HBAR");

const factory  = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
console.log("Deploying RezoningOracle...");

const contract = await factory.deploy(ORACLE_ADDRESS, {
  gasLimit: 1_000_000,
  gasPrice: 1_140_000_000_000n,  // Hedera testnet minimum: 1140 Gwei,
});

console.log("Tx hash  :", contract.deploymentTransaction().hash);
console.log("Waiting for confirmation...");

await contract.waitForDeployment();
const address = await contract.getAddress();

console.log("\n✅ RezoningOracle deployed!");
console.log("Contract :", address);
console.log("\nAdd to oracle/.env:");
console.log(`REZONING_ORACLE_ADDRESS=${address}`);
