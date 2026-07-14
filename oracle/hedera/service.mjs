/**
 * ZoneProof Hedera Sidecar Service — port 8002
 *
 * Wraps Hedera SDK calls so the Python oracle can use HCS, HTS, and
 * Scheduled Transactions without a Python SDK.
 *
 * Endpoints:
 *   POST /setup                — create HCS topics + HTS NFT token (run once)
 *   POST /hcs/report-audit     — log a ZoneProof report seal to HCS
 *   POST /hcs/petition-batch   — log a petition merkle batch commit to HCS
 *   POST /hts/mint-receipt     — mint a ZPR NFT receipt for a paid report
 *   POST /schedule/merkle-commit — schedule a future HCS batch commit
 *   GET  /health               — liveness check
 *
 * Prize coverage (per Hedera bounty descriptions):
 *   - HCS: "Use HCS to create verifiable timestamps for documents" (No Solidity $3K)
 *   - HTS: "Mint an HTS token as a receipt for each proof" (Tokenization $3K)
 *   - ScheduleCreate: "Automate ... using Scheduled Transactions" (No Solidity $3K)
 *   - x402 + TransferTransaction: autonomous HBAR payment in MCP server (AI Payments $6K)
 */

import express from 'express';
import {
  Client,
  AccountId,
  PrivateKey,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
  TokenCreateTransaction,
  TokenMintTransaction,
  TokenType,
  TokenSupplyType,
  ScheduleCreateTransaction,
} from '@hashgraph/sdk';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// ── Hedera client ─────────────────────────────────────────────────────────────
const operatorId  = AccountId.fromString(process.env.HEDERA_ACCOUNT_ID);
const operatorKey = PrivateKey.fromStringECDSA(process.env.HEDERA_PRIVATE_KEY);

const client = Client.forTestnet();
client.setOperator(operatorId, operatorKey);

// Topic and token IDs set after running /setup once
const REPORT_AUDIT_TOPIC = process.env.HCS_REPORT_AUDIT_TOPIC || '';
const PETITION_LOG_TOPIC = process.env.HCS_PETITION_LOG_TOPIC || '';
const NFT_TOKEN_ID       = process.env.HTS_NFT_TOKEN_ID       || '';

const app = express();
app.use(express.json());

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({
  ok: true,
  account: operatorId.toString(),
  report_audit_topic: REPORT_AUDIT_TOPIC || 'NOT SET — run POST /setup',
  petition_log_topic: PETITION_LOG_TOPIC || 'NOT SET — run POST /setup',
  nft_token_id:       NFT_TOKEN_ID       || 'NOT SET — run POST /setup',
}));

