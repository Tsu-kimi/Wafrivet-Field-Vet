# deploy/ — Build, Push & Deployment Scripts

> **Important:** Cloud Deployment Manager does not support Cloud Run in new GCP projects.
> All Cloud Run deployments use `gcloud run deploy` directly, as documented here and in `infra/README.md`.

## Files

| File | Purpose |
|---|---|
| `deploy.sh` | One-shot script: create secrets → build image → push to AR → deploy to Cloud Run |

---

## PART 9 — Local Docker Testing (before pushing to Cloud Run)

Run these commands from the **repo root** to validate the Dockerfile locally before
committing a broken image to Artifact Registry.

```bash
# 1. Build the image locally
docker build \
  --platform linux/amd64 \
  --tag wafrivet-backend:local \
  --file Dockerfile \
  .

# 2. Run the container — pass secrets via --env-file pointing at your .env
#    (uses real Supabase/Gemini keys from local .env; not for CI pipelines)
docker run --rm \
  --env-file .env \
  --publish 8080:8080 \
  --name wafrivet-local \
  wafrivet-backend:local

# Expected startup output (within 5 s):
#   {"event": "wafrivet_streaming_startup", "live_model": "gemini-2.0-flash-live-001", ...}
#   {"event": "runner_ready", "agent": "wafrivet_field_vet", ...}
#   INFO:     Application startup complete.
#   INFO:     Uvicorn running on http://0.0.0.0:8080

# 3. Verify /health returns 200
curl -s http://localhost:8080/health | python -m json.tool
# Expected:
# {
#   "status": "ok",
#   "checks": { "supabase": "ok", "auth": "ok" },
#   "model": "gemini-2.0-flash-live-001"
# }

# 4. Connect with wscat to verify WebSocket works locally
#    Install wscat if needed: npm install -g wscat
wscat --connect ws://localhost:8080/ws/localuser/localsession001

# Expected wscat output within 3 s:
#   Connected (press CTRL+C to quit)
#
# Send a text init message:
#   > {"type": "TEXT", "text": "My goat has a swollen belly and won't eat"}
#
# Expected response events (JSON text frames):
#   < {"type": "TRANSCRIPTION", "text": "My goat has a swollen belly...", "author": "user", "is_final": true}
#   < {"type": "TRANSCRIPTION", "text": "I can help you identify...", "author": "agent", "is_final": false}
#   < {"type": "TURN_COMPLETE"}

# 5. Stop the local container
docker stop wafrivet-local
```

---

## PART 8 — Deployment Verification with wscat (Cloud Run)

After deploying with `deploy.sh`, verify the live Cloud Run service:

```bash
# Retrieve the service URL
SERVICE_URL=$(gcloud run services describe fieldvet-backend \
  --region=us-central1 \
  --project=wafrivet-agent \
  --format="value(status.url)")

# Replace https:// with wss:// for WebSocket connection
WS_URL="${SERVICE_URL/https:\/\//wss://}/ws/testuser001/testsession001"
echo "Connecting to: ${WS_URL}"

# Connect — Cloud Run HTTPS/TLS is terminated at the load balancer;
# the WebSocket upgrade happens over HTTP/1.1 (--no-http2 ensures this).
wscat --connect "${WS_URL}"
```

### Expected successful connection output

```
Connected (press CTRL+C to quit)
```

### Send a session initialisation message

```json
{"type": "TEXT", "text": "My goat belly is swollen and she is not eating for two days"}
```

### Expected response events

```jsonc
// User transcription (mirrored back)
{"type":"TRANSCRIPTION","text":"My goat belly is swollen and she is not eating for two days","author":"user","is_final":true}

// Agent starts replying (streaming transcription)
{"type":"TRANSCRIPTION","text":"I'm sorry to hear about your goat","author":"agent","is_final":false}

// Products recommended after disease match
{"type":"PRODUCTS_RECOMMENDED","data":{"disease":"Ruminal Bloat","products":[...]}}

// Turn complete
{"type":"TURN_COMPLETE"}
```

---

## Cloud Run log fields that confirm a healthy connection

Stream logs during a test connection:

```bash
gcloud run services logs read fieldvet-backend \
  --region=us-central1 \
  --project=wafrivet-agent \
  --limit=50 \
  --format=json
```

| Log field | Value that confirms success |
|---|---|
| `jsonPayload.event` | `"ws_connected"` → WebSocket connection accepted |
| `jsonPayload.event` | `"session_created"` → ADK session created |
| `jsonPayload.event` | `"downstream_event"` with `event_type="turn_complete"` → first Gemini event received |
| `jsonPayload.session_id` | Your test session ID (confirms session affinity routing) |
| `jsonPayload.user_id` | Your test user ID |
| `jsonPayload.elapsed_ms` | Milliseconds from connection open to event — should be < 5000 for first Gemini response |

These structured log fields are emitted by `bridge.py`'s `_log()` helper and are
the exact fields that should appear in the Cloud Run log stream screenshot for the
hackathon GCP proof deliverable.

---

## Full deployment from a clean checkout

```bash
# 1. Clone the repo
git clone https://github.com/Tsu-kimi/Wafrivet-Field-Vet.git
cd Wafrivet-Field-Vet

# 2. Authenticate with GCP
gcloud auth login
gcloud config set project wafrivet-agent
gcloud auth configure-docker us-central1-docker.pkg.dev

# 3. Create Artifact Registry repo (skip if it already exists)
gcloud artifacts repositories create fieldvet-images \
  --repository-format=docker \
  --location=us-central1 \
  --project wafrivet-agent

# 4. Build and push the Docker image (run from repo root)
docker build \
  --platform linux/amd64 \
  --tag us-central1-docker.pkg.dev/wafrivet-agent/fieldvet-images/backend:latest \
  --file Dockerfile \
  .
docker push us-central1-docker.pkg.dev/wafrivet-agent/fieldvet-images/backend:latest

# 5. Set secret values in your shell before running deploy.sh
export GOOGLE_API_KEY="AIza..."
export SUPABASE_URL="https://itgavztsmnujovjmtoit.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="eyJ..."
export PAYSTACK_SECRET_KEY="sk_test_..."
export GOOGLE_CLOUD_PROJECT="wafrivet-agent"

# 6. Run the full deploy pipeline (creates secrets + deploys to Cloud Run)
bash deploy/deploy.sh
```

> Make sure Docker Desktop is running before the `docker build` step.

Total time from a clean checkout: **< 5 minutes** on a standard broadband connection.
