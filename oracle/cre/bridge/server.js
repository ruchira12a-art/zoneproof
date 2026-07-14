/**
 * oracle/cre/bridge/server.js
 *
 * Hedera Bridge Server — the middleman between CRE and Hedera EVM.
 *
 * Why this exists:
 *   Hedera EVM (chain 296) is not yet a native CRE write target.
 *   CRE workflows CAN make HTTP calls, so the workflow POSTs the consensus
 *   Merkle root here. This server holds the Hedera signer and forwards
 *   the root to RezoningOracle.sol on-chain.
 *
 * Endpoints:
 *   POST /commit-batch   ← called by CRE workflow (main.ts)
 *   GET  /status         ← current on-chain state
 *   GET  /history        ← committed batches from Supabase
 *   GET  /health         ← liveness check
 *
 * Start:
 *   cd oracle/cre/bridge && npm install && npm start
 */

const express  = require("express");
const { ethers } = require("ethers");
const { Pool }   = require("pg");
const path     = require("path");
const fs       = require("fs");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

const app  = express();
const PORT = process.env.BRIDGE_PORT || 3000;

app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── Contract setup ─────────────────────────────────────────────────────────────

const CONTRACT_ADDR = process.env.REZONING_ORACLE_ADDRESS;
const PRIV_KEY      = process.env.HEDERA_PRIVATE_KEY;
const RPC_URL       = "https://testnet.hashio.io/api";
const GAS_PRICE     = 1_140_000_000_000n;   // Hedera testnet minimum
const GAS_LIMIT     = 4_000_000;
const MAX_PINS      = 50;
const COUNTY_ID     = "raleigh_nc";

if (!CONTRACT_ADDR) { console.error("❌ REZONING_ORACLE_ADDRESS not set in oracle/.env"); process.exit(1); }
if (!PRIV_KEY)      { console.error("❌ HEDERA_PRIVATE_KEY not set in oracle/.env");      process.exit(1); }

// Load ABI from compiled artifact
const artifactPath = path.join(__dirname, "../../contracts/artifacts/src/RezoningOracle.sol/RezoningOracle.json");
const { abi: ABI } = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

// Static network — skip eth_chainId auto-detect (Hedera relay returns 502 on probes)
const hederaNet  = ethers.Network.from(296);
const provider   = new ethers.JsonRpcProvider(RPC_URL, hederaNet, { staticNetwork: hederaNet });
const wallet     = new ethers.Wallet(PRIV_KEY, provider);
const contract   = new ethers.Contract(CONTRACT_ADDR, ABI, wallet);

// ── Database ───────────────────────────────────────────────────────────────────

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     parseInt(process.env.DB_PORT || "5432"),
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl:      { rejectUnauthorized: false },
  max:      3,
});

// ── Helpers ────────────────────────────────────────────────────────────────────

async function pollHederaReceipt(txHash, maxAttempts = 20, delayMs = 5000) {
  const url = `https://testnet.mirrornode.hedera.com/api/v1/contracts/results/${txHash}`;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, delayMs));
    const r = await fetch(url);
    if (!r.ok) { process.stdout.write("."); continue; }
    const data = await r.json();
    if (data.result === "SUCCESS") {
      process.stdout.write("\n");
      return { hash: txHash, blockNumber: data.block_number, gasUsed: data.gas_used, logs: [] };
    }
    if (data.result && data.result !== "SUCCESS") throw new Error(`TX failed: ${data.result}`);
    process.stdout.write(".");
  }
  throw new Error(`TX not confirmed after ${maxAttempts * delayMs / 1000}s`);
}

// ── Routes ─────────────────────────────────────────────────────────────────────

/**
 * POST /commit-batch
 * Called by CRE workflow after computing Merkle root.
 *
 * Body: {
 *   merkleRoot: string,   // 0x-prefixed bytes32
 *   leafCount:  number,
 *   eventIds:   string[], // UUIDs of committed change_events
 *   countyId:   string
 * }
 */
