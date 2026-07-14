#!/usr/bin/env node
/**
 * ZoneProof Oracle MCP Server — Flow B (Agentic)
 *
 * Exposes parcel query tools to any MCP-compatible LLM (Claude, etc).
 * When the oracle returns HTTP 402, this server autonomously pays HBAR
 * using the app's Hedera account and retries — no human action required.
 *
 * Tools:
 *   query_parcel(pin)   — full rezoning history + on-chain proof
 *   verify_zoning(pin)  — returns the Hedera TX hash for the latest commit
 *
 * Usage (stdio transport, add to Claude Code config):
 *   node /path/to/server.js
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  Client,
  AccountId,
  PrivateKey,
  Hbar,
  TransferTransaction,
} from "@hashgraph/sdk";
import { JsonRpcProvider } from "ethers";
import fetch from "node-fetch";
import { Buffer } from "buffer";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

// ── Config ────────────────────────────────────────────────────────────────────
const ORACLE_URL  = process.env.ORACLE_URL         || "http://localhost:8001";
const ACCOUNT_ID  = process.env.HEDERA_ACCOUNT_ID;
const PRIVATE_KEY = process.env.HEDERA_PRIVATE_KEY;
const NETWORK     = process.env.HEDERA_NETWORK     || "testnet";

if (!ACCOUNT_ID || !PRIVATE_KEY) {
  process.stderr.write("ERROR: HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY must be set in oracle/.env\n");
  process.exit(1);
}

// ── Hedera client (app wallet — pays on behalf of agent) ──────────────────────
const hederaClient = NETWORK === "mainnet"
  ? Client.forMainnet()
  : Client.forTestnet();

hederaClient.setOperator(
  AccountId.fromString(ACCOUNT_ID),
  PrivateKey.fromStringECDSA(PRIVATE_KEY)
);

// ── ENS resolver ──────────────────────────────────────────────────────────────
// Supports both Ethereum mainnet and Sepolia testnet (free).
// Set ETH_NETWORK=sepolia in oracle/.env to use Sepolia — no cost, no wallet needed.
const ETH_NETWORK = process.env.ETH_NETWORK || "mainnet";
const ETH_RPC = process.env.ETH_RPC_URL || (
  ETH_NETWORK === "sepolia"
    ? "https://ethereum-sepolia-rpc.publicnode.com"
    : "https://cloudflare-eth.com"
);
const ethProvider = new JsonRpcProvider(ETH_RPC);
process.stderr.write(`[ens] Using ${ETH_NETWORK} ENS via ${ETH_RPC}\n`);

/**
 * Demo ENS → PIN mappings for local development.
 * Real users would set these as ENS text records on their own names.
 *
 * To set a real text record (in ENS app or ethers.js):
 *   key:   "parcel.pin"
 *   value: "0768487494"
 */
const DEMO_ENS_MAP = {
  // Sepolia-registered names
  "manoj.eth":           { pin: "0768487494", address: "7850 BRIER CREEK PKWY, RALEIGH NC" },
  "manuj.eth":           { pin: "0768487494", address: "7850 BRIER CREEK PKWY, RALEIGH NC" },
  "manujsrinivasa.eth":  { pin: "0768487494", address: "7850 BRIER CREEK PKWY, RALEIGH NC" },
  "zoneproof.eth":       { pin: "0768487494", address: "7850 BRIER CREEK PKWY, RALEIGH NC" },
  // Fallbacks
  "jonumhills.eth":      { pin: "0768487494", address: "7850 BRIER CREEK PKWY, RALEIGH NC" },
  "briercreek.eth":      { pin: "0768487494", address: "7850 BRIER CREEK PKWY, RALEIGH NC" },
};

/**
 * Resolve an ENS name to parcel data via Ethereum mainnet text records.
 * Text records checked (in order):
 *   1. parcel.pin      — direct 10-digit PIN
 *   2. parcel.address  — street address to look up
 *   3. url             — informational only
 */
async function resolveEnsToParcel(rawName) {
  const name = rawName.toLowerCase().trim();
  const ensName = name.endsWith(".eth") ? name : `${name}.eth`;

  // Demo mapping (no on-chain lookup needed for testing)
  const demo = DEMO_ENS_MAP[ensName];
  if (demo) {
    return { source: "demo", ensName, ...demo };
  }

  // Real ENS resolution via Ethereum mainnet
  process.stderr.write(`[ens] Resolving ${ensName} via ${ETH_RPC}\n`);
  try {
    const resolver = await ethProvider.getResolver(ensName);
    if (!resolver) {
      return { source: "ens", ensName, error: `${ensName} is not registered or has no resolver set.` };
    }

    const [address, pin1, pin2, parcelAddress1, parcelAddress2, url] = await Promise.all([
      resolver.getAddress().catch(() => null),
      resolver.getText("parcel.pin").catch(() => null),    // canonical form
      resolver.getText("parcelpin").catch(() => null),     // ENS apps sometimes strip dots
      resolver.getText("parcel.address").catch(() => null),
      resolver.getText("parceladdress").catch(() => null),
      resolver.getText("url").catch(() => null),
    ]);
    const pin           = pin1 || pin2;
    const parcelAddress = parcelAddress1 || parcelAddress2;

    return { source: "ens", ensName, address, pin, parcelAddress, url };
  } catch (err) {
    return { source: "ens", ensName, error: `ENS lookup failed: ${err.message}` };
  }
}

