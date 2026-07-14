/**
 * ZoneProof combined server — Oracle API + Hedera (HCS/HTS) in one Node process.
 * Deploy as a single Render Web Service.
 *
 * Routes (Python-compatible under /api/oracle/*):
 *   GET  /api/oracle/health
 *   GET  /api/oracle/pending-events
 *   GET  /api/oracle/events
 *   GET  /api/oracle/parcels/:pin
 *   GET  /api/oracle/parcels/:pin/history/peek
 *   GET  /api/oracle/parcels/:pin/history   (x402 gated)
 *   GET  /api/oracle/verify/:report_hash
 *   GET  /api/oracle/petitions
 *   GET  /api/oracle/petitions/:number
 *
 * Hedera (in-process; also kept as HTTP for tools):
 *   POST /setup
 *   POST /hcs/report-audit
 *   POST /hcs/petition-batch
 *   POST /hts/mint-receipt
 *   POST /schedule/merkle-commit
 *   GET  /health
 */
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  getParcel,
  getParcelHistory,
  getParcelHistoryPeek,
  getPendingEvents,
  listEvents,
  listPetitions,
  getPetition,
  healthCounts,
} from './lib/store.mjs';
import { x402Middleware } from './lib/x402.mjs';
import {
  initHedera,
  hederaStatus,
  setupTopicsAndToken,
  hcsReportAudit,
  hcsPetitionBatch,
  htsMintReceipt,
  scheduleMerkleCommit,
} from './lib/hedera.mjs';
import { signReport, attachHederaProofs, verifyReport } from './lib/seal.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config(); // also process cwd / Render env

const app = express();
app.use(cors({ origin: true, exposedHeaders: ['X-402-Version'] }));
app.use(express.json());

initHedera();

// ── Liveness ─────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'zoneproof-server',
    store: healthCounts(),
    hedera: hederaStatus(),
  });
});

app.get('/api/oracle/health', (_req, res) => {
  res.json({ status: 'ok', counts: healthCounts() });
});

// ── Events ───────────────────────────────────────────────────────────────────
app.get('/api/oracle/pending-events', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 500, 1000);
  res.json(getPendingEvents(limit));
});

app.get('/api/oracle/events', (req, res) => {
  const event_type = req.query.event_type || undefined;
  let committed;
  if (req.query.committed === 'true') committed = true;
  if (req.query.committed === 'false') committed = false;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Number(req.query.offset) || 0;
  res.json(listEvents({ event_type, committed, limit, offset }));
});

// ── Petitions ────────────────────────────────────────────────────────────────
app.get('/api/oracle/petitions', (req, res) => {
  const status = req.query.status || undefined;
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const offset = Number(req.query.offset) || 0;
  res.json(listPetitions({ status, limit, offset }));
});

app.get('/api/oracle/petitions/:number', (req, res) => {
  const result = getPetition(req.params.number);
  if (!result) return res.status(404).json({ detail: `Petition ${req.params.number} not found` });
  res.json(result);
});

// ── Parcels ──────────────────────────────────────────────────────────────────
app.get('/api/oracle/parcels/:pin', (req, res) => {
  const parcel = getParcel(req.params.pin);
  if (!parcel) return res.status(404).json({ detail: `Parcel ${req.params.pin} not found` });
  res.json(parcel);
});

app.get('/api/oracle/parcels/:pin/history/peek', (req, res) => {
  const result = getParcelHistoryPeek(req.params.pin);
  if (!result) return res.status(404).json({ detail: `Parcel ${req.params.pin} not found` });
  res.json(result);
});

// x402 only on full history (not peek)
app.get('/api/oracle/parcels/:pin/history', x402Middleware, async (req, res) => {
  try {
    const result = getParcelHistory(req.params.pin);
    if (!result) return res.status(404).json({ detail: `Parcel ${req.params.pin} not found` });
    const seal = await signReport(result);
    await attachHederaProofs(req.params.pin, seal);
    result.verification_seal = seal;
    res.json(result);
  } catch (e) {
    console.error('[history]', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/oracle/verify/:report_hash', (req, res) => {
  res.json(verifyReport(req.params.report_hash));
});

// ── Hedera HTTP surface (same paths as old sidecar) ──────────────────────────
app.post('/setup', async (_req, res) => {
  try {
    res.json(await setupTopicsAndToken());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/hcs/report-audit', async (req, res) => {
  try {
    res.json(await hcsReportAudit(req.body));
  } catch (e) {
    res.status(e.message.includes('not set') ? 503 : 500).json({ error: e.message });
  }
});

app.post('/hcs/petition-batch', async (req, res) => {
  try {
    res.json(await hcsPetitionBatch(req.body));
  } catch (e) {
    res.status(e.message.includes('not set') ? 503 : 500).json({ error: e.message });
  }
});

app.post('/hts/mint-receipt', async (req, res) => {
  try {
    res.json(await htsMintReceipt(req.body));
  } catch (e) {
    res.status(e.message.includes('not set') ? 503 : 500).json({ error: e.message });
  }
});

app.post('/schedule/merkle-commit', async (req, res) => {
  try {
    res.json(await scheduleMerkleCommit(req.body));
  } catch (e) {
    res.status(e.message.includes('not set') ? 503 : 500).json({ error: e.message });
  }
});

const PORT = Number(process.env.PORT || process.env.API_PORT || 8001);
app.listen(PORT, () => {
  console.log(`[zoneproof-server] http://0.0.0.0:${PORT}`);
  console.log(`[zoneproof-server] oracle routes under /api/oracle/*`);
  console.log(`[zoneproof-server] hedera: ${JSON.stringify(hederaStatus())}`);
});
