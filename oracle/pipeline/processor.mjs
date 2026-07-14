/**
 * oracle/pipeline/processor.mjs
 *
 * Reads pending rezoning change events from the oracle API,
 * builds a Merkle tree, calls RezoningOracle.commitBatch() on Hedera EVM,
 * then marks the events as committed in Supabase.
 *
 * Usage:
 *   cd oracle/pipeline && npm install && npm run process
 *
 * Required env vars (oracle/.env):
 *   REZONING_ORACLE_ADDRESS, HEDERA_PRIVATE_KEY,
 *   DB_HOST/PORT/USER/PASSWORD/NAME, API_PORT
 */

import { ethers }              from 'ethers';
import pg                      from 'pg';
import dotenv                  from 'dotenv';
import { fileURLToPath }       from 'url';
import { dirname, join }       from 'path';
import { readFileSync }        from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

dotenv.config({ path: join(__dirname, '../.env') });

// ── Config ─────────────────────────────────────────────────────────────────────

const API_BASE      = `http://localhost:${process.env.API_PORT || 8001}`;
const CONTRACT_ADDR = process.env.REZONING_ORACLE_ADDRESS;
const PRIV_KEY      = process.env.HEDERA_PRIVATE_KEY;
const RPC_URL       = 'https://testnet.hashio.io/api';
const COUNTY_ID     = 'raleigh_nc';
const GAS_PRICE     = 1_140_000_000_000n; // Hedera testnet minimum (1140 Gwei)
const GAS_LIMIT     = 4_000_000;

// Max PINs per batch — each new PIN slot costs ~20k gas for SSTORE.
// 50 PINs × 20k = 1M gas, leaving 1M for base overhead + Merkle storage.
const MAX_PINS_PER_BATCH = 50;

// Events per batch — controls calldata size and DB update cost.
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '100');

const artifact = JSON.parse(
  readFileSync(
    join(__dirname, '../contracts/artifacts/src/RezoningOracle.sol/RezoningOracle.json'),
    'utf8'
  )
);
const ABI = artifact.abi;

// ── DB pool ────────────────────────────────────────────────────────────────────

const { Pool } = pg;
const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     parseInt(process.env.DB_PORT || '5432'),
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl:      { rejectUnauthorized: false },
  max:      3,
});

// ── Merkle helpers ─────────────────────────────────────────────────────────────

/**
 * Build a binary Merkle tree from bytes32 hex leaf values.
 * Internal nodes are keccak256(sorted(left, right)) — matches RezoningOracle._verifyProof.
 * Returns { root: bytes32, tree: levels[] } where tree[0] = leaves.
 */
function buildMerkleTree(leaves) {
  if (leaves.length === 0) throw new Error('Cannot build Merkle tree: no leaves');

  let level = [...leaves];
  const tree = [level];

  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left  = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i]; // duplicate last if odd
      const [a, b] = left <= right ? [left, right] : [right, left];  // sort for determinism
      next.push(ethers.keccak256(ethers.concat([a, b])));
    }
    level = next;
    tree.push(level);
  }

  return { root: level[0], tree };
}

/**
 * Generate a Merkle proof for the leaf at `leafIndex`.
 * Proof is an array of sibling hashes bottom-up.
 */
function getMerkleProof(tree, leafIndex) {
  const proof = [];
  let idx = leafIndex;
  for (let i = 0; i < tree.length - 1; i++) {
    const level   = tree[i];
    const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (sibling < level.length) {
      proof.push(level[sibling]);
    }
    idx = Math.floor(idx / 2);
  }
  return proof;
}

// ── Hedera fallback receipt polling ───────────────────────────────────────────

/**
 * Hedera's JSON-RPC relay sometimes returns 502 on tx.wait() even when the tx
 * landed. Poll the mirror node directly as a fallback.
 */
