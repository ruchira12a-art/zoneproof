import { createHash } from 'node:crypto';
import { Wallet, verifyMessage } from 'ethers';
import { logReportToHedera } from './hedera.mjs';

const REPORT_REGISTRY = new Map();

const ORACLE_PRIVATE_KEY = process.env.HEDERA_PRIVATE_KEY || '';
const ORACLE_ADDRESS = (process.env.HEDERA_EVM_ADDRESS || '').toLowerCase();
const ORACLE_ENS = process.env.ORACLE_ENS || 'zoneproof.eth';

export async function signReport(data) {
  const generated_at = new Date().toISOString();
  const payload = {
    pin: data?.parcel?.pin || '',
    site_address: data?.parcel?.site_address || '',
    total_petitions: data?.total_petitions || 0,
    on_chain_count: data?.on_chain_count || 0,
    oracle_ens: ORACLE_ENS,
    oracle_address: ORACLE_ADDRESS,
    generated_at,
  };
  // Match Python: sort_keys=True, separators=(',', ':')
  const keys = Object.keys(payload).sort();
  const pyJson = '{' + keys.map((k) => `"${k}":${JSON.stringify(payload[k])}`).join(',') + '}';
  const report_hash = '0x' + createHash('sha256').update(pyJson).digest('hex');

  let signature = '';
  if (ORACLE_PRIVATE_KEY) {
    try {
      const wallet = new Wallet(ORACLE_PRIVATE_KEY.startsWith('0x') ? ORACLE_PRIVATE_KEY : `0x${ORACLE_PRIVATE_KEY}`);
      signature = await wallet.signMessage(`ZoneProof Report\n${report_hash}`);
    } catch (e) {
      console.warn('[seal] sign failed:', e.message);
    }
  }

  const seal = {
    report_hash,
    oracle_signature: signature,
    oracle_ens: ORACLE_ENS,
    oracle_address: ORACLE_ADDRESS,
    generated_at,
    verify_url: `/api/oracle/verify/${report_hash}`,
  };
  REPORT_REGISTRY.set(report_hash, {
    ...seal,
    pin: payload.pin,
    site_address: payload.site_address,
  });
  return seal;
}

export async function attachHederaProofs(pin, seal) {
  const extras = await logReportToHedera(pin, seal);
  Object.assign(seal, extras);
  const reg = REPORT_REGISTRY.get(seal.report_hash);
  if (reg) Object.assign(reg, extras);
  return seal;
}

export function verifyReport(reportHash) {
  const seal = REPORT_REGISTRY.get(reportHash);
  if (!seal) {
    return {
      valid: false,
      reason: 'Report hash not found. Not issued by this oracle, or oracle restarted.',
      report_hash: reportHash,
    };
  }

  let valid = false;
  if (seal.oracle_signature && ORACLE_ADDRESS) {
    try {
      const recovered = verifyMessage(`ZoneProof Report\n${reportHash}`, seal.oracle_signature);
      valid = recovered.toLowerCase() === ORACLE_ADDRESS;
    } catch {
      valid = false;
    }
  }

  const resp = {
    valid,
    report_hash: reportHash,
    oracle_ens: seal.oracle_ens,
    oracle_address: seal.oracle_address,
    pin: seal.pin,
    site_address: seal.site_address,
    generated_at: seal.generated_at,
    message: valid ? 'Authentic ZoneProof report' : 'Signature verification failed',
  };
  if (seal.hcs_topic_id) {
    resp.hcs_proof = {
      topic_id: seal.hcs_topic_id,
      sequence_number: seal.hcs_sequence,
      hashscan: seal.hcs_hashscan,
    };
  }
  if (seal.nft_token_id) {
    resp.nft_receipt = {
      token_id: seal.nft_token_id,
      serial: seal.nft_serial,
      hashscan: seal.nft_hashscan,
    };
  }
  return resp;
}
