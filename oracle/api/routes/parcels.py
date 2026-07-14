"""
/api/oracle/parcels/{pin}               <- parcel details
/api/oracle/parcels/{pin}/history/peek  <- free preview
/api/oracle/parcels/{pin}/history       <- full history (x402 gated) + ZoneProof seal
/api/oracle/verify/{report_hash}        <- verify a report seal
"""
import hashlib
import json
import os
from datetime import datetime, timezone

import httpx
from eth_account import Account
from eth_account.messages import encode_defunct
from fastapi import APIRouter, HTTPException

from oracle.api.store import get_parcel, get_parcel_history, get_parcel_history_peek

router = APIRouter(tags=["parcels"])

# In-memory registry of issued report seals  { hash: seal_dict }
_REPORT_REGISTRY: dict[str, dict] = {}

ORACLE_PRIVATE_KEY  = os.getenv("HEDERA_PRIVATE_KEY", "")
ORACLE_ADDRESS      = os.getenv("HEDERA_EVM_ADDRESS", "").lower()

HEDERA_SERVICE_URL  = os.getenv("HEDERA_SERVICE_URL", "http://localhost:8002")


def _sign_report(data: dict) -> dict:
    """Hash the report payload and sign it with the oracle ECDSA key."""
    generated_at = datetime.now(timezone.utc).isoformat()

    # Canonical payload — only stable fields so the hash is reproducible
    payload = {
        "pin":             data.get("parcel", {}).get("pin", ""),
        "site_address":    data.get("parcel", {}).get("site_address", ""),
        "total_petitions": data.get("total_petitions", 0),
        "on_chain_count":  data.get("on_chain_count", 0),
        "oracle_address":  ORACLE_ADDRESS,
        "generated_at":    generated_at,
    }
    payload_json = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    report_hash  = "0x" + hashlib.sha256(payload_json.encode()).hexdigest()

    # ECDSA sign with oracle private key (Ethereum personal_sign / EIP-191)
    signature = ""
    if ORACLE_PRIVATE_KEY:
        msg       = encode_defunct(text=f"ZoneProof Report\n{report_hash}")
        signed    = Account.sign_message(msg, private_key=ORACLE_PRIVATE_KEY)
        signature = signed.signature.hex()
        if not signature.startswith("0x"):
            signature = "0x" + signature

    seal = {
        "report_hash":      report_hash,
        "oracle_signature": signature,
        "oracle_address":   ORACLE_ADDRESS,
        "generated_at":     generated_at,
        "verify_url":       f"/verify/{report_hash}",
    }

    # Register so the verify endpoint can look it up
    _REPORT_REGISTRY[report_hash] = {**seal, "pin": payload["pin"], "site_address": payload["site_address"]}
    return seal


def _log_to_hedera(pin: str, seal: dict) -> dict:
    """
    Log seal to HCS and mint ZPR NFT receipt via the Hedera sidecar service.

    Hedera SDK only — no Solidity, no smart contracts. Covers two prizes:
      - HCS: "Use HCS to create verifiable timestamps for documents" (No Solidity $3K)
      - HTS: "Mint an HTS token as a receipt for each proof" (Tokenization $3K)

    Non-blocking: if the sidecar is down we degrade gracefully and the
    ECDSA seal is still returned.
    """
    extras: dict = {}

    # 1. HCS — immutable audit entry to Report Audit Topic 0.0.9227970
    try:
        r_hcs = httpx.post(
            f"{HEDERA_SERVICE_URL}/hcs/report-audit",
            json={
                "pin":            pin,
                "report_hash":    seal["report_hash"],
                "oracle_address": seal["oracle_address"],
                "generated_at":   seal["generated_at"],
                    },
            timeout=20.0,
        )
        if r_hcs.status_code == 200:
            d = r_hcs.json()
            extras["hcs_topic_id"] = d.get("topic_id")
            extras["hcs_sequence"] = d.get("sequence_number")
            extras["hcs_hashscan"] = d.get("hashscan")
    except Exception:
        pass

    # 2. HTS — mint ZPR NFT receipt (serial number = on-chain proof of this report)
    try:
        r_nft = httpx.post(
            f"{HEDERA_SERVICE_URL}/hts/mint-receipt",
            json={
                "report_hash":  seal["report_hash"],
                "pin":          pin,
                "hcs_sequence": extras.get("hcs_sequence"),
            },
            timeout=20.0,
        )
        if r_nft.status_code == 200:
            d = r_nft.json()
            extras["nft_token_id"] = d.get("token_id")
            extras["nft_serial"]   = d.get("serial_number")
            extras["nft_hashscan"] = d.get("hashscan")
    except Exception:
        pass

    return extras


@router.get("/parcels/{pin}")
def get_parcel_detail(pin: str):
    parcel = get_parcel(pin)
    if not parcel:
        raise HTTPException(status_code=404, detail=f"Parcel {pin} not found")
    return parcel


@router.get("/parcels/{pin}/history/peek")
def get_parcel_history_peek_route(pin: str):
    result = get_parcel_history_peek(pin)
    if not result:
        raise HTTPException(status_code=404, detail=f"Parcel {pin} not found")
    return result


@router.get("/parcels/{pin}/history")
def get_parcel_history_route(pin: str):
    result = get_parcel_history(pin)
    if not result:
        raise HTTPException(status_code=404, detail=f"Parcel {pin} not found")
    seal = _sign_report(result)
    # Log to HCS + mint HTS ZPR NFT receipt (no Solidity — pure Hedera SDK)
    hedera_extras = _log_to_hedera(pin, seal)
    seal.update(hedera_extras)
    if seal["report_hash"] in _REPORT_REGISTRY:
        _REPORT_REGISTRY[seal["report_hash"]].update(hedera_extras)
    result["verification_seal"] = seal
    return result


@router.get("/verify/{report_hash}")
def verify_report(report_hash: str):
    """Verify a ZoneProof report seal — ECDSA signature + HCS audit proof + HTS NFT."""
    seal = _REPORT_REGISTRY.get(report_hash)
    if not seal:
        return {
            "valid":       False,
            "reason":      "Report hash not found. Not issued by this oracle, or oracle restarted.",
            "report_hash": report_hash,
        }

    # Re-verify ECDSA signature
    valid = False
    if ORACLE_PRIVATE_KEY and seal.get("oracle_signature"):
        try:
            msg       = encode_defunct(text=f"ZoneProof Report\n{report_hash}")
            recovered = Account.recover_message(msg, signature=seal["oracle_signature"])
            valid     = recovered.lower() == ORACLE_ADDRESS
        except Exception:
            valid = False

    resp: dict = {
        "valid":          valid,
        "report_hash":    report_hash,
        "oracle_address": seal["oracle_address"],
        "pin":            seal["pin"],
        "site_address":   seal["site_address"],
        "generated_at":   seal["generated_at"],
        "message":        "Authentic ZoneProof report" if valid else "Signature verification failed",
    }

    # HCS on-chain proof
    if seal.get("hcs_topic_id"):
        resp["hcs_proof"] = {
            "topic_id":        seal["hcs_topic_id"],
            "sequence_number": seal["hcs_sequence"],
            "hashscan":        seal.get("hcs_hashscan"),
        }

    # HTS NFT receipt
    if seal.get("nft_token_id"):
        resp["nft_receipt"] = {
            "token_id": seal["nft_token_id"],
            "serial":   seal["nft_serial"],
            "hashscan": seal.get("nft_hashscan"),
        }

    return resp