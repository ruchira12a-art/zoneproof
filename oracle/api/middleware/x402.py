"""
x402 payment middleware for ZoneProof Oracle API.

Flow:
  1. Client calls a protected endpoint (no X-Payment header)
  2. Middleware returns 402 with Hedera HBAR payment instructions
  3. Client pays HBAR to app wallet, gets TX ID
  4. Client encodes { txId, network } as base64, retries with X-Payment header
  5. Middleware verifies TX on Hedera mirror node → serves response

Protected routes: /api/oracle/parcels/{pin}/history
"""

import re
import json
import base64
import time
import asyncio
import os

import httpx
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

RECEIVER_ACCOUNT  = os.getenv("HEDERA_ACCOUNT_ID",   "0.0.7952768")
RECEIVER_EVM      = os.getenv("HEDERA_EVM_ADDRESS", "0x85652f8479dc8dbd89adaee37d42e7c91a534294").lower()
PAYMENT_TINYBARS  = int(os.getenv("X402_PRICE_TINYBARS", "5000000"))   # 0.05 HBAR
MIRROR_BASE       = "https://testnet.mirrornode.hedera.com"
MAX_TX_AGE_SECS   = 300   # payment must be within last 5 minutes

# Regex patterns for routes that require payment
PROTECTED_PATTERNS = [
    r"^/api/oracle/parcels/[^/]+/history$",
]

# In-memory replay-attack guard — TX IDs that have already been used
_used_tx_ids: set = set()


def _is_protected(path: str) -> bool:
    return any(re.match(p, path) for p in PROTECTED_PATTERNS)


def _payment_required_response(resource: str) -> JSONResponse:
    """Standard x402 response body."""
    return JSONResponse(
        status_code=402,
        content={
            "x402Version": 1,
            "error": None,
            "accepts": [
                {
                    "scheme":            "hedera-hbar",
                    "network":           "testnet",
                    "maxAmountRequired": str(PAYMENT_TINYBARS),
                    "resource":          resource,
                    "description":       "ZoneProof Oracle — parcel rezoning history",
                    "mimeType":          "application/json",
                    "payTo":             RECEIVER_ACCOUNT,
                    "maxTimeoutSeconds": MAX_TX_AGE_SECS,
                }
            ],
        },
        headers={"X-402-Version": "1"},
    )


def _decode_payment_header(header: str) -> dict:
    # Add base64 padding if needed
    padding = 4 - (len(header) % 4)
    if padding != 4:
        header += "=" * padding
    raw = base64.b64decode(header).decode("utf-8")
    return json.loads(raw)


async def _verify_evm_payment(tx_hash: str) -> tuple:
    """Verify an EVM tx hash (from HashPack via window.ethereum) on the mirror node.

    Retries up to 5 times with 2-second gaps because the Hedera mirror node
    typically lags 3-10 seconds behind on-chain consensus.
    """
    if tx_hash in _used_tx_ids:
        return False, "Transaction already used"

    url = f"{MIRROR_BASE}/api/v1/contracts/results/{tx_hash}"

    last_error = "unknown"
    for attempt in range(5):
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.get(url)

            if r.status_code == 404:
                # Mirror node hasn't indexed the tx yet — wait and retry
                last_error = f"EVM transaction not yet indexed (attempt {attempt + 1}/5)"
                if attempt < 4:
                    await asyncio.sleep(2)
                continue

            if r.status_code != 200:
                return False, f"Mirror node returned HTTP {r.status_code}"

            data = r.json()

            # Check success (failed txs should not unlock content)
            error_message = data.get("error_message")
            if error_message:
                return False, f"Transaction reverted: {error_message}"

            # Check timestamp (seconds.nanoseconds string from mirror node)
            consensus_ts = float(data.get("timestamp", "0"))
            if time.time() - consensus_ts > MAX_TX_AGE_SECS:
                return False, "Payment too old (max 5 minutes)"

            # Check receiver matches app EVM address
            to_addr = (data.get("to") or "").lower()
            if to_addr != RECEIVER_EVM:
                return False, f"Wrong receiver: got {to_addr!r}, expected {RECEIVER_EVM!r}"

            # Amount is in tinybars in the mirror node contracts/results response
            # 0.05 HBAR = 5,000,000 tinybars (not wei — Hedera normalises internally)
            amount = int(data.get("amount", 0))
            if amount < PAYMENT_TINYBARS:
                return False, f"Insufficient payment: {amount} tinybars < {PAYMENT_TINYBARS}"

            _used_tx_ids.add(tx_hash)
            return True, "ok"

        except Exception as exc:
            last_error = f"EVM verification error: {exc}"
            if attempt < 4:
                await asyncio.sleep(2)

    return False, last_error


async def _verify_hedera_payment(tx_id: str) -> tuple:
    """Verify a native Hedera HBAR transfer on the testnet mirror node."""
    if tx_id in _used_tx_ids:
        return False, "Transaction ID already used"

    # Mirror node expects: 0.0.XXXXXX-SEC-NANO
    # Client may send:     0.0.XXXXXX@SEC.NANO
    if "@" in tx_id:
        account_part, ts_part = tx_id.split("@", 1)
        ts_part = ts_part.replace(".", "-")
        mirror_tx_id = f"{account_part}-{ts_part}"
    else:
        mirror_tx_id = tx_id

    url = f"{MIRROR_BASE}/api/v1/transactions/{mirror_tx_id}"

    last_error = "unknown"
    for attempt in range(5):
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.get(url)

            if r.status_code == 404:
                last_error = f"Transaction not yet indexed (attempt {attempt + 1}/5)"
                if attempt < 4:
                    await asyncio.sleep(2)
                continue

            if r.status_code != 200:
                return False, f"Mirror node returned HTTP {r.status_code}"

            data = r.json()
            transactions = data.get("transactions", [])

            for tx in transactions:
                if tx.get("result") != "SUCCESS":
                    continue

                consensus_ts = float(tx.get("consensus_timestamp", "0"))
                if time.time() - consensus_ts > MAX_TX_AGE_SECS:
                    return False, "Payment too old (max 5 minutes)"

                for transfer in tx.get("transfers", []):
                    if (
                        transfer.get("account") == RECEIVER_ACCOUNT
                        and transfer.get("amount", 0) >= PAYMENT_TINYBARS
                    ):
                        _used_tx_ids.add(tx_id)
                        return True, "ok"

            return False, "No qualifying HBAR transfer to app wallet found"

        except Exception as exc:
            last_error = f"Verification failed: {exc}"
            if attempt < 4:
                await asyncio.sleep(2)

    return False, last_error


class X402Middleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if not _is_protected(request.url.path):
            return await call_next(request)

        x_payment = request.headers.get("X-Payment")

        if not x_payment:
            return _payment_required_response(request.url.path)

        try:
            payment = _decode_payment_header(x_payment)
            scheme  = payment.get("scheme", "")
            tx_hash = payment.get("txHash", "")  # EVM path (HashPack via window.ethereum)
            tx_id   = payment.get("txId",   "")  # Native Hedera path (MCP server)
        except Exception:
            return JSONResponse(
                status_code=402,
                content={"x402Version": 1, "error": "Malformed X-Payment header"},
            )

        if scheme == "hedera-evm" or tx_hash.startswith("0x"):
            ok, reason = await _verify_evm_payment(tx_hash)
        else:
            ok, reason = await _verify_hedera_payment(tx_id)
        if not ok:
            return JSONResponse(
                status_code=402,
                content={"x402Version": 1, "error": reason},
                headers={"X-402-Version": "1"},
            )

        return await call_next(request)
