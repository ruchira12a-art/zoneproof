/**
 * Rezoning Oracle — Chainlink CRE Workflow
 * ZoneProof rezoning oracle
 *
 * Architecture:
 *   CRE node (this file)
 *     → fetches pending rezoning events from Townhall oracle API
 *     → computes Merkle tree
 *     → POSTs root to bridge server (localhost:3000)
 *   Bridge server (oracle/cre/bridge/server.js)
 *     → receives the root
 *     → calls RezoningOracle.commitBatch() on Hedera EVM
 *     → marks change_events as committed in Supabase
 *
 * Why a bridge?
 *   Hedera EVM (chain 296) is not yet a native CRE EVM target.
 *   CRE can make HTTP calls, so we route through the bridge server
 *   which holds the Hedera signer.
 *
 * Run simulation:
 *   # Terminal 1: start bridge server
 *   cd oracle/cre/bridge && npm start
 *
 *   # Terminal 2: run CRE workflow
 *   cd oracle/cre
 *   ~/.cre/bin/cre workflow simulate ./rezoning-oracle -T staging -R . -e .env
 */

import { cre, Runner } from "@chainlink/cre-sdk";
import { MerkleTree } from "merkletreejs";
import { keccak256 as viemKeccak256, toHex } from "viem";

// ── Config ────────────────────────────────────────────────────────────────────

type Config = {
  oracleApiUrl: string;   // Townhall oracle API, e.g. "http://localhost:8001"
  bridgeUrl:    string;   // Hedera bridge server, e.g. "http://localhost:3000"
  countyId:     string;   // "raleigh_nc"
  batchSize:    number;   // max events per commit (100 default)
};

// ── Merkle helpers ────────────────────────────────────────────────────────────

/**
 * keccak256 that returns Buffer — required by merkletreejs.
 * Matches the hash function used in RezoningOracle.sol _verifyProof.
 */
function keccak256Buffer(data: Buffer): Buffer {
  const hex = viemKeccak256(toHex(data));
  return Buffer.from(hex.slice(2), "hex");
}

// ── Cron trigger handler ──────────────────────────────────────────────────────

const onCronTrigger = (runtime: any, _payload: any): string => {
  runtime.log("=".repeat(70));
  runtime.log("REZONING ORACLE — Chainlink CRE Workflow");
  runtime.log("=".repeat(70));

  try {
    const httpClient = new cre.capabilities.HTTPClient();

    // ── 1. Fetch pending rezoning events from oracle API ────────────────────

    runtime.log(`\nFetching pending events from ${runtime.config.oracleApiUrl}...`);

    const eventsResponse = httpClient
      .sendRequest(runtime, {
        method: "GET",
        url: `${runtime.config.oracleApiUrl}/api/oracle/pending-events?limit=${runtime.config.batchSize}`,
        headers: { "Content-Type": "application/json" },
      })
      .result();

    const eventsText  = Buffer.from(eventsResponse.body).toString("utf-8");
    const eventsBody  = JSON.parse(eventsText) as {
      count: number;
      events: Array<{ id: string; leaf_hash: string; petition_number?: string }>;
    };

    const events = eventsBody.events.slice(0, runtime.config.batchSize);
    const count  = events.length;

    runtime.log(`✅ Received ${count} pending events (total: ${eventsBody.count})`);

    if (count === 0) {
      runtime.log("No pending events. Nothing to commit.");
      return "No pending events";
    }

    // ── 2. Build Merkle tree ─────────────────────────────────────────────────

    runtime.log(`\n🌳 Building Merkle tree from ${count} leaf hashes...`);

    // Leaves are the pre-computed SHA-256 leaf_hash values from the oracle API.
    // hashLeaves: false  — leaves are already hashed; don't double-hash them.
    // sortPairs: true    — sort sibling pairs before hashing (deterministic,
    //                      matches RezoningOracle.sol _verifyProof).
    const leaves = events.map((e) => Buffer.from(e.leaf_hash.slice(2), "hex"));

    const tree        = new MerkleTree(leaves, keccak256Buffer, {
      sortPairs:  true,
      hashLeaves: false,
    });
    const merkleRoot  = tree.getHexRoot();

    runtime.log(`✅ Merkle root: ${merkleRoot}`);
    runtime.log(`   Tree depth:  ${tree.getDepth()}`);
    runtime.log(`   Leaves:      ${leaves.length}`);

    // ── 3. POST root to bridge server → bridge writes to Hedera ─────────────

    runtime.log(`\n📡 Sending root to Hedera bridge at ${runtime.config.bridgeUrl}...`);

    const payload = {
      merkleRoot,
      leafCount:    count,
      eventIds:     events.map((e) => e.id),
      countyId:     runtime.config.countyId,
    };

    let bridgeResponse;
    try {
      bridgeResponse = httpClient
        .sendRequest(runtime, {
          method: "POST",
          url:    `${runtime.config.bridgeUrl}/commit-batch`,
          headers: { "Content-Type": "application/json" },
          body:   Buffer.from(JSON.stringify(payload)).toString("base64"),
        })
        .result();
    } catch (bridgeErr) {
      runtime.log(`⚠️  Bridge request failed: ${bridgeErr}`);
      runtime.log(
        `   Make sure bridge server is running: cd oracle/cre/bridge && npm start`
      );
      return `Bridge error: ${bridgeErr}`;
    }

    const bridgeText   = Buffer.from(bridgeResponse.body).toString("utf-8");
    const bridgeResult = JSON.parse(bridgeText);

    if (bridgeResult.success) {
      runtime.log(`✅ Merkle root committed to Hedera!`);
      runtime.log(`   TX hash:   ${bridgeResult.transaction?.hash}`);
      runtime.log(`   Block:     ${bridgeResult.transaction?.blockNumber}`);
      runtime.log(`   Batch ID:  ${bridgeResult.onChainBatchId}`);
      runtime.log(
        `   Explorer:  https://hashscan.io/testnet/transaction/${bridgeResult.transaction?.hash}`
      );
    } else {
      runtime.log(`⚠️  Bridge returned failure: ${bridgeResult.error}`);
    }

    // ── Done ──────────────────────────────────────────────────────────────────

    runtime.log("=".repeat(70));
    runtime.log("✅ WORKFLOW COMPLETE");
    runtime.log(`   Events committed: ${count}`);
    runtime.log(`   Merkle root:      ${merkleRoot}`);
    runtime.log("=".repeat(70));

    return `Committed ${count} events — root: ${merkleRoot}`;

  } catch (err) {
    runtime.log(`❌ Workflow error: ${err}`);
    return `Error: ${err}`;
  }
};

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const initWorkflow = (_config: Config) => {
  const cronCapability = new cre.capabilities.CronCapability();

  return [
    cre.handler(
      cronCapability.trigger({ schedule: "0 * * * *" }),  // every hour
      onCronTrigger,
    ),
  ];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}

main();
