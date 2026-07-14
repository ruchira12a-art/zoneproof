/**
 * In-process Hedera SDK helpers (was oracle/hedera/service.mjs sidecar).
 */
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

let client = null;
let operatorId = null;
let operatorKey = null;

export function hederaConfigured() {
  return !!(process.env.HEDERA_ACCOUNT_ID && process.env.HEDERA_PRIVATE_KEY);
}

export function initHedera() {
  if (!hederaConfigured()) {
    console.warn('[hedera] HEDERA_ACCOUNT_ID / HEDERA_PRIVATE_KEY not set — HCS/HTS routes disabled');
    return false;
  }
  operatorId = AccountId.fromString(process.env.HEDERA_ACCOUNT_ID);
  operatorKey = PrivateKey.fromStringECDSA(process.env.HEDERA_PRIVATE_KEY);
  client = Client.forTestnet();
  client.setOperator(operatorId, operatorKey);
  console.log(`[hedera] operator ${operatorId}`);
  return true;
}

function topics() {
  return {
    report: process.env.HCS_REPORT_AUDIT_TOPIC || process.env.HCS_TOPIC_ID || '',
    petition: process.env.HCS_PETITION_LOG_TOPIC || '',
    nft: process.env.HTS_NFT_TOKEN_ID || '',
  };
}

export function hederaStatus() {
  const t = topics();
  return {
    ok: !!client,
    account: operatorId?.toString() || null,
    report_audit_topic: t.report || 'NOT SET — POST /setup',
    petition_log_topic: t.petition || 'NOT SET — POST /setup',
    nft_token_id: t.nft || 'NOT SET — POST /setup',
  };
}

export async function setupTopicsAndToken() {
  if (!client) throw new Error('Hedera not configured');

  const t1 = await new TopicCreateTransaction()
    .setTopicMemo('ZoneProof Report Audit Log — immutable record of every issued report seal')
    .execute(client);
  const r1 = await t1.getReceipt(client);
  const reportTopic = r1.topicId.toString();

  const t2 = await new TopicCreateTransaction()
    .setTopicMemo('ZoneProof Petition Batch Log — merkle roots of DC zoning petition commits')
    .execute(client);
  const r2 = await t2.getReceipt(client);
  const petitionTopic = r2.topicId.toString();

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

  return {
    report_audit_topic: reportTopic,
    petition_log_topic: petitionTopic,
    nft_token_id: nftTokenId,
    hashscan_nft: `https://hashscan.io/testnet/token/${nftTokenId}`,
    hashscan_topic1: `https://hashscan.io/testnet/topic/${reportTopic}`,
    hashscan_topic2: `https://hashscan.io/testnet/topic/${petitionTopic}`,
    next_step:
      'Set HCS_REPORT_AUDIT_TOPIC, HCS_PETITION_LOG_TOPIC, HTS_NFT_TOKEN_ID on Render and redeploy',
  };
}

export async function hcsReportAudit({ pin, report_hash, oracle_address, generated_at, oracle_ens }) {
  const topic = topics().report;
  if (!topic) throw new Error('HCS_REPORT_AUDIT_TOPIC not set — run POST /setup first');
  if (!client) throw new Error('Hedera not configured');
  const message = JSON.stringify({
    type: 'report_audit',
    pin,
    report_hash,
    oracle_address,
    oracle_ens,
    generated_at,
  });
  const tx = await new TopicMessageSubmitTransaction().setTopicId(topic).setMessage(message).execute(client);
  const receipt = await tx.getReceipt(client);
  const seqNum = Number(receipt.topicSequenceNumber);
  return {
    success: true,
    topic_id: topic,
    sequence_number: seqNum,
    hashscan: `https://hashscan.io/testnet/topic/${topic}/message/${seqNum}`,
  };
}

export async function hcsPetitionBatch({ batch_id, merkle_root, petition_count, evm_tx_hash }) {
  const topic = topics().petition;
  if (!topic) throw new Error('HCS_PETITION_LOG_TOPIC not set — run POST /setup first');
  if (!client) throw new Error('Hedera not configured');
  const message = JSON.stringify({
    type: 'petition_batch',
    batch_id,
    merkle_root,
    petition_count,
    evm_tx_hash,
    timestamp: new Date().toISOString(),
  });
  const tx = await new TopicMessageSubmitTransaction().setTopicId(topic).setMessage(message).execute(client);
  const receipt = await tx.getReceipt(client);
  const seqNum = Number(receipt.topicSequenceNumber);
  return {
    success: true,
    topic_id: topic,
    sequence_number: seqNum,
    hashscan: `https://hashscan.io/testnet/topic/${topic}/message/${seqNum}`,
  };
}

export async function htsMintReceipt({ report_hash, pin }) {
  const tokenId = topics().nft;
  if (!tokenId) throw new Error('HTS_NFT_TOKEN_ID not set — run POST /setup first');
  if (!client) throw new Error('Hedera not configured');
  const meta = `zpr:${report_hash}`;
  const metaBytes = Buffer.from(meta, 'utf8');
  const tx = await new TokenMintTransaction().setTokenId(tokenId).addMetadata(metaBytes).execute(client);
  const receipt = await tx.getReceipt(client);
  const serial = Number(receipt.serials[0]);
  return {
    success: true,
    token_id: tokenId,
    serial_number: serial,
    metadata: meta,
    hashscan: `https://hashscan.io/testnet/token/${tokenId}/${serial}`,
  };
}

export async function scheduleMerkleCommit({ batch_id, merkle_root, petition_count }) {
  const topic = topics().petition;
  if (!topic) throw new Error('HCS_PETITION_LOG_TOPIC not set — run POST /setup first');
  if (!client) throw new Error('Hedera not configured');
  const message = JSON.stringify({
    type: 'scheduled_merkle_commit',
    batch_id,
    merkle_root,
    petition_count,
    scheduled_at: new Date().toISOString(),
  });
  const innerTx = new TopicMessageSubmitTransaction().setTopicId(topic).setMessage(message);
  const scheduleTx = await new ScheduleCreateTransaction()
    .setScheduledTransaction(innerTx)
    .setScheduleMemo(`ZoneProof auto-commit — batch ${batch_id}`)
    .execute(client);
  const receipt = await scheduleTx.getReceipt(client);
  const scheduleId = receipt.scheduleId.toString();
  return {
    success: true,
    schedule_id: scheduleId,
    batch_id,
    hashscan: `https://hashscan.io/testnet/schedule/${scheduleId}`,
  };
}

/** Call HCS + HTS after a paid report (in-process; no HTTP hop). */
export async function logReportToHedera(pin, seal) {
  const extras = {};
  try {
    const d = await hcsReportAudit({
      pin,
      report_hash: seal.report_hash,
      oracle_address: seal.oracle_address,
      generated_at: seal.generated_at,
      oracle_ens: seal.oracle_ens,
    });
    extras.hcs_topic_id = d.topic_id;
    extras.hcs_sequence = d.sequence_number;
    extras.hcs_hashscan = d.hashscan;
  } catch (e) {
    console.warn('[hedera] HCS audit skipped:', e.message);
  }
  try {
    const d = await htsMintReceipt({
      report_hash: seal.report_hash,
      pin,
      hcs_sequence: extras.hcs_sequence,
    });
    extras.nft_token_id = d.token_id;
    extras.nft_serial = d.serial_number;
    extras.nft_hashscan = d.hashscan;
  } catch (e) {
    console.warn('[hedera] NFT mint skipped:', e.message);
  }
  return extras;
}
