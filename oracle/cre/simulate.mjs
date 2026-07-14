/**
 * oracle/cre/simulate.mjs
 *
 * Local 3-node Chainlink DON simulation.
 *
 * Simulates what happens when workflow.ts runs on a real Chainlink DON:
 *   - 3 independent "nodes" each fetch pending events from the oracle API
 *   - Each independently computes SHA-256 leaf hashes + Merkle root
 *   - BFT vote: 2/3 threshold (2 out of 3 nodes must agree on root)
 *   - Elected node submits commitBatch() to RezoningOracle.sol on Hedera
 *   - DB updated: change_events marked committed, merkle_batches row written
 *
 * Usage:
 *   cd oracle/cre && npm install && npm run simulate
 */

import { ethers }        from "ethers"
import pg                from "pg"
import dotenv            from "dotenv"
import { fileURLToPath } from "url"
import { dirname, join } from "path"
import { readFileSync }  from "fs"
import { createHash }    from "crypto"

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)

dotenv.config({ path: join(__dirname, "../.env") })

// ── Config ─────────────────────────────────────────────────────────────────────

const config = JSON.parse(
  readFileSync(join(__dirname, "config.json"), "utf8")
)

const PRIV_KEY  = process.env.HEDERA_PRIVATE_KEY
const GAS_PRICE = 1_140_000_000_000n  // Hedera testnet minimum (1140 Gwei)
const GAS_LIMIT = 4_000_000
const MAX_PINS  = 50                   // cap to stay within gas limit

const artifact = JSON.parse(
  readFileSync(
    join(__dirname, "../contracts/artifacts/src/RezoningOracle.sol/RezoningOracle.json"),
    "utf8"
  )
)
const ABI = artifact.abi

const { Pool } = pg
const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     parseInt(process.env.DB_PORT || "5432"),
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl:      { rejectUnauthorized: false },
  max:      3,
})

// ── Merkle helpers (same algorithm as processor.mjs and workflow.ts) ───────────

function buildMerkleTree(leaves) {
  if (leaves.length === 0) throw new Error("No leaves")
  let level = [...leaves]
  const tree = [level]
  while (level.length > 1) {
    const next = []
    for (let i = 0; i < level.length; i += 2) {
      const left  = level[i]
      const right = i + 1 < level.length ? level[i + 1] : level[i]
      const [a, b] = left <= right ? [left, right] : [right, left]
      next.push(ethers.keccak256(ethers.concat([a, b])))
    }
    level = next
    tree.push(level)
  }
  return { root: level[0], tree }
}

function getMerkleProof(tree, leafIndex) {
  const proof = []
  let idx = leafIndex
  for (let i = 0; i < tree.length - 1; i++) {
    const sibling = idx % 2 === 0 ? idx + 1 : idx - 1
    if (sibling < tree[i].length) proof.push(tree[i][sibling])
    idx = Math.floor(idx / 2)
  }
  return proof
}

// ── Hedera fallback receipt polling ───────────────────────────────────────────

async function pollHederaReceipt(txHash, maxAttempts = 20, delayMs = 5000) {
  const url = `https://testnet.mirrornode.hedera.com/api/v1/contracts/results/${txHash}`
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, delayMs))
    const r = await fetch(url)
    if (!r.ok) { process.stdout.write("."); continue }
    const data = await r.json()
    if (data.result === "SUCCESS") {
      return { hash: txHash, blockNumber: data.block_number, gasUsed: data.gas_used, logs: [] }
    }
    if (data.result && data.result !== "SUCCESS") throw new Error(`TX failed: ${data.result}`)
    process.stdout.write(".")
  }
  throw new Error(`TX not confirmed after ${maxAttempts * delayMs / 1000}s`)
}

// ── Single node execution ──────────────────────────────────────────────────────

/**
 * Simulates one CRE node:
 *   1. Fetch pending events from oracle API
 *   2. Compute SHA-256 leaf hashes (same as Python API's _leaf_hash)
 *   3. Build Merkle tree
 *   4. Return root + events (doesn't write anything)
 */
async function runNode(nodeId) {
  const tag = `[Node ${nodeId}]`
  console.log(`${tag} Fetching pending events from oracle API...`)

  const resp = await fetch(
    `${config.apiUrl}/api/oracle/pending-events?limit=${config.batchSize}`
  )
  if (!resp.ok) throw new Error(`${tag} API error ${resp.status}`)

  const body    = await resp.json()
  const events  = (body.events || []).slice(0, config.batchSize)
  const count   = events.length

  console.log(`${tag} Got ${count} events (total pending: ${body.count})`)

  if (count === 0) {
    return { nodeId, root: null, events: [], leaves: [], tree: null }
  }

  const leaves            = events.map(e => e.leaf_hash)
  const { root, tree }    = buildMerkleTree(leaves)

  console.log(`${tag} Computed root: ${root}`)

  return { nodeId, root, events, leaves, tree }
}