app.post("/commit-batch", async (req, res) => {
  const startTime = Date.now();

  try {
    const { merkleRoot, leafCount, eventIds, countyId } = req.body;

    if (!merkleRoot || !leafCount || !Array.isArray(eventIds) || eventIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: merkleRoot, leafCount, eventIds[]"
      });
    }

    console.log("\n📝 CRE commit-batch request received:");
    console.log(`   Merkle root : ${merkleRoot}`);
    console.log(`   Leaf count  : ${leafCount}`);
    console.log(`   Events      : ${eventIds.length}`);

    // Fetch leaf hashes from DB to build pinHashes (needed for contract call)
    const eventsResult = await pool.query(
      `SELECT id, petition_number, pin,
              (SELECT ARRAY_AGG(p) FROM rezoning_petitions rp, UNNEST(rp.pins) p
               WHERE rp.petition_number = ce.petition_number LIMIT 50) AS affected_pins
       FROM change_events ce
       WHERE id = ANY($1::uuid[]) AND committed_at IS NULL`,
      [eventIds]
    );

    const events = eventsResult.rows;
    console.log(`   DB rows     : ${events.length}`);

    // Collect unique PINs → pinHashes for on-chain index
    const pinMap = new Map();
    for (const ev of events) {
      const petition = ev.petition_number || "";
      if (ev.pin) pinMap.set(ev.pin, petition);
      if (Array.isArray(ev.affected_pins)) {
        for (const p of ev.affected_pins) if (p) pinMap.set(String(p), petition);
      }
    }
    const capped         = Array.from(pinMap.entries()).slice(0, MAX_PINS);
    const pinHashes      = capped.map(([p]) => ethers.keccak256(ethers.toUtf8Bytes(p)));
    const petitionNumbers = capped.map(([, pet]) => pet);
    console.log(`   PINs        : ${pinMap.size} unique → storing ${pinHashes.length} on-chain`);

    // Insert pending DB batch record
    const batchUUID = crypto.randomUUID();
    await pool.query(
      `INSERT INTO merkle_batches
         (batch_id, merkle_root, leaf_count, changes_count, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [batchUUID, merkleRoot, leafCount, eventIds.length]
    );

    // Submit to Hedera (with retry on 502)
    console.log("⏳ Submitting commitBatch() to Hedera...");
    let tx;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        tx = await contract.commitBatch(
          merkleRoot,
          BigInt(leafCount),
          0n,
          BigInt(leafCount - 1),
          COUNTY_ID,
          pinHashes,
          petitionNumbers,
          { gasLimit: GAS_LIMIT, gasPrice: GAS_PRICE }
        );
        break;
      } catch (sendErr) {
        const is502 = sendErr.message?.includes("502") || sendErr.code === "SERVER_ERROR";
        if (!is502 || attempt === 4) throw sendErr;
        console.log(`   Attempt ${attempt} got 502 — retrying in ${attempt * 8}s...`);
        await new Promise(r => setTimeout(r, attempt * 8_000));
      }
    }

    console.log(`   TX hash : ${tx.hash}`);
    console.log("   Waiting for confirmation...");

    let receipt;
    try {
      receipt = await tx.wait(1);
    } catch (waitErr) {
      console.log(`   wait() threw — polling mirror node...`);
      receipt = await pollHederaReceipt(tx.hash);
    }

    // Parse on-chain batch ID from BatchCommitted event
    let onChainBatchId = null;
    for (const log of (receipt.logs || [])) {
      try {
        const parsed = contract.interface.parseLog(log);
        if (parsed?.name === "BatchCommitted") { onChainBatchId = parsed.args.batchId; break; }
      } catch { /* not our event */ }
    }
    if (onChainBatchId === null) {
      const count = await contract.batchCount();
      onChainBatchId = count - 1n;
    }

    console.log(`   On-chain batch ID : ${onChainBatchId.toString()}`);
    console.log(`   Block             : ${receipt.blockNumber}`);

    // Update DB: merkle_batches + change_events
    await pool.query(
      `UPDATE merkle_batches
       SET hedera_evm_tx_hash = $1, hedera_evm_block = $2,
           snapshot_index = $3, status = 'committed', committed_at = NOW()
       WHERE batch_id = $4`,
      [tx.hash, receipt.blockNumber, onChainBatchId.toString(), batchUUID]
    );

    await pool.query(
      `UPDATE change_events
       SET committed_at = NOW(), batch_id = $1::uuid, evm_snapshot_index = $2::bigint
       WHERE id = ANY($3::uuid[]) AND committed_at IS NULL`,
      [batchUUID, onChainBatchId.toString(), eventIds]
    );

    const duration = Date.now() - startTime;
    console.log(`✅ Batch committed! (${duration}ms)\n`);

    res.json({
      success: true,
      transaction: {
        hash:        tx.hash,
        blockNumber: receipt.blockNumber,
        gasUsed:     receipt.gasUsed?.toString(),
        explorerUrl: `https://hashscan.io/testnet/transaction/${tx.hash}`
      },
      onChainBatchId: onChainBatchId.toString(),
      batchUUID,
      merkleRoot,
      eventCount: eventIds.length,
      duration: `${duration}ms`
    });

  } catch (err) {
    console.error("❌ commit-batch failed:", err.message);

    // Mark pending batch as failed
    try {
      await pool.query(
        `UPDATE merkle_batches SET status='failed', error_message=$1
         WHERE status='pending' AND committed_at IS NULL`,
        [err.message?.slice(0, 500)]
      );
    } catch { /* ignore */ }

    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /status
 * Current on-chain state of the RezoningOracle contract.
 */
app.get("/status", async (req, res) => {
  try {
    const batchCount = await contract.batchCount();

    if (batchCount === 0n) {
      return res.json({ success: true, contract: CONTRACT_ADDR, totalBatches: 0, message: "No batches committed yet" });
    }

    const [merkleRoot, leafCount, timestamp, fromSeq, toSeq, countyId] =
      await contract.getBatch(batchCount - 1n);

    res.json({
      success: true,
      contract:   CONTRACT_ADDR,
      network:    "hedera-testnet",
      explorer:   `https://hashscan.io/testnet/contract/${CONTRACT_ADDR}`,
      totalBatches: batchCount.toString(),
      latestBatch: {
        batchId:    (batchCount - 1n).toString(),
        merkleRoot,
        leafCount:  leafCount.toString(),
        timestamp:  new Date(Number(timestamp) * 1000).toISOString(),
        countyId
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /history
 * Recent committed batches from Supabase.
 */
app.get("/history", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT batch_id, merkle_root, leaf_count, snapshot_index,
              hedera_evm_tx_hash, hedera_evm_block, committed_at
       FROM merkle_batches
       WHERE status = 'committed'
       ORDER BY committed_at DESC
       LIMIT 10`
    );
    res.json({ success: true, batches: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /health
 */
app.get("/health", (req, res) => {
  res.json({ status: "healthy", contract: CONTRACT_ADDR, network: "hedera-testnet", timestamp: new Date().toISOString() });
});

// ── Start ──────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   Rezoning Oracle — Hedera Bridge Server                ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`Contract  : ${CONTRACT_ADDR}`);
  console.log(`Signer    : ${wallet.address}`);
  console.log(`Network   : Hedera Testnet (chain 296)`);
  console.log(`Port      : ${PORT}`);
  console.log("");
  console.log(`  POST   http://localhost:${PORT}/commit-batch  ← CRE workflow writes here`);
  console.log(`  GET    http://localhost:${PORT}/status`);
  console.log(`  GET    http://localhost:${PORT}/history`);
  console.log(`  GET    http://localhost:${PORT}/health`);
  console.log("");
  console.log("Waiting for CRE workflow to call /commit-batch...");
  console.log("");
});