async function pollHederaReceipt(txHash, maxAttempts = 20, delayMs = 5000) {
  const url = `https://testnet.mirrornode.hedera.com/api/v1/contracts/results/${txHash}`;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, delayMs));
    const r = await fetch(url);
    if (!r.ok) {
      console.log(`  Mirror poll ${i + 1}/${maxAttempts}: HTTP ${r.status}`);
      continue;
    }
    const data = await r.json();
    if (data.result === 'SUCCESS') {
      console.log(`  Confirmed on mirror node (block ${data.block_number})`);
      return {
        hash:        txHash,
        blockNumber: data.block_number,
        gasUsed:     data.gas_used?.toString(),
        logs:        [],
      };
    }
    if (data.result && data.result !== 'SUCCESS') {
      throw new Error(`TX failed on-chain: ${data.result} — ${data.error_message || ''}`);
    }
    console.log(`  Mirror poll ${i + 1}/${maxAttempts}: result=${data.result || 'pending'}`);
  }
  throw new Error(`TX not confirmed after ${maxAttempts} attempts (${(maxAttempts * delayMs) / 1000}s)`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function run() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Rezoning Oracle — Batch Processor      ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`Contract : ${CONTRACT_ADDR}`);
  console.log(`API      : ${API_BASE}`);
  console.log(`Network  : Hedera Testnet (chain 296)`);

  if (!CONTRACT_ADDR) throw new Error('REZONING_ORACLE_ADDRESS not set in oracle/.env');
  if (!PRIV_KEY)      throw new Error('HEDERA_PRIVATE_KEY not set in oracle/.env');

  // ── 1. Fetch pending events ────────────────────────────────────────────────

  console.log('\n[1/6] Fetching pending events from oracle API...');
  const resp = await fetch(`${API_BASE}/api/oracle/pending-events?limit=${BATCH_SIZE}`);
  if (!resp.ok) throw new Error(`API error ${resp.status}: ${await resp.text()}`);

  const body = await resp.json();
  // API returns { count, events } — take up to BATCH_SIZE
  const events = (body.events || []).slice(0, BATCH_SIZE);
  const count  = events.length;
  console.log(`      ${body.count} total pending; processing ${count} in this batch`);

  if (count === 0) {
    console.log('\nNothing to commit. Exiting cleanly.');
    await pool.end();
    return;
  }

  // ── 2. Build Merkle tree ───────────────────────────────────────────────────

  console.log('\n[2/6] Building Merkle tree...');
  const leaves = events.map(e => e.leaf_hash); // SHA-256 bytes32 from oracle API
  const { root: merkleRoot, tree } = buildMerkleTree(leaves);
  const treeDepth = tree.length - 1;

  console.log(`      Leaves : ${leaves.length}`);
  console.log(`      Depth  : ${treeDepth}`);
  console.log(`      Root   : ${merkleRoot}`);

  // Quick self-verification of first leaf
  if (leaves.length > 0) {
    const proof = getMerkleProof(tree, 0);
    let computed = leaves[0];
    for (const sibling of proof) {
      const [a, b] = computed <= sibling ? [computed, sibling] : [sibling, computed];
      computed = ethers.keccak256(ethers.concat([a, b]));
    }
    if (computed !== merkleRoot) throw new Error('Merkle self-verification failed — bug in buildMerkleTree');
    console.log('      Self-verify: OK');
  }

  // ── 3. Collect PIN → petition mappings ────────────────────────────────────

  console.log('\n[3/6] Collecting affected PINs...');
  const pinMap = new Map(); // pin → petition_number
  for (const ev of events) {
    const petition = ev.petition_number || '';
    if (ev.pin) {
      pinMap.set(ev.pin, petition);
    }
    if (Array.isArray(ev.affected_pins)) {
      for (const p of ev.affected_pins) {
        if (p) pinMap.set(String(p), petition);
      }
    }
  }

  // Cap PINs to avoid exceeding gas limit (~20k gas per new PIN slot)
  const allPins = Array.from(pinMap.entries()).slice(0, MAX_PINS_PER_BATCH);
  const pinHashes       = allPins.map(([p]) => ethers.keccak256(ethers.toUtf8Bytes(p)));
  const petitionNumbers = allPins.map(([, pet]) => pet);

  console.log(`      ${pinMap.size} unique PIN(s) found; storing ${pinHashes.length} on-chain`);
  if (pinMap.size > MAX_PINS_PER_BATCH) {
    console.log(`      (capped at ${MAX_PINS_PER_BATCH} — full PIN index in Supabase)`);
  }

  // ── 4. Insert pending merkle_batches row ──────────────────────────────────

  console.log('\n[4/6] Creating DB batch record (status=pending)...');
  const batchUUID = crypto.randomUUID();
  await pool.query(
    `INSERT INTO merkle_batches
       (batch_id, merkle_root, tree_depth, leaf_count, changes_count, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')`,
    [batchUUID, merkleRoot, treeDepth, count, count]
  );
  console.log(`      Batch UUID : ${batchUUID}`);

  // ── 5. Submit commitBatch() to Hedera EVM ─────────────────────────────────

  console.log('\n[5/6] Submitting commitBatch() to Hedera EVM...');
  // Pass the network statically so ethers v6 skips the eth_chainId auto-detect
  // call — Hedera's relay sometimes returns 502 on that probe.
  const hederaNetwork = ethers.Network.from(296);
  const provider = new ethers.JsonRpcProvider(RPC_URL, hederaNetwork, { staticNetwork: hederaNetwork });
  const wallet   = new ethers.Wallet(PRIV_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDR, ABI, wallet);

  // Retry up to 4 times — Hedera's hashio relay returns 502 intermittently
  let tx;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      tx = await contract.commitBatch(
        merkleRoot,
        BigInt(count),
        0n,
        BigInt(count - 1),
        COUNTY_ID,
        pinHashes,
        petitionNumbers,
        { gasLimit: GAS_LIMIT, gasPrice: GAS_PRICE }
      );
      break;
    } catch (sendErr) {
      const is502 = sendErr.message?.includes('502') || sendErr.code === 'SERVER_ERROR';
      if (!is502 || attempt === 4) throw sendErr;
      const delay = attempt * 8_000;
      console.log(`      Send attempt ${attempt} got 502 — retrying in ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  console.log(`      TX hash  : ${tx.hash}`);
  console.log('      Waiting for confirmation...');

  let receipt;
  try {
    receipt = await tx.wait(1);
  } catch (waitErr) {
    console.warn(`      wait() threw (${waitErr.message}) — falling back to mirror node poll...`);
    receipt = await pollHederaReceipt(tx.hash);
  }

  console.log(`      Block    : ${receipt.blockNumber}`);
  console.log(`      Gas used : ${receipt.gasUsed?.toString()}`);

  // Parse on-chain batchId from BatchCommitted event log
  let onChainBatchId = null;
  for (const log of (receipt.logs || [])) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed?.name === 'BatchCommitted') {
        onChainBatchId = parsed.args.batchId;
        break;
      }
    } catch { /* not our event */ }
  }
  if (onChainBatchId === null) {
    // Fallback: batchCount - 1 is the ID just written
    console.warn('      BatchCommitted log not found in receipt — reading batchCount from chain...');
    const currentCount = await contract.batchCount();
    onChainBatchId = currentCount - 1n;
  }
  console.log(`      On-chain batch ID : ${onChainBatchId.toString()}`);

  // ── 6. Commit changes to DB ────────────────────────────────────────────────

  console.log('\n[6/6] Marking events as committed in Supabase...');

  // Update merkle_batches row
  await pool.query(
    `UPDATE merkle_batches
     SET hedera_evm_tx_hash = $1,
         hedera_evm_block   = $2,
         snapshot_index     = $3,
         status             = 'committed',
         committed_at       = NOW()
     WHERE batch_id = $4`,
    [tx.hash, receipt.blockNumber, onChainBatchId.toString(), batchUUID]
  );

  // Bulk-update change_events with committed_at, batch_id, snapshot_index, leaf_hash
  const eventIds   = events.map(e => e.id);
  const leafHashes = leaves;

  await pool.query(
    `UPDATE change_events AS ce
     SET committed_at       = NOW(),
         batch_id           = $2::uuid,
         evm_snapshot_index = $3::bigint,
         merkle_leaf_hash   = v.leaf_hash
     FROM (
       SELECT unnest($1::uuid[]) AS event_id,
              unnest($4::text[]) AS leaf_hash
     ) v
     WHERE ce.id = v.event_id`,
    [eventIds, batchUUID, onChainBatchId.toString(), leafHashes]
  );

  console.log(`      ${count} event(s) marked committed`);

  // ── Done ───────────────────────────────────────────────────────────────────

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  ✅ BATCH COMMITTED                                      ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  Events     : ${count}`);
  console.log(`  Batch #    : ${onChainBatchId.toString()}  (on-chain)`);
  console.log(`  Batch UUID : ${batchUUID}  (Supabase)`);
  console.log(`  Root       : ${merkleRoot}`);
  console.log(`  TX         : ${tx.hash}`);
  console.log(`  Block      : ${receipt.blockNumber}`);
  console.log('');
  console.log('  Anyone can verify an event with:');
  console.log(`  RezoningOracle.verify(leafHash, proof, ${onChainBatchId.toString()})`);
  console.log(`  Contract: ${CONTRACT_ADDR}`);

  await pool.end();
}

run().catch(async err => {
  console.error('\n❌ Processor failed:', err.message || err);
  // Mark any in-progress 'pending' batch as 'failed' so it doesn't block future runs
  try {
    await pool.query(
      `UPDATE merkle_batches SET status = 'failed', error_message = $1
       WHERE status = 'pending' AND committed_at IS NULL`,
      [err.message?.slice(0, 500) || 'unknown error']
    );
  } catch { /* ignore cleanup failure */ }
  await pool.end().catch(() => {});
  process.exit(1);
});
