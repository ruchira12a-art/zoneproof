/**
 * Register an ENS name on Sepolia testnet + set parcel.pin text record.
 *
 * Prerequisites:
 *   1. Sepolia ETH in your wallet (get from sepoliafaucet.com)
 *   2. Set REGISTRAR_PRIVATE_KEY below (your MetaMask private key)
 *
 * Run: node register-ens-sepolia.mjs
 */

import { ethers } from "ethers";

// ── Config ────────────────────────────────────────────────────────────────────
const ENS_NAME       = "jonumhills";          // without .eth
const PARCEL_PIN     = "0768487494";
const PRIVATE_KEY    = process.env.REGISTRAR_PRIVATE_KEY; // export before running
const SEPOLIA_RPC    = "https://ethereum-sepolia-rpc.publicnode.com";

// Sepolia ENS contract addresses
const ETH_REGISTRAR_CONTROLLER = "0xFED6a969AaA60E4961FCD3EBF1A2e8913ac65B16";
const PUBLIC_RESOLVER           = "0x8FADE66B79cC9f707aB26799354482EB93a5B7dD";
const ENS_REGISTRY              = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";

const CONTROLLER_ABI = [
  "function makeCommitment(string name, address owner, uint256 duration, bytes32 secret, address resolver, bytes[] calldata data, bool reverseRecord, uint16 ownerControlledFuses) pure returns (bytes32)",
  "function commit(bytes32 commitment)",
  "function register(string name, address owner, uint256 duration, bytes32 secret, address resolver, bytes[] calldata data, bool reverseRecord, uint16 ownerControlledFuses) payable",
  "function rentPrice(string name, uint256 duration) view returns (tuple(uint256 base, uint256 premium))",
  "function minCommitmentAge() view returns (uint256)",
];

const RESOLVER_ABI = [
  "function setText(bytes32 node, string key, string value)",
  "function text(bytes32 node, string key) view returns (string)",
];

// ── Main ──────────────────────────────────────────────────────────────────────
if (!PRIVATE_KEY) {
  console.error("Set REGISTRAR_PRIVATE_KEY env var first:");
  console.error("  export REGISTRAR_PRIVATE_KEY=0x...");
  console.error("  node register-ens-sepolia.mjs");
  process.exit(1);
}

const provider   = new ethers.JsonRpcProvider(SEPOLIA_RPC);
const wallet     = new ethers.Wallet(PRIVATE_KEY, provider);
const controller = new ethers.Contract(ETH_REGISTRAR_CONTROLLER, CONTROLLER_ABI, wallet);
const resolver   = new ethers.Contract(PUBLIC_RESOLVER, RESOLVER_ABI, wallet);

console.log(`Registering ${ENS_NAME}.eth on Sepolia...`);
console.log(`Wallet: ${wallet.address}`);

const duration = 365 * 24 * 60 * 60; // 1 year in seconds
const secret   = ethers.randomBytes(32);
const node     = ethers.namehash(`${ENS_NAME}.eth`);

// Step 1: Check price
const price = await controller.rentPrice(ENS_NAME, duration);
const cost  = price.base + price.premium;
console.log(`\nRent price: ${ethers.formatEther(cost)} ETH`);

const balance = await provider.getBalance(wallet.address);
console.log(`Your balance: ${ethers.formatEther(balance)} ETH`);
if (balance < cost) {
  console.error("\nInsufficient Sepolia ETH. Get some from: https://sepoliafaucet.com");
  process.exit(1);
}

// Step 2: Commit
console.log("\nStep 1/3 — Committing...");
const commitment = await controller.makeCommitment(
  ENS_NAME, wallet.address, duration, secret,
  PUBLIC_RESOLVER, [], false, 0
);
const commitTx = await controller.commit(commitment);
console.log(`Commit tx: ${commitTx.hash}`);
await commitTx.wait();

// Step 3: Wait minimum age (60s on Sepolia)
const minAge = Number(await controller.minCommitmentAge());
console.log(`\nStep 2/3 — Waiting ${minAge}s for commitment to mature...`);
await new Promise(r => setTimeout(r, (minAge + 5) * 1000));

// Step 4: Register
console.log("\nStep 3/3 — Registering...");
const registerTx = await controller.register(
  ENS_NAME, wallet.address, duration, secret,
  PUBLIC_RESOLVER, [], false, 0,
  { value: cost * 110n / 100n }  // 10% buffer
);
console.log(`Register tx: ${registerTx.hash}`);
await registerTx.wait();
console.log(`\n✅ ${ENS_NAME}.eth registered!`);

// Step 5: Set parcel.pin text record
console.log(`\nSetting parcel.pin = ${PARCEL_PIN}...`);
const textTx = await resolver.setText(node, "parcel.pin", PARCEL_PIN);
console.log(`Text record tx: ${textTx.hash}`);
await textTx.wait();

console.log(`\n✅ Done!`);
console.log(`  ${ENS_NAME}.eth → parcel.pin = ${PARCEL_PIN}`);
console.log(`  View on Sepolia: https://app.ens.domains/${ENS_NAME}.eth`);
console.log(`\nUpdate oracle/.env: ETH_NETWORK=sepolia`);
