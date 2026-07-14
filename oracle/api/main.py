"""
Oracle API
----------
Lightweight FastAPI server exposing oracle data for:
  - CRE workflow  → GET /api/oracle/pending-events
  - Blockchain processor → same endpoint
  - Frontend / external consumers → parcel history, petition details

Run:
  python -m oracle.api.main
  or: uvicorn oracle.api.main:app --reload --port 8001
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from oracle.api.routes import events, parcels, petitions, health
from oracle.api.middleware.x402 import X402Middleware

app = FastAPI(
    title="ZoneProof Oracle API",
    description="Oracle data layer — change events, parcel history, petition registry",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

# CORS must be added before x402 so preflight OPTIONS requests pass through
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*", "X-Payment"],
    expose_headers=["X-402-Version"],
)

# x402 payment gate — sits inside CORS, only runs on matched protected routes
app.add_middleware(X402Middleware)

app.include_router(health.router,    prefix="/api/oracle")
app.include_router(events.router,    prefix="/api/oracle")
app.include_router(parcels.router,   prefix="/api/oracle")
app.include_router(petitions.router, prefix="/api/oracle")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("oracle.api.main:app", host="0.0.0.0", port=8001, reload=True)