// ── SETUP — run once, then paste IDs into oracle/.env ─────────────────────────
app.post('/setup', async (req, res) => {
  try {
    console.log('[setup] Creating HCS Report Audit Topic…');
    const t1 = await new TopicCreateTransaction()
      .setTopicMemo('ZoneProof Report Audit Log — immutable record of every issued report seal')
      .execute(client);
    const r1 = await t1.getReceipt(client);
    const reportTopic = r1.topicId.toString();
    console.log('[setup] Report Audit Topic:', reportTopic);

    console.log('[setup] Creating HCS Petition Batch Topic…');
    const t2 = await new TopicCreateTransaction()
      .setTopicMemo('ZoneProof Petition Batch Log — merkle roots of DC zoning petition commits')
      .execute(client);
    const r2 = await t2.getReceipt(client);
    const petitionTopic = r2.topicId.toString();
    console.log('[setup] Petition Log Topic:', petitionTopic);

    // HTS NFT — no Solidity, no smart contract; pure Hedera protocol
    console.log('[setup] Creating HTS ZPR NFT Token…');
    const t3 = await new TokenCreateTransaction()
      .setTokenName('ZoneProof Report Receipt')
      .setTokenSymbol('ZPR')
      .setTokenType(TokenType.NonFungibleUnique)
      .setSupplyType(TokenSupplyType.Finite)
      .setMaxSupply(10_000)
      .setTreasuryAccountId(operatorId)
      .setAdminKey(operatorKey)
      .setSupplyKey(operatorKey)
      .setTokenMemo('Proof of ZoneProof report purchase — Hedera Testnet')
      .execute(client);
    const r3 = await t3.getReceipt(client);
    const nftTokenId = r3.tokenId.toString();
    console.log('[setup] ZPR NFT Token:', nftTokenId);

    res.json({
      report_audit_topic: reportTopic,
      petition_log_topic: petitionTopic,
      nft_token_id:       nftTokenId,
      hashscan_nft:       `https://hashscan.io/testnet/token/${nftTokenId}`,
      hashscan_topic1:    `https://hashscan.io/testnet/topic/${reportTopic}`,
      hashscan_topic2:    `https://hashscan.io/testnet/topic/${petitionTopic}`,
      next_step: 'Add HCS_REPORT_AUDIT_TOPIC, HCS_PETITION_LOG_TOPIC, HTS_NFT_TOKEN_ID to oracle/.env, then restart hedera service',
    });
  } catch (err) {
    console.error('[setup] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── HCS: log a report seal (called after every x402-gated history request) ────
// Prize: "Use HCS to create verifiable timestamps for documents" — No Solidity $3K
app.post('/hcs/report-audit', async (req, res) => {
  if (!REPORT_AUDIT_TOPIC) {
    return res.status(503).json({ error: 'HCS_REPORT_AUDIT_TOPIC not set — run POST /setup first' });
  }
  const { pin, report_hash, oracle_address, generated_at } = req.body;
  try {
    const message = JSON.stringify({
      type:           'report_audit',
      pin,
      report_hash,
      oracle_address,
      generated_at,
    });
    const tx = await new TopicMessageSubmitTransaction()
      .setTopicId(REPORT_AUDIT_TOPIC)
      .setMessage(message)
      .execute(client);
    const receipt = await tx.getReceipt(client);
    const seqNum  = Number(receipt.topicSequenceNumber);
    console.log(`[hcs] Report audit logged — PIN ${pin} | seq #${seqNum}`);
    res.json({
      success:         true,
      topic_id:        REPORT_AUDIT_TOPIC,
      sequence_number: seqNum,
      hashscan:        `https://hashscan.io/testnet/topic/${REPORT_AUDIT_TOPIC}/message/${seqNum}`,
    });
  } catch (err) {
    console.error('[hcs/report-audit] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── HCS: log a petition merkle batch commit ───────────────────────────────────
app.post('/hcs/petition-batch', async (req, res) => {
  if (!PETITION_LOG_TOPIC) {
    return res.status(503).json({ error: 'HCS_PETITION_LOG_TOPIC not set — run POST /setup first' });
  }
  const { batch_id, merkle_root, petition_count, evm_tx_hash } = req.body;
  try {
    const message = JSON.stringify({
      type:           'petition_batch',
      batch_id,
      merkle_root,
      petition_count,
      evm_tx_hash,
      timestamp:      new Date().toISOString(),
    });
    const tx = await new TopicMessageSubmitTransaction()
      .setTopicId(PETITION_LOG_TOPIC)
      .setMessage(message)
      .execute(client);
    const receipt = await tx.getReceipt(client);
    const seqNum  = Number(receipt.topicSequenceNumber);
    console.log(`[hcs] Petition batch logged — batch ${batch_id} | seq #${seqNum}`);
    res.json({
      success:         true,
      topic_id:        PETITION_LOG_TOPIC,
      sequence_number: seqNum,
      hashscan:        `https://hashscan.io/testnet/topic/${PETITION_LOG_TOPIC}/message/${seqNum}`,
    });
  } catch (err) {
    console.error('[hcs/petition-batch] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── HTS: mint ZPR NFT receipt for a paid ZoneProof report ─────────────────────
// Prize: "Mint an HTS token as a receipt for each proof" — No Solidity $3K
//        "Fractionalized Real Estate — Tokenize property ownership" — Tokenization $3K
app.post('/hts/mint-receipt', async (req, res) => {
  if (!NFT_TOKEN_ID) {
    return res.status(503).json({ error: 'HTS_NFT_TOKEN_ID not set — run POST /setup first' });
  }
  const { report_hash, pin, hcs_sequence } = req.body;
  try {
    // Metadata ≤ 100 bytes per HTS spec: "zpr:" (4) + "0x" + 64-char hash = 70 bytes
    const meta      = `zpr:${report_hash}`;
    const metaBytes = Buffer.from(meta, 'utf8');
    const tx = await new TokenMintTransaction()
      .setTokenId(NFT_TOKEN_ID)
      .addMetadata(metaBytes)
      .execute(client);
    const receipt = await tx.getReceipt(client);
    const serial  = Number(receipt.serials[0]);
    console.log(`[hts] ZPR NFT minted — PIN ${pin} | serial #${serial}`);
    res.json({
      success:       true,
      token_id:      NFT_TOKEN_ID,
      serial_number: serial,
      metadata:      meta,
      hashscan:      `https://hashscan.io/testnet/token/${NFT_TOKEN_ID}/${serial}`,
    });
  } catch (err) {
    console.error('[hts/mint-receipt] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Scheduled Transaction: future HCS petition batch commit ───────────────────
// Prize: "Automate recurring ... payments using Scheduled Transactions" — No Solidity $3K
app.post('/schedule/merkle-commit', async (req, res) => {
  if (!PETITION_LOG_TOPIC) {
    return res.status(503).json({ error: 'HCS_PETITION_LOG_TOPIC not set — run POST /setup first' });
  }
  const { batch_id, merkle_root, petition_count } = req.body;
  try {
    const message = JSON.stringify({
      type:           'scheduled_merkle_commit',
      batch_id,
      merkle_root,
      petition_count,
      scheduled_at:   new Date().toISOString(),
    });

    // Inner transaction: HCS message submission (no Solidity required)
    const innerTx = new TopicMessageSubmitTransaction()
      .setTopicId(PETITION_LOG_TOPIC)
      .setMessage(message);

    // Wrap in ScheduleCreate — auto-executes when oracle signs
    const scheduleTx = await new ScheduleCreateTransaction()
      .setScheduledTransaction(innerTx)
      .setScheduleMemo(`ZoneProof auto-commit — batch ${batch_id}`)
      .execute(client);

    const receipt    = await scheduleTx.getReceipt(client);
    const scheduleId = receipt.scheduleId.toString();
    console.log(`[schedule] Merkle commit scheduled — batch ${batch_id} | schedule ${scheduleId}`);
    res.json({
      success:     true,
      schedule_id: scheduleId,
      batch_id,
      hashscan:    `https://hashscan.io/testnet/schedule/${scheduleId}`,
    });
  } catch (err) {
    console.error('[schedule/merkle-commit] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.HEDERA_SERVICE_PORT || 8002;
app.listen(PORT, () => {
  console.log(`[hedera-service] Running on :${PORT}`);
  console.log(`[hedera-service] Operator: ${operatorId}`);
  console.log(`[hedera-service] Report Audit Topic : ${REPORT_AUDIT_TOPIC || 'NOT SET'}`);
  console.log(`[hedera-service] Petition Log Topic : ${PETITION_LOG_TOPIC || 'NOT SET'}`);
  console.log(`[hedera-service] ZPR NFT Token      : ${NFT_TOKEN_ID || 'NOT SET'}`);
  if (!REPORT_AUDIT_TOPIC) {
    console.log('[hedera-service] Run: curl -X POST http://localhost:8002/setup | jq');
  }
});