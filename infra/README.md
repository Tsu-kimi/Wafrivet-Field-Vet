# infra/ — Infrastructure as Code

This directory contains reference configuration for the **fieldvet-backend** Cloud Run service.

> **Note:** Cloud Deployment Manager does not support Cloud Run in new GCP projects.
> All deployments are done directly with `gcloud run deploy` as documented below.

## Files

| File | Purpose |
|---|---|
| `field-vet-cloudrun.jinja` | Legacy Deployment Manager template (reference only — not used) |
| `field-vet-config.yaml` | Reference config — image path and service parameters |

---

## Prerequisites

```bash
# Authenticate with GCP
gcloud auth login
gcloud config set project wafrivet-agent

# Enable required APIs
gcloud services enable run.googleapis.com --project wafrivet-agent
gcloud services enable artifactregistry.googleapis.com --project wafrivet-agent
gcloud services enable secretmanager.googleapis.com --project wafrivet-agent
gcloud services enable aiplatform.googleapis.com --project wafrivet-agent
```

The Cloud Run service account (`fieldvet-backend@wafrivet-agent.iam.gserviceaccount.com`)
must already exist and have the following roles **before** deploying:

- `roles/run.invoker` — allows Cloud Run to invoke itself internally
- `roles/secretmanager.secretAccessor` — scoped to each individual secret (see `deploy/deploy.sh`)
- `roles/aiplatform.user` — for Vertex AI Embedding API calls in `disease.py`

Create the service account if it does not exist:

```bash
gcloud iam service-accounts create fieldvet-backend \
  --display-name="FieldVet Cloud Run Service Account" \
  --project wafrivet-agent

gcloud projects add-iam-policy-binding wafrivet-agent \
  --member="serviceAccount:fieldvet-backend@wafrivet-agent.iam.gserviceaccount.com" \
  --role="roles/run.invoker"

gcloud projects add-iam-policy-binding wafrivet-agent \
  --member="serviceAccount:fieldvet-backend@wafrivet-agent.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

gcloud projects add-iam-policy-binding wafrivet-agent \
  --member="serviceAccount:fieldvet-backend@wafrivet-agent.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"
```

---

## Step 1 — Create Artifact Registry repository (once only)

```bash
gcloud artifacts repositories create fieldvet-images \
  --repository-format=docker \
  --location=us-central1 \
  --project wafrivet-agent

# Authenticate Docker to push images
gcloud auth configure-docker us-central1-docker.pkg.dev
```

---

## Step 2 — Build and push the Docker image

Run from the **repo root**:

```bash
docker build \
  --platform linux/amd64 \
  --tag us-central1-docker.pkg.dev/wafrivet-agent/fieldvet-images/backend:latest \
  --file Dockerfile \
  .

docker push us-central1-docker.pkg.dev/wafrivet-agent/fieldvet-images/backend:latest
```

---

## Step 3 — Deploy to Cloud Run (first deployment)

```bash
gcloud run deploy fieldvet-backend \
  --image us-central1-docker.pkg.dev/wafrivet-agent/fieldvet-images/backend:latest \
  --region us-central1 \
  --project wafrivet-agent \
  --service-account fieldvet-backend@wafrivet-agent.iam.gserviceaccount.com \
  --timeout=3600 \
  --min-instances=1 \
  --concurrency=1000 \
  --allow-unauthenticated
```

## Update (subsequent deployments)

Rebuild and push the image (Step 2), then re-run:

```bash
gcloud run deploy fieldvet-backend \
  --image us-central1-docker.pkg.dev/wafrivet-agent/fieldvet-images/backend:latest \
  --region us-central1 \
  --project wafrivet-agent \
  --service-account fieldvet-backend@wafrivet-agent.iam.gserviceaccount.com \
  --timeout=3600 \
  --min-instances=1 \
  --concurrency=1000 \
  --allow-unauthenticated
```

## Delete (teardown)

```bash
gcloud run services delete fieldvet-backend \
  --region us-central1 \
  --project wafrivet-agent
```

> **Warning:** This deletes the Cloud Run service but does **not** delete Secret Manager
> secrets, the Artifact Registry repository, or the service account. Those are
> independent GCP resources and must be deleted separately if required.

---

## Fresh deployment from scratch

A complete redeploy from a clean checkout takes under 5 minutes:

```bash
# 1. Authenticate
gcloud auth login
gcloud config set project wafrivet-agent
gcloud auth configure-docker us-central1-docker.pkg.dev

# 2. Build and push the image (from repo root)
docker build --platform linux/amd64 \
  --tag us-central1-docker.pkg.dev/wafrivet-agent/fieldvet-images/backend:latest \
  --file Dockerfile .
docker push us-central1-docker.pkg.dev/wafrivet-agent/fieldvet-images/backend:latest

# 3. Deploy to Cloud Run
gcloud run deploy fieldvet-backend \
  --image us-central1-docker.pkg.dev/wafrivet-agent/fieldvet-images/backend:latest \
  --region us-central1 \
  --project wafrivet-agent \
  --service-account fieldvet-backend@wafrivet-agent.iam.gserviceaccount.com \
  --timeout=3600 \
  --min-instances=1 \
  --concurrency=1000 \
  --allow-unauthenticated
```

---

## Template parameters reference

| Parameter | Type | Default | Description |
|---|---|---|---|
| `serviceName` | string | — | Cloud Run service name |
| `image` | string | — | Full Artifact Registry image path + tag |
| `region` | string | — | GCP region |
| `serviceAccountName` | string | — | Full SA email |
| `timeoutSeconds` | int | 3600 | Max WebSocket session lifetime |
| `minInstances` | int | 1 | Minimum warm instances (prevent cold-start) |
| `concurrency` | int | 1000 | Concurrent WebSocket connections per instance |
| `startupInitialDelay` | int | 10 | Seconds before first startup probe |
| `startupFailureLimit` | int | 5 | Probe failures before container restart |
| `secrets` | list | [] | `[{envName, secretName}]` Secret Manager refs |
