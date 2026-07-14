"""
JSON-based data store — replaces Supabase while the DB is unavailable.

Loads the four exported JSON files at startup into memory and provides
the same two query functions that the parcels route uses.
"""
import json
import os

_BASE = os.path.join(os.path.dirname(__file__), "..", )   # oracle/

def _load(filename):
    path = os.path.join(_BASE, filename)
    try:
        with open(path) as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception as e:
        print(f"[store] WARNING: could not load {filename}: {e}")
        return []

# ── Load all tables once at import time ───────────────────────────────────────
_parcels_raw        = _load("parcels.json")
_petitions_raw      = _load("rezoning_petitions.json")
_change_events_raw  = _load("change_events.json")
_merkle_batches_raw = _load("merkle_batches.json")

# Index for O(1) lookups
PARCELS_BY_PIN    = {p["pin"]: p for p in _parcels_raw}
BATCHES_BY_ID     = {b["batch_id"]: b for b in _merkle_batches_raw}

# change_events indexed by petition_number → list of events
EVENTS_BY_PETITION: dict = {}
for ev in _change_events_raw:
    pn = ev.get("petition_number")
    if pn:
        EVENTS_BY_PETITION.setdefault(pn, []).append(ev)

REZONING_PETITIONS = _petitions_raw

print(f"[store] Loaded  parcels={len(PARCELS_BY_PIN):,}  "
      f"petitions={len(REZONING_PETITIONS):,}  "
      f"change_events={len(_change_events_raw):,}  "
      f"merkle_batches={len(_merkle_batches_raw):,}")


# ── Public API (mirrors what parcels.py used to get from db.query) ────────────

def get_parcel(pin: str):
    return PARCELS_BY_PIN.get(pin)


def get_parcel_history_peek(pin: str):
    """Free preview — returns only the petition count, no details."""
    parcel = PARCELS_BY_PIN.get(pin)
    if not parcel:
        return None
    petitions = [p for p in REZONING_PETITIONS if pin in (p.get("pins") or [])]
    on_chain = sum(
        1 for p in petitions
        if any(
            ev.get("committed_at")
            for ev in EVENTS_BY_PETITION.get(p.get("petition_number", ""), [])
            if ev.get("event_type") in ("new_petition", "petition_status_change", "petition_vote_change")
        )
    )
    return {"total_petitions": len(petitions), "on_chain_count": on_chain}


def get_parcel_history(pin: str):
    parcel = PARCELS_BY_PIN.get(pin)
    if not parcel:
        return None

    # All petitions that list this PIN
    petitions = [
        p for p in REZONING_PETITIONS
        if pin in (p.get("pins") or [])
    ]

    # Sort descending by meeting_date (None last)
    petitions.sort(
        key=lambda p: p.get("meeting_date") or "",
        reverse=True,
    )

    results = []
    for p in petitions:
        row = {
            "petition_number":  p.get("petition_number"),
            "current_zoning":   p.get("current_zoning"),
            "proposed_zoning":  p.get("proposed_zoning"),
            "status":           p.get("status"),
            "vote_result":      p.get("vote_result"),
            "action":           p.get("action"),
            "meeting_date":     p.get("meeting_date"),
            "meeting_type":     p.get("meeting_type"),
            "petition_address": p.get("address"),
            "legislation_url":  p.get("legislation_url"),
            "file_number":      p.get("file_number"),
            "first_seen_at":    p.get("first_seen_at"),
            # on-chain fields — populated below if change_event exists
            "batch_id":             None,
            "committed_at":         None,
            "event_type":           None,
            "evm_snapshot_index":   None,
            "hedera_evm_tx_hash":   None,
            "hedera_evm_block":     None,
        }

        # Find the most-recent committed change_event for this petition
        events = [
            ev for ev in EVENTS_BY_PETITION.get(p["petition_number"], [])
            if ev.get("committed_at")
            and ev.get("event_type") in (
                "new_petition", "petition_status_change", "petition_vote_change"
            )
        ]
        if events:
            latest = max(events, key=lambda e: e["committed_at"])
            row["batch_id"]           = latest.get("batch_id")
            row["committed_at"]       = latest.get("committed_at")
            row["event_type"]         = latest.get("event_type")
            row["evm_snapshot_index"] = latest.get("evm_snapshot_index")

            # Join merkle_batch for Hedera TX details
            batch = BATCHES_BY_ID.get(latest["batch_id"])
            if batch:
                row["hedera_evm_tx_hash"] = batch.get("hedera_evm_tx_hash")
                row["hedera_evm_block"]   = batch.get("hedera_evm_block")

        results.append(row)

    on_chain = [r for r in results if r["committed_at"]]

    return {
        "parcel":           parcel,
        "rezoning_history": results,
        "total_petitions":  len(results),
        "on_chain_count":   len(on_chain),
    }
