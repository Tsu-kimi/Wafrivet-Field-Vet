"""
backend/streaming/__init__.py

Phase 3 — Gemini Live streaming layer for Wafrivet Field Vet.

Exposes:
    app  — the FastAPI application (for uvicorn)
"""
from backend.streaming.server import app  # noqa: F401
