# syntax=docker/dockerfile:1

# =============================================================================
# Wafrivet Field Vet — Production Dockerfile
# Phase 4: Cloud Run deployment
#
# Entry point : uvicorn backend.streaming.server:app
# Exposed port: $PORT  (Cloud Run injects this at runtime; default 8080)
# Live model  : gemini-2.0-flash-live-001
#               Requires google-genai >= 1.0.0 (declared in requirements.txt)
#
# Secrets are NOT embedded here.  All credentials are injected at runtime
# via Cloud Run --set-secrets bound to GCP Secret Manager.
# =============================================================================

FROM python:3.12-slim

LABEL org.opencontainers.image.title="wafrivet-agent-backend"
LABEL org.opencontainers.image.description="Wafrivet Field Vet – FastAPI + ADK streaming backend"
LABEL org.opencontainers.image.source="https://github.com/Tsu-kimi/Wafrivet-Field-Vet"

# ── Security: drop to a non-root user before the process starts ────────────
RUN groupadd --gid 1001 appgroup \
 && useradd  --uid 1001 --gid 1001 --shell /bin/sh --no-create-home appuser

WORKDIR /app

# ── Dependency layer (cached separately from application code) ─────────────
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r requirements.txt

# ── Application code ───────────────────────────────────────────────────────
# Only the backend package and the example env template are copied.
# The real .env file must NEVER be included in the image.
COPY backend/ ./backend/

# ── Runtime environment ────────────────────────────────────────────────────
# Cloud Run overrides PORT at container startup time.
# 8080 is the default for local `docker run` without -e PORT=...
ENV PORT=8080
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
# Tell ADK/google-genai to use the API-key path (not Vertex AI) by default.
# Cloud Run's --set-env-vars or Secret Manager can override this for Vertex.
ENV GOOGLE_GENAI_USE_VERTEXAI=FALSE

# ── Drop privileges ────────────────────────────────────────────────────────
USER appuser

# ── Startup command ────────────────────────────────────────────────────────
# Shell form is intentional: the shell expands $PORT at container start time,
# picking up whatever Cloud Run has injected into the environment.
# --workers 1 keeps ADK's in-memory session state consistent per instance.
CMD ["uvicorn", "backend.streaming.server:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
