/**
 * x402 payment gate for GET /api/oracle/parcels/:pin/history
 */
const RECEIVER_ACCOUNT = process.env.HEDERA_ACCOUNT_ID || '0.0.7952768';
const RECEIVER_EVM = (process.env.HEDERA_EVM_ADDRESS || '0x85652f8479dc8dbd89adaee37d42e7c91a534294').toLowerCase();
const PAYMENT_TINYBARS = Number(process.env.X402_PRICE_TINYBARS || '5000000');
const MIRROR_BASE = 'https://testnet.mirrornode.hedera.com';
const MAX_TX_AGE_SECS = 300;
const PROTECTED = [/^\/api\/oracle\/parcels\/[^/]+\/history$/];

const usedTxIds = new Set();

function isProtected(path) {
  return PROTECTED.some((re) => re.test(path));
}

function paymentRequired(resource) {
  return {
    status: 402,
    body: {
      x402Version: 1,
      error: null,
      accepts: [
        {
          scheme: 'hedera-hbar',
          network: 'testnet',
          maxAmountRequired: String(PAYMENT_TINYBARS),
          resource,
          description: 'ZoneProof Oracle — parcel rezoning history',
          mimeType: 'application/json',
          payTo: RECEIVER_ACCOUNT,
          maxTimeoutSeconds: MAX_TX_AGE_SECS,
        },
      ],
    },
    headers: { 'X-402-Version': '1' },
  };
}

function decodePaymentHeader(header) {
  let h = header;
  const pad = 4 - (h.length % 4);
  if (pad !== 4) h += '='.repeat(pad);
  return JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function verifyEvmPayment(txHash) {
  if (usedTxIds.has(txHash)) return [false, 'Transaction already used'];
  const url = `${MIRROR_BASE}/api/v1/contracts/results/${txHash}`;
  let last = 'unknown';
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(url);
      if (r.status === 404) {
        last = `EVM transaction not yet indexed (attempt ${attempt + 1}/5)`;
        if (attempt < 4) await sleep(2000);
        continue;
      }
      if (!r.ok) return [false, `Mirror node returned HTTP ${r.status}`];
      const data = await r.json();
      if (data.error_message) return [false, `Transaction reverted: ${data.error_message}`];
      const consensusTs = Number.parseFloat(data.timestamp || '0');
      if (Date.now() / 1000 - consensusTs > MAX_TX_AGE_SECS) return [false, 'Payment too old (max 5 minutes)'];
      const toAddr = (data.to || '').toLowerCase();
      if (toAddr !== RECEIVER_EVM) return [false, `Wrong receiver: got ${toAddr}, expected ${RECEIVER_EVM}`];
      const amount = Number(data.amount || 0);
      if (amount < PAYMENT_TINYBARS) return [false, `Insufficient payment: ${amount} tinybars < ${PAYMENT_TINYBARS}`];
      usedTxIds.add(txHash);
      return [true, 'ok'];
    } catch (e) {
      last = `EVM verification error: ${e.message}`;
      if (attempt < 4) await sleep(2000);
    }
  }
  return [false, last];
}

async function verifyHederaPayment(txId) {
  if (usedTxIds.has(txId)) return [false, 'Transaction ID already used'];
  let mirrorTxId = txId;
  if (txId.includes('@')) {
    const [accountPart, tsPart] = txId.split('@', 2);
    mirrorTxId = `${accountPart}-${tsPart.replace('.', '-')}`;
  }
  const url = `${MIRROR_BASE}/api/v1/transactions/${mirrorTxId}`;
  let last = 'unknown';
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(url);
      if (r.status === 404) {
        last = `Transaction not yet indexed (attempt ${attempt + 1}/5)`;
        if (attempt < 4) await sleep(2000);
        continue;
      }
      if (!r.ok) return [false, `Mirror node returned HTTP ${r.status}`];
      const data = await r.json();
      for (const tx of data.transactions || []) {
        if (tx.result !== 'SUCCESS') continue;
        const consensusTs = Number.parseFloat(tx.consensus_timestamp || '0');
        if (Date.now() / 1000 - consensusTs > MAX_TX_AGE_SECS) return [false, 'Payment too old (max 5 minutes)'];
        for (const transfer of tx.transfers || []) {
          if (transfer.account === RECEIVER_ACCOUNT && (transfer.amount || 0) >= PAYMENT_TINYBARS) {
            usedTxIds.add(txId);
            return [true, 'ok'];
          }
        }
      }
      return [false, 'No qualifying HBAR transfer to app wallet found'];
    } catch (e) {
      last = `Verification failed: ${e.message}`;
      if (attempt < 4) await sleep(2000);
    }
  }
  return [false, last];
}

export function x402Middleware(req, res, next) {
  if (!isProtected(req.path)) return next();

  const xPayment = req.headers['x-payment'];
  if (!xPayment) {
    const pr = paymentRequired(req.path);
    res.set(pr.headers);
    return res.status(pr.status).json(pr.body);
  }

  (async () => {
    try {
      const payment = decodePaymentHeader(xPayment);
      const scheme = payment.scheme || '';
      const txHash = payment.txHash || '';
      const txId = payment.txId || '';
      let ok, reason;
      if (scheme === 'hedera-evm' || String(txHash).startsWith('0x')) {
        [ok, reason] = await verifyEvmPayment(txHash);
      } else {
        [ok, reason] = await verifyHederaPayment(txId);
      }
      if (!ok) {
        return res.status(402).set({ 'X-402-Version': '1' }).json({ x402Version: 1, error: reason });
      }
      next();
    } catch {
      return res.status(402).json({ x402Version: 1, error: 'Malformed X-Payment header' });
    }
  })();
}
