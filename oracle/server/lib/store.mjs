/**
 * JSON-backed store (same data the Python API used via store.py).
 * Loads oracle/*.json once at boot — no Postgres required for demo/API.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORACLE_ROOT = join(__dirname, '..', '..'); // oracle/

function load(filename) {
  const path = join(ORACLE_ROOT, filename);
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn(`[store] WARNING: could not load ${filename}: ${e.message}`);
    return [];
  }
}

const parcelsRaw = load('parcels.json');
const petitionsRaw = load('rezoning_petitions.json');
const changeEventsRaw = load('change_events.json');
const merkleBatchesRaw = load('merkle_batches.json');

export const PARCELS_BY_PIN = Object.fromEntries(parcelsRaw.map((p) => [p.pin, p]));
export const BATCHES_BY_ID = Object.fromEntries(merkleBatchesRaw.map((b) => [b.batch_id, b]));

export const EVENTS_BY_PETITION = {};
for (const ev of changeEventsRaw) {
  const pn = ev.petition_number;
  if (pn) {
    if (!EVENTS_BY_PETITION[pn]) EVENTS_BY_PETITION[pn] = [];
    EVENTS_BY_PETITION[pn].push(ev);
  }
}

export const REZONING_PETITIONS = petitionsRaw;
export const CHANGE_EVENTS = changeEventsRaw;

console.error(
  `[store] Loaded  parcels=${Object.keys(PARCELS_BY_PIN).length.toLocaleString()}  ` +
    `petitions=${REZONING_PETITIONS.length.toLocaleString()}  ` +
    `change_events=${CHANGE_EVENTS.length.toLocaleString()}  ` +
    `merkle_batches=${merkleBatchesRaw.length.toLocaleString()}`,
);

export function getParcel(pin) {
  return PARCELS_BY_PIN[pin] || null;
}

export function getParcelHistoryPeek(pin) {
  const parcel = PARCELS_BY_PIN[pin];
  if (!parcel) return null;
  const petitions = REZONING_PETITIONS.filter((p) => (p.pins || []).includes(pin));
  const onChain = petitions.filter((p) =>
    (EVENTS_BY_PETITION[p.petition_number] || []).some(
      (ev) =>
        ev.committed_at &&
        ['new_petition', 'petition_status_change', 'petition_vote_change'].includes(ev.event_type),
    ),
  ).length;
  return { total_petitions: petitions.length, on_chain_count: onChain };
}

export function getParcelHistory(pin) {
  const parcel = PARCELS_BY_PIN[pin];
  if (!parcel) return null;

  const petitions = REZONING_PETITIONS.filter((p) => (p.pins || []).includes(pin)).sort((a, b) =>
    (b.meeting_date || '').localeCompare(a.meeting_date || ''),
  );

  const results = petitions.map((p) => {
    const row = {
      petition_number: p.petition_number,
      current_zoning: p.current_zoning,
      proposed_zoning: p.proposed_zoning,
      status: p.status,
      vote_result: p.vote_result,
      action: p.action,
      meeting_date: p.meeting_date,
      meeting_type: p.meeting_type,
      petition_address: p.address,
      legislation_url: p.legislation_url,
      file_number: p.file_number,
      first_seen_at: p.first_seen_at,
      batch_id: null,
      committed_at: null,
      event_type: null,
      evm_snapshot_index: null,
      hedera_evm_tx_hash: null,
      hedera_evm_block: null,
    };

    const events = (EVENTS_BY_PETITION[p.petition_number] || []).filter(
      (ev) =>
        ev.committed_at &&
        ['new_petition', 'petition_status_change', 'petition_vote_change'].includes(ev.event_type),
    );
    if (events.length) {
      const latest = events.reduce((a, b) => (a.committed_at > b.committed_at ? a : b));
      row.batch_id = latest.batch_id;
      row.committed_at = latest.committed_at;
      row.event_type = latest.event_type;
      row.evm_snapshot_index = latest.evm_snapshot_index;
      const batch = BATCHES_BY_ID[latest.batch_id];
      if (batch) {
        row.hedera_evm_tx_hash = batch.hedera_evm_tx_hash;
        row.hedera_evm_block = batch.hedera_evm_block;
      }
    }
    return row;
  });

  const onChain = results.filter((r) => r.committed_at);
  return {
    parcel,
    rezoning_history: results,
    total_petitions: results.length,
    on_chain_count: onChain.length,
  };
}

export function leafHash(event) {
  const raw = [
    String(event.id ?? ''),
    String(event.event_type ?? ''),
    String(event.petition_number || event.pin || ''),
    String(event.detected_at ?? ''),
    String(event.after_state ?? ''),
  ].join('|');
  return '0x' + createHash('sha256').update(raw).digest('hex');
}

export function getPendingEvents(limit = 500) {
  const types = new Set(['new_petition', 'petition_status_change', 'petition_vote_change']);
  const rows = CHANGE_EVENTS.filter((ce) => !ce.committed_at && types.has(ce.event_type))
    .sort((a, b) => String(a.detected_at).localeCompare(String(b.detected_at)))
    .slice(0, limit)
    .map((ce) => {
      const rp = REZONING_PETITIONS.find(
        (p) => p.petition_number === ce.petition_number && p.county_id === ce.county_id,
      );
      const row = {
        ...ce,
        current_zoning: rp?.current_zoning,
        proposed_zoning: rp?.proposed_zoning,
        petition_status: rp?.status,
        meeting_date: rp?.meeting_date,
        affected_pins: rp?.pins,
        petition_address: rp?.address,
      };
      row.leaf_hash = leafHash(row);
      return row;
    });
  return { count: rows.length, events: rows };
}

export function listEvents({ event_type, committed, limit = 100, offset = 0 } = {}) {
  let rows = [...CHANGE_EVENTS];
  if (event_type) rows = rows.filter((e) => e.event_type === event_type);
  if (committed === true) rows = rows.filter((e) => e.committed_at);
  if (committed === false) rows = rows.filter((e) => !e.committed_at);
  rows.sort((a, b) => String(b.detected_at).localeCompare(String(a.detected_at)));
  const total = rows.length;
  const slice = rows.slice(offset, offset + limit).map((e) => ({
    id: e.id,
    event_type: e.event_type,
    county_id: e.county_id,
    petition_number: e.petition_number,
    pin: e.pin,
    changed_fields: e.changed_fields,
    detected_at: e.detected_at,
    committed_at: e.committed_at,
    batch_id: e.batch_id,
    hcs_sequence_number: e.hcs_sequence_number,
  }));
  return { total, limit, offset, events: slice };
}

export function listPetitions({ status, limit = 50, offset = 0 } = {}) {
  let rows = [...REZONING_PETITIONS];
  if (status) rows = rows.filter((p) => p.status === status);
  rows.sort((a, b) => String(b.meeting_date || '').localeCompare(String(a.meeting_date || '')));
  const total = rows.length;
  const petitions = rows.slice(offset, offset + limit).map((p) => {
    const committed = (EVENTS_BY_PETITION[p.petition_number] || []).find((e) => e.committed_at);
    return {
      petition_number: p.petition_number,
      county_id: p.county_id,
      status: p.status,
      action: p.action,
      current_zoning: p.current_zoning,
      proposed_zoning: p.proposed_zoning,
      vote_result: p.vote_result,
      meeting_date: p.meeting_date,
      address: p.address,
      pin_count: (p.pins || []).length,
      legislation_url: p.legislation_url,
      committed_at: committed?.committed_at ?? null,
    };
  });
  return { total, limit, offset, petitions };
}

export function getPetition(petitionNumber) {
  const p = REZONING_PETITIONS.find((x) => x.petition_number === petitionNumber);
  if (!p) return null;
  const pins = p.pins || [];
  const affected_parcels = pins
    .map((pin) => PARCELS_BY_PIN[pin])
    .filter(Boolean)
    .map((parc) => ({
      pin: parc.pin,
      site_address: parc.site_address,
      city: parc.city,
      owner: parc.owner,
      total_value_assd: parc.total_value_assd,
      land_class: parc.land_class,
      type_and_use: parc.type_and_use,
      year_built: parc.year_built,
    }));
  const on_chain_proof = (EVENTS_BY_PETITION[petitionNumber] || [])
    .filter((e) => e.committed_at)
    .sort((a, b) => String(b.committed_at).localeCompare(String(a.committed_at)))
    .map((e) => ({
      batch_id: e.batch_id,
      hcs_sequence_number: e.hcs_sequence_number,
      committed_at: e.committed_at,
      event_type: e.event_type,
    }));
  return {
    petition: p,
    affected_parcels,
    total_parcels: affected_parcels.length,
    on_chain_proof,
  };
}

export function healthCounts() {
  const types = new Set(['new_petition', 'petition_status_change', 'petition_vote_change']);
  const pending = CHANGE_EVENTS.filter((ce) => !ce.committed_at && types.has(ce.event_type)).length;
  return {
    parcels: Object.keys(PARCELS_BY_PIN).length,
    petitions: REZONING_PETITIONS.length,
    change_events: CHANGE_EVENTS.length,
    pending_rezoning_events: pending,
  };
}