// ── x402 payment helper ────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Calls `url`, detects HTTP 402, pays HBAR autonomously, then retries.
 * Returns the final Response object.
 */
async function fetchWithX402Payment(url) {
  // First attempt — no payment header
  let res = await fetch(url);

  if (res.status !== 402) return res;

  // Parse payment instructions from 402 body
  const body = await res.json();
  const accept = body.accepts?.[0];
  if (!accept) throw new Error("402 response missing accepts array");

  const receiver   = accept.payTo;
  const tinybars   = parseInt(accept.maxAmountRequired, 10);
  const hbarAmount = tinybars / 100_000_000;

  process.stderr.write(`[x402] Paying ${hbarAmount} HBAR → ${receiver} for ${url}\n`);

  // Execute HBAR transfer from app wallet
  const txResponse = await new TransferTransaction()
    .addHbarTransfer(AccountId.fromString(receiver),   Hbar.fromTinybars(tinybars))
    .addHbarTransfer(AccountId.fromString(ACCOUNT_ID), Hbar.fromTinybars(-tinybars))
    .setTransactionMemo("zoneproof-oracle-x402")
    .execute(hederaClient);

  const receipt = await txResponse.getReceipt(hederaClient);
  if (receipt.status.toString() !== "SUCCESS") {
    throw new Error(`Hedera payment failed: ${receipt.status}`);
  }

  const txId = txResponse.transactionId.toString();
  process.stderr.write(`[x402] Payment confirmed: ${txId}\n`);

  // Wait for mirror node to index the transaction before the oracle queries it
  await sleep(4000);

  // Encode payment proof and retry (with mirror-node-aware retries)
  const paymentHeader = Buffer.from(
    JSON.stringify({ txId, network: NETWORK, scheme: "hedera-hbar" })
  ).toString("base64");

  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(url, { headers: { "X-Payment": paymentHeader } });
    if (res.status !== 402) break;
    if (attempt < 2) await sleep(3000);
  }
  return res;
}

// ── MCP Server ────────────────────────────────────────────────────────────────
const server = new McpServer({
  name: "zoneproof-oracle",
  version: "1.0.0",
});

// Tool 0a: ENS name → parcel lookup (free, no payment)
server.tool(
  "lookup_ens",
  [
    "Resolve an ENS (.eth) name to a Wake County parcel for due diligence.",
    "Reads 'parcel.pin' and 'parcel.address' text records from Ethereum mainnet ENS.",
    "Use this when the user gives an ENS name like 'alice.eth' or 'briercreek.eth'.",
    "After resolving the PIN, call query_parcel(pin) to get the full report (pays 0.05 HBAR).",
  ].join(" "),
  {
    ens_name: z.string().describe("ENS name, e.g. 'briercreek.eth' or 'alice.eth'"),
  },
  async ({ ens_name }) => {
    const result = await resolveEnsToParcel(ens_name);
    const ensName = result.ensName;

    if (result.error) {
      return {
        content: [{
          type: "text",
          text: [
            `ENS resolution failed for ${ensName}: ${result.error}`,
            "",
            "To link an ENS name to a Wake County parcel, the owner must set these text records via app.ens.domains:",
            "  key: parcel.pin    → value: <10-digit PIN>",
            "  key: parcel.address → value: <street address>",
          ].join("\n"),
        }],
      };
    }

    // Best case: parcel.pin text record set directly
    if (result.pin) {
      return {
        content: [{
          type: "text",
          text: [
            `ENS resolved: ${ensName}`,
            `Source: ${result.source === "demo" ? "demo mapping (local)" : "ENS text record on Ethereum mainnet"}`,
            result.address ? `Address: ${result.address}` : "",
            result.address_eth ? `ETH address: ${result.address_eth}` : "",
            `Parcel PIN: ${result.pin}`,
            "",
            `Ready — call query_parcel("${result.pin}") to fetch the full due diligence report.`,
            `The agent will autonomously pay 0.05 HBAR via x402 to unlock the data.`,
          ].filter(Boolean).join("\n"),
        }],
      };
    }

    // Fallback: parcel.address text record
    if (result.parcelAddress) {
      return {
        content: [{
          type: "text",
          text: [
            `ENS resolved: ${ensName}`,
            `parcel.address text record found: "${result.parcelAddress}"`,
            "",
            `Call lookup_address("${result.parcelAddress}") to get the PIN, then query_parcel(pin).`,
          ].join("\n"),
        }],
      };
    }

    // ENS resolves to an address but no parcel text records
    return {
      content: [{
        type: "text",
        text: [
          `ENS resolved: ${ensName} → ${result.address || "no ETH address"}`,
          "",
          "No parcel data found in ENS text records.",
          "The owner has not linked this ENS name to a Wake County parcel yet.",
          "",
          "To link this ENS name to a parcel, set these text records at app.ens.domains:",
          "  parcel.pin     → <10-digit Wake County PIN>",
          "  parcel.address → <street address>",
        ].join("\n"),
      }],
    };
  }
);

