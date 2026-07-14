"""
/api/oracle/pending-events   ← called by CRE workflow + blockchain processor
/api/oracle/events           ← full change event log
"""
import hashlib
import json
from fastapi import APIRouter, Query
from oracle.api.db import query

router = APIRouter(tags=["events"])


def _leaf_hash(event: dict) -> str:
    """
    Deterministic SHA-256 leaf hash for a change event.
    CRE nodes compute the same hash independently — consensus requires matching hashes.
    Fields: id | event_type | petition_number | detected_at | after_state
    """
    raw = "|".join([
        str(event.get("id", "")),
        str(event.get("event_type", "")),
        str(event.get("petition_number") or event.get("pin") or ""),
        str(event.get("detected_at", "")),
        str(event.get("after_state") or ""),
    ])
    return "0x" + hashlib.sha256(raw.encode()).hexdigest()


@router.get("/pending-events")
def get_pending_events(limit: int = Query(500, le=1000)):
    """
    Returns uncommitted rezoning change events.

    This is the primary endpoint consumed by:
      - CRE workflow (each DON node calls this independently)
      - Local blockchain processor (oracle/pipeline/processor.js)

    Each event includes a pre-computed leaf_hash so all consumers
    hash consistently for Merkle tree construction.
    """
    rows = query("""
        SELECT
            ce.id,
            ce.event_type,
            ce.county_id,
            ce.petition_number,
            ce.pin,
            ce.changed_fields,
            ce.before_state,
            ce.after_state,
            ce.detected_at,
            -- Enrich with petition details
            rp.current_zoning,
            rp.proposed_zoning,
            rp.status          AS petition_status,
            rp.meeting_date,
            rp.pins            AS affected_pins,
            rp.address         AS petition_address
        FROM change_events ce
        LEFT JOIN rezoning_petitions rp
               ON rp.petition_number = ce.petition_number
              AND rp.county_id       = ce.county_id
        WHERE ce.committed_at IS NULL
          AND ce.event_type IN (
              'new_petition',
              'petition_status_change',
              'petition_vote_change'
          )
        ORDER BY ce.detected_at ASC
        LIMIT %s
    """, (limit,))

    # Attach leaf hash to each event
    for row in rows:
        row["leaf_hash"] = _leaf_hash(row)
        # Ensure JSON-serialisable types
        if row.get("changed_fields") and not isinstance(row["changed_fields"], list):
            row["changed_fields"] = list(row["changed_fields"])
        if row.get("affected_pins") and not isinstance(row["affected_pins"], list):
            row["affected_pins"] = list(row["affected_pins"])

    return {
        "count": len(rows),
        "events": rows,
    }


@router.get("/events")
def list_events(
    event_type: str = Query(None),
    committed: bool = Query(None),
    limit: int = Query(100, le=500),
    offset: int = Query(0),
):
    """Full change event log with optional filters."""
    conditions = ["1=1"]
    params = []

    if event_type:
        conditions.append("event_type = %s")
        params.append(event_type)

    if committed is True:
        conditions.append("committed_at IS NOT NULL")
    elif committed is False:
        conditions.append("committed_at IS NULL")

    where = " AND ".join(conditions)

    rows = query(f"""
        SELECT id, event_type, county_id, petition_number, pin,
               changed_fields, detected_at, committed_at, batch_id,
               hcs_sequence_number
        FROM change_events
        WHERE {where}
        ORDER BY detected_at DESC
        LIMIT %s OFFSET %s
    """, params + [limit, offset])

    total = query(f"SELECT COUNT(*) AS n FROM change_events WHERE {where}", params)

    return {
        "total": total[0]["n"],
        "limit": limit,
        "offset": offset,
        "events": rows,
    }