// ── BFT consensus ─────────────────────────────────────────────────────────────

/**
 * Given N node results, find the Merkle root that >= threshold fraction agree on.
 * threshold = config.consensusThreshold (default 0.67 = 2/3)
 */
function reachConsensus(nodeResults) {
  const nonEmpty = nodeResults.filter(n => n.root !== null)

  if (nonEmpty.length === 0) return { consensusRoot: null, agreement: 0 }

  const counts = new Map()
  for (const { root } of nonEmpty) {
    counts.set(root, (counts.get(root) || 0) + 1)
  }

  const total     = nodeResults.length
  const threshold = config.consensusThreshold

  for (const [root, count] of counts.entries()) {
    if (count / total >= threshold) {
      return { consensusRoot: root, agreement: count, total, threshold }
    }
  }

  return { consensusRoot: null, agreement: 0, total, counts: Object.fromEntries(counts) }
}

// ── On-chain commit (runs after consensus) ────────────────────────────────────

async function commitToHedera({ events, leaves, tree, merkleRoot, batchUUID }) {
  const count = events.length

  // Collect unique PINs → pinHashes
  const pinMap = new Map()
  for (const ev of events) {
    const petition = ev.petition_number || ""
    if (ev.pin) pinMap.set(ev.pin, petition)
    if (Array.isArray(ev.affected_pins)) {
      for (const p of ev.affected_pins) if (p) pinMap.set(String(p), petition)
    }
  }
  const capped         = Array.from(pinMap.entries()).slice(0, MAX_PINS)
  const pinHashes      = capped.map(([p]) => ethers.keccak256(ethers.toUtf8Bytes(p)))
  const petitionNumbers = capped.map(([, pet]) => pet)

  console.log(
    `  Unique PINs: ${pinMap.size}  →  storing ${pinHashes.length} on-chain` +
    (pinMap.size > MAX_PINS ? ` (capped at ${MAX_PINS})` : "")
  )

  // Connect to Hedera
  const hederaNet  = ethers.Network.from(config.hederaChainId)
  const provider   = new ethers.JsonRpcProvider(config.hederaRpc, hederaNet, { staticNetwork: hederaNet })
  const wallet     = new ethers.Wallet(PRIV_KEY, provider)
  const contract   = new ethers.Contract(config.contractAddress, ABI, wallet)

  console.log(`  Submitting commitBatch() to Hedera EVM (chain ${config.hederaChainId})...`)

  // Retry up to 4 times — Hedera's hashio relay returns 502 intermittently
  let tx
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      tx = await contract.commitBatch(
        merkleRoot,
        BigInt(count),
        0n,
        BigInt(count - 1),
        config.countyId,
        pinHashes,
        petitionNumbers,
        { gasLimit: GAS_LIMIT, gasPrice: GAS_PRICE }
      )
      break
    } catch (sendErr) {
      const is502 = sendErr.message?.includes("502") || sendErr.code === "SERVER_ERROR"
      if (!is502 || attempt === 4) throw sendErr
      const delay = attempt * 8_000
      console.log(`  Send attempt ${attempt} got 502 — retrying in ${delay / 1000}s...`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
  console.log(`  TX hash: ${tx.hash}`)
  console.log("  Waiting for confirmation...")

  let receipt
  try {
    receipt = await tx.wait(1)
  } catch (waitErr) {
    console.warn(`  wait() threw (${waitErr.message}) — polling mirror node...`)
    receipt = await pollHederaReceipt(tx.hash)
    console.log("")
  }

  // Parse on-chain batch ID from BatchCommitted event
  let onChainBatchId = null
  for (const log of (receipt.logs || [])) {
    try {
      const parsed = contract.interface.parseLog(log)
      if (parsed?.name === "BatchCommitted") { onChainBatchId = parsed.args.batchId; break }
    } catch { /* not our event */ }
  }
  if (onChainBatchId === null) {
    const currentCount = await contract.batchCount()
    onChainBatchId = currentCount - 1n
  }

  return { tx, receipt, onChainBatchId }
}

// ── DB commit ─────────────────────────────────────────────────────────────────

async function commitToDB({ events, leaves, tree, merkleRoot, batchUUID, tx, receipt, onChainBatchId }) {
  const count    = events.length
  const treeDepth = tree.length - 1

  await pool.query(
    `INSERT INTO merkle_batches
       (batch_id, merkle_root, tree_depth, leaf_count, changes_count, status,
        hedera_evm_tx_hash, hedera_evm_block, snapshot_index, committed_at)
     VALUES ($1,$2,$3,$4,$5,'committed',$6,$7,$8,NOW())`,
    [batchUUID, merkleRoot, treeDepth, count, count,
     tx.hash, receipt.blockNumber, onChainBatchId.toString()]
  )

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
    [events.map(e => e.id), batchUUID, onChainBatchId.toString(), leaves]
  )
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function run() {
  console.log("╔════════════════════════════════════════════════════╗")
  console.log("║   Rezoning Oracle — 3-Node DON Simulation          ║")
  console.log("╚════════════════════════════════════════════════════╝")
  console.log(`Contract  : ${config.contractAddress}`)
  console.log(`API       : ${config.apiUrl}`)
  console.log(`Consensus : ${config.consensusThreshold * 100}% threshold (${Math.ceil(3 * config.consensusThreshold)}/3 nodes)`)
  console.log("")

  if (!PRIV_KEY) throw new Error("HEDERA_PRIVATE_KEY not set in oracle/.env")

  // ── Phase 1: All 3 nodes fetch + compute independently ──────────────────

  console.log("━━━ Phase 1: Node Computation (parallel) ━━━━━━━━━━━━")
  const nodeResults = await Promise.all([
    runNode(1),
    runNode(2),
    runNode(3),
  ])
  console.log("")

  // ── Phase 2: BFT consensus vote ──────────────────────────────────────────

  console.log("━━━ Phase 2: BFT Consensus Vote ━━━━━━━━━━━━━━━━━━━━━")
  for (const { nodeId, root } of nodeResults) {
    console.log(`  Node ${nodeId}: ${root ?? "(no pending events)"}`)
  }
  console.log("")

  const { consensusRoot, agreement, total, counts } = reachConsensus(nodeResults)

  if (!consensusRoot) {
    console.error("❌ No consensus reached!")
    console.error("   Node roots:", counts)
    console.error("   This means nodes saw different data — possible API manipulation or race condition.")
    await pool.end()
    return
  }

  console.log(`✅ Consensus reached: ${agreement}/${total} nodes agree`)
  console.log(`   Root: ${consensusRoot}`)
  console.log("")

  // Find the elected node (first that agreed on consensus root)
  const electedNode = nodeResults.find(n => n.root === consensusRoot)
  const { events, leaves, tree } = electedNode

  if (events.length === 0) {
    console.log("No pending events. Nothing to commit.")
    await pool.end()
    return
  }

  // ── Phase 3: Elected node submits to Hedera ───────────────────────────────

  console.log(`━━━ Phase 3: Node ${electedNode.nodeId} Submits to Hedera ━━━━━━━━━━`)
  const batchUUID = crypto.randomUUID()
  console.log(`  DB batch UUID : ${batchUUID}`)
  console.log(`  Events        : ${events.length}`)
  console.log(`  Merkle depth  : ${tree.length - 1}`)
  console.log("")

  const { tx, receipt, onChainBatchId } = await commitToHedera({
    events, leaves, tree, merkleRoot: consensusRoot, batchUUID
  })

  console.log(`  On-chain batch ID : ${onChainBatchId.toString()}`)
  console.log(`  Block             : ${receipt.blockNumber}`)
  console.log(`  Gas used          : ${receipt.gasUsed?.toString()}`)
  console.log("")

  // ── Phase 4: Write back to DB ────────────────────────────────────────────

  console.log("━━━ Phase 4: DB Commit ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  await commitToDB({ events, leaves, tree, merkleRoot: consensusRoot, batchUUID, tx, receipt, onChainBatchId })
  console.log(`  ${events.length} events marked committed`)
  console.log("")

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log("╔════════════════════════════════════════════════════════════╗")
  console.log("║  ✅ DON BATCH COMMITTED                                    ║")
  console.log("╚════════════════════════════════════════════════════════════╝")
  console.log(`  Nodes agreed    : ${agreement}/${total}`)
  console.log(`  Events          : ${events.length}`)
  console.log(`  On-chain batch# : ${onChainBatchId.toString()}`)
  console.log(`  Merkle root     : ${consensusRoot}`)
  console.log(`  TX              : ${tx.hash}`)
  console.log(`  Block           : ${receipt.blockNumber}`)
  console.log("")
  console.log("  Verify any event:")
  console.log(`    contract.verify(leafHash, proof, ${onChainBatchId.toString()})`)
  console.log(`    contract: ${config.contractAddress}`)

  await pool.end()
}

run().catch(async err => {
  console.error("\n❌ Simulation failed:", err.message || err)
  try {
    await pool.query(
      `UPDATE merkle_batches SET status='failed', error_message=$1
       WHERE status='pending' AND committed_at IS NULL`,
      [err.message?.slice(0, 500) || "unknown"]
    )
  } catch { /* ignore */ }
  await pool.end().catch(() => {})
  process.exit(1)
})
