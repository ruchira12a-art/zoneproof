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

// ── MCP Server ────────────────────────────────────────────────────────────────
const server = new McpServer({
  name: "zoneproof-oracle",
  version: "1.0.0",
});

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
