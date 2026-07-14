/**
 * Townhall — Sepolia ENS Auto-Registrar
 *
 * Polls until the wallet is funded, then:
 *   1. Registers the ENS name on Sepolia
 *   2. Sets parcel.pin text record
 *   3. Updates oracle/.env with ETH_NETWORK=sepolia
 *
 * Run: node ens-register.mjs
 */

import { ethers } from "ethers";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────
const NAMES_TO_TRY = [
  "manuj", "manujsrinivasa", "manujwake", "townhallparcel",
  "townhallmanuj", "manujcre", "briercreekparcel", "manujnc",
];
const PARCEL_PIN   = "0768487494";
const DURATION     = 365 * 24 * 60 * 60;   // 1 year
const SEPOLIA_RPC  = "https://ethereum-sepolia-rpc.publicnode.com";

// Sepolia ENS contracts (correct v3 addresses from docs.ens.domains/learn/deployments)
const ETH_REGISTRAR = "0xfb3cE5D01e0f33f41DbB39035dB9745962F1f968";
const PUBLIC_RESOLVER = "0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5";

const CONTROLLER_ABI = [
  "function available(string name) view returns (bool)",
  "function rentPrice(string name, uint256 duration) view returns (tuple(uint256 base, uint256 premium))",
  "function minCommitmentAge() view returns (uint256)",
  "function makeCommitment(string name, address owner, uint256 duration, bytes32 secret, address resolver, bytes[] calldata data, bool reverseRecord, uint16 fuses) pure returns (bytes32)",
  "function commit(bytes32 commitment)",
  "function register(string name, address owner, uint256 duration, bytes32 secret, address resolver, bytes[] calldata data, bool reverseRecord, uint16 fuses) payable",
];

const RESOLVER_ABI = [
  "function setText(bytes32 node, string key, string value)",
  "function text(bytes32 node, string key) view returns (string)",
];

// ── Load wallet ───────────────────────────────────────────────────────────────
const walletFile = path.join(__dirname, ".sepolia-wallet.json");
const { address, privateKey } = JSON.parse(readFileSync(walletFile, "utf8"));

const provider   = new ethers.JsonRpcProvider(SEPOLIA_RPC);
const wallet     = new ethers.Wallet(privateKey, provider);
const controller = new ethers.Contract(ETH_REGISTRAR, CONTROLLER_ABI, wallet);
const resolver   = new ethers.Contract(PUBLIC_RESOLVER, RESOLVER_ABI, wallet);

// ── Step 1: Wait for funding ───────────────────────────────────────────────────
console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("  Townhall ENS Registrar — Sepolia Testnet");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
console.log(`Wallet:  ${address}`);
console.log(`Parcel:  ${PARCEL_PIN}\n`);
console.log("Fund this address with 0.05+ Sepolia ETH from one of these faucets:");
console.log("  → https://www.alchemy.com/faucets/ethereum-sepolia");
console.log("  → https://cloud.google.com/application/web3/faucet/ethereum/sepolia");
console.log("  → https://faucets.chain.link/sepolia");
console.log("  → https://faucet.quicknode.com/ethereum/sepolia\n");
console.log("Waiting for funds (checking every 10s)...\n");

while (true) {
  const bal = await provider.getBalance(address);
  const eth = parseFloat(ethers.formatEther(bal));
  process.stdout.write(`\r  Balance: ${eth.toFixed(6)} ETH   `);
  if (eth >= 0.01) {
    console.log(`\n\n✅ Funded! Balance: ${eth.toFixed(6)} ETH — starting registration...\n`);
    break;
  }
  await new Promise(r => setTimeout(r, 10_000));
}

// ── Step 2: Find an available name ────────────────────────────────────────────
console.log("Checking name availability...");
let chosenName = null;
for (const name of NAMES_TO_TRY) {
  const avail = await controller.available(name).catch(() => false);
  console.log(`  ${name}.eth → ${avail ? "✅ available" : "❌ taken"}`);
  if (avail && !chosenName) chosenName = name;
}

if (!chosenName) {
  console.error("\n❌ All names taken. Add more options to NAMES_TO_TRY in the script.");
  process.exit(1);
}

console.log(`\n→ Registering: ${chosenName}.eth\n`);

// ── Step 3: Check price ───────────────────────────────────────────────────────
const price = await controller.rentPrice(chosenName, DURATION);
const cost  = price.base + price.premium;
console.log(`Rent price: ${ethers.formatEther(cost)} ETH / year`);

// ── Step 4: Commit ────────────────────────────────────────────────────────────
const secret     = ethers.randomBytes(32);
const commitment = await controller.makeCommitment(
  chosenName, wallet.address, DURATION, secret,
  PUBLIC_RESOLVER, [], false, 0
);

console.log("\n[1/3] Sending commit transaction...");
const commitTx = await controller.commit(commitment);
console.log(`      TX: ${commitTx.hash}`);
await commitTx.wait();
console.log("      Confirmed ✅");

// ── Step 5: Wait min commitment age ──────────────────────────────────────────
const minAge = Number(await controller.minCommitmentAge());
console.log(`\n[2/3] Waiting ${minAge}s for commitment to mature...`);
for (let i = minAge + 2; i > 0; i--) {
  process.stdout.write(`\r      ${i}s remaining...   `);
  await new Promise(r => setTimeout(r, 1000));
}
console.log("\r      Ready ✅                ");

// ── Step 6: Register ──────────────────────────────────────────────────────────
console.log("\n[3/3] Sending register transaction...");
const registerTx = await controller.register(
  chosenName, wallet.address, DURATION, secret,
  PUBLIC_RESOLVER, [], false, 0,
  { value: cost * 110n / 100n }
);
console.log(`      TX: ${registerTx.hash}`);
await registerTx.wait();
console.log("      Confirmed ✅");

// ── Step 7: Set parcel.pin text record ───────────────────────────────────────
console.log(`\n[+] Setting parcel.pin = ${PARCEL_PIN}...`);
const node   = ethers.namehash(`${chosenName}.eth`);
const textTx = await resolver.setText(node, "parcel.pin", PARCEL_PIN);
console.log(`    TX: ${textTx.hash}`);
await textTx.wait();
console.log("    Confirmed ✅");

// ── Step 8: Update oracle/.env ────────────────────────────────────────────────
const envPath = path.join(__dirname, "..", ".env");
let env = readFileSync(envPath, "utf8");
env = env.replace(/^ETH_NETWORK=.*$/m, "ETH_NETWORK=sepolia");
writeFileSync(envPath, env);
console.log("\n[+] oracle/.env updated: ETH_NETWORK=sepolia");

// ── Done ─────────────────────────────────────────────────────────────────────
console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(`  ✅ ${chosenName}.eth registered on Sepolia!`);
console.log(`  parcel.pin = ${PARCEL_PIN}`);
console.log(`  View: https://sepolia.app.ens.domains/${chosenName}.eth`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
console.log("Now update the MCP demo map with this name, then test:");
console.log(`  lookup_ens("${chosenName}.eth")`);