// Tool 0b: Street address → PIN lookup (free, no payment)
server.tool(
  "lookup_address",
  [
    "Look up a Wake County parcel by street address (free, no payment required).",
    "Returns the 10-digit PIN and basic parcel info.",
    "Use this FIRST when the user provides an address instead of a PIN.",
    "Then call query_parcel(pin) with the returned PIN to get the full due diligence report.",
  ].join(" "),
  {
    address: z.string().describe("Street address in Wake County NC, e.g. '7850 BRIER CREEK PKWY'"),
  },
  async ({ address }) => {
    try {
      // Search parcels.json in-memory via the oracle search endpoint
      const url = `${ORACLE_URL}/api/oracle/parcels/search?address=${encodeURIComponent(address)}`;
      const res = await fetch(url);
      if (res.status === 404 || res.status === 405) {
        // Fallback: hint the agent to use the parcel PIN directly
        return {
          content: [{
            type: "text",
            text: `Address search not available via API. Ask the user for the 10-digit PIN for "${address}", or search at https://www.wake.gov/departments-government/tax-administration/data-files-statistics-and-records/real-estate-data`,
          }],
        };
      }
      if (!res.ok) throw new Error(`Search returned ${res.status}`);
      const data = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Address lookup failed: ${err.message}` }] };
    }
  }
);

// Tool 1: Full rezoning history
server.tool(
  "query_parcel",
  [
    "Query the full rezoning history for a Raleigh NC parcel by PIN.",
    "Returns current zoning, all past petitions, and Hedera on-chain proof hashes.",
    "Automatically pays 0.05 HBAR via Hedera x402 — no user action needed.",
  ].join(" "),
  {
    pin: z.string().describe("10-digit Parcel Identification Number (PIN), e.g. 0768487494"),
  },
  async ({ pin }) => {
    const url = `${ORACLE_URL}/api/oracle/parcels/${encodeURIComponent(pin)}/history`;

    try {
      const res = await fetchWithX402Payment(url);

      if (res.status === 404) {
        return {
          content: [{ type: "text", text: `No rezoning history found for PIN ${pin}. This parcel has no recorded petitions on ZoneProof.` }],
        };
      }

      if (!res.ok) {
        const text = await res.text();
        return {
          content: [{ type: "text", text: `Oracle error ${res.status}: ${text}` }],
        };
      }

      const data = await res.json();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };

    } catch (err) {
      return {
        content: [{ type: "text", text: `Error querying parcel: ${err.message}` }],
      };
    }
  }
);

// Tool 2: On-chain proof only
server.tool(
  "verify_zoning",
  [
    "Get the on-chain Hedera proof for a parcel's latest zoning commitment.",
    "Returns the Hedera EVM transaction hash, block number, and batch ID.",
    "Use this to verify a zoning record is tamper-proof on Hedera.",
  ].join(" "),
  {
    pin: z.string().describe("10-digit Parcel Identification Number (PIN)"),
  },
  async ({ pin }) => {
    const url = `${ORACLE_URL}/api/oracle/parcels/${encodeURIComponent(pin)}/history`;

    try {
      const res = await fetchWithX402Payment(url);

      if (res.status === 404) {
        return {
          content: [{ type: "text", text: `No data found for PIN ${pin}.` }],
        };
      }

      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Oracle error ${res.status}` }],
        };
      }

      const data = await res.json();
      const onChain = (data.rezoning_history || []).filter(r => r.committed_at);

      if (!onChain.length) {
        return {
          content: [{ type: "text", text: `PIN ${pin} has no on-chain zoning records yet.` }],
        };
      }

      const latest = onChain[0];
      const proof = {
        pin,
        address:        data.parcel?.site_address,
        petition:       latest.petition_number,
        zoning_from:    latest.current_zoning,
        zoning_to:      latest.proposed_zoning,
        committed_at:   latest.committed_at,
        hedera_tx_hash: latest.hedera_evm_tx_hash,
        hedera_block:   latest.hedera_evm_block,
        batch_id:       latest.batch_id,
        verified:       !!latest.hedera_evm_tx_hash,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(proof, null, 2) }],
      };

    } catch (err) {
      return {
        content: [{ type: "text", text: `Error verifying zoning: ${err.message}` }],
      };
    }
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("ZoneProof Oracle MCP server ready (stdio)\n");
