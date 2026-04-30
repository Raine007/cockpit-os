#!/usr/bin/env bash
#
# Cockpit OS — Cloud Run deploy script.
#
# Idempotent. Run it as many times as you want; it only does what's needed.
#
# Prerequisites (the script will fail loudly with an explanation if missing):
#   - gcloud CLI installed and `gcloud auth login` done
#   - GCP project created with billing enabled
#   - Docker NOT required — we use Cloud Build to build the image in the cloud
#
# Usage:
#   ./deploy.sh
#
# Override defaults via env:
#   PROJECT_ID=my-project REGION=us-west1 SERVICE=cockpit ./deploy.sh

set -euo pipefail

# ---------- config ----------
PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-cockpit-os}"
ARTIFACT_REPO="${ARTIFACT_REPO:-cockpit-os}"
IMAGE_NAME="${IMAGE_NAME:-cockpit-os}"
HOOKS_SECRET_NAME="${HOOKS_SECRET_NAME:-cockpit-hooks-token}"
ADMIN_SECRET_NAME="${ADMIN_SECRET_NAME:-cockpit-admin-token}"

# ---------- helpers ----------
red()    { printf "\033[31m%s\033[0m\n" "$*" >&2; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
bold()   { printf "\033[1m%s\033[0m\n" "$*"; }
step()   { echo; bold "▶ $*"; }

die() { red "ERROR: $*"; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is not installed. See https://cloud.google.com/sdk/docs/install"
}

# ---------- 0. preflight ----------
step "Preflight checks"

require_cmd gcloud
require_cmd openssl

# Pull project from gcloud config if not provided.
if [ -z "$PROJECT_ID" ]; then
  PROJECT_ID="$(gcloud config get-value project 2>/dev/null || true)"
fi
[ -z "$PROJECT_ID" ] && die "PROJECT_ID is unset and no default project is configured. Run: gcloud config set project YOUR_PROJECT_ID"

# Confirm we're authed.
ACTIVE_ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n1)"
[ -z "$ACTIVE_ACCOUNT" ] && die "Not logged in. Run: gcloud auth login"

# Confirm billing is enabled.
BILLING_ENABLED="$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null || echo 'false')"
if [ "$BILLING_ENABLED" != "True" ] && [ "$BILLING_ENABLED" != "true" ]; then
  die "Billing is not enabled on project $PROJECT_ID. Open https://console.cloud.google.com/billing and link a billing account."
fi

green "  account:    $ACTIVE_ACCOUNT"
green "  project:    $PROJECT_ID"
green "  region:     $REGION"
green "  service:    $SERVICE"

# ---------- 1. enable APIs ----------
step "Enabling required Google Cloud APIs (idempotent)"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com \
  --project "$PROJECT_ID"

# ---------- 2. ensure Firestore database exists ----------
step "Ensuring Firestore database exists"
if ! gcloud firestore databases describe --database='(default)' --project="$PROJECT_ID" >/dev/null 2>&1; then
  yellow "  no Firestore database — creating one in $REGION (Native mode)..."
  gcloud firestore databases create \
    --location="$REGION" \
    --type=firestore-native \
    --project="$PROJECT_ID"
else
  green "  Firestore database already exists."
fi

# ---------- 3. ensure Artifact Registry repo ----------
step "Ensuring Artifact Registry repo for the container image"
if ! gcloud artifacts repositories describe "$ARTIFACT_REPO" \
    --location="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  yellow "  creating Artifact Registry repo '$ARTIFACT_REPO'..."
  gcloud artifacts repositories create "$ARTIFACT_REPO" \
    --repository-format=docker \
    --location="$REGION" \
    --description="Cockpit OS images" \
    --project="$PROJECT_ID"
else
  green "  repo already exists."
fi

# ---------- 4. ensure secrets ----------
step "Ensuring bearer-token secrets in Secret Manager"

ensure_secret() {
  local name="$1"
  if ! gcloud secrets describe "$name" --project="$PROJECT_ID" >/dev/null 2>&1; then
    yellow "  creating secret '$name' with a fresh random token..."
    local val
    val="$(openssl rand -hex 32)"
    printf '%s' "$val" | gcloud secrets create "$name" \
      --replication-policy=automatic \
      --data-file=- \
      --project="$PROJECT_ID"
    green "  '$name' created (32-byte hex)."
  else
    green "  '$name' already exists — leaving it alone (rotate manually if needed)."
  fi
}

ensure_secret "$HOOKS_SECRET_NAME"
ensure_secret "$ADMIN_SECRET_NAME"

# ---------- 5. build & push image via Cloud Build ----------
step "Building container image with Cloud Build"
IMAGE_URI="$REGION-docker.pkg.dev/$PROJECT_ID/$ARTIFACT_REPO/$IMAGE_NAME:$(date -u +%Y%m%d-%H%M%S)"
green "  building $IMAGE_URI"
gcloud builds submit \
  --tag "$IMAGE_URI" \
  --project="$PROJECT_ID" \
  --region="$REGION"

# ---------- 6. ensure runtime service account has the right roles ----------
step "Granting Cloud Run runtime service account access to Firestore + secrets"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
SA="$PROJECT_NUMBER-compute@developer.gserviceaccount.com"

for role in \
  roles/datastore.user \
  roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$SA" \
    --role="$role" \
    --condition=None \
    --quiet >/dev/null
done
green "  $SA has datastore.user + secretmanager.secretAccessor"

# ---------- 7. deploy to Cloud Run ----------
step "Deploying to Cloud Run"

gcloud run deploy "$SERVICE" \
  --image="$IMAGE_URI" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --platform=managed \
  --allow-unauthenticated \
  --port=8080 \
  --cpu=1 \
  --memory=512Mi \
  --min-instances=0 \
  --max-instances=10 \
  --concurrency=80 \
  --timeout=60s \
  --set-env-vars="FIREBASE_PROJECT_ID=$PROJECT_ID,COCKPIT_LOG_LEVEL=info" \
  --set-secrets="OPENCLAW_HOOKS_TOKEN=$HOOKS_SECRET_NAME:latest,COCKPIT_ADMIN_TOKEN=$ADMIN_SECRET_NAME:latest"

URL="$(gcloud run services describe "$SERVICE" --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)')"

# ---------- 8. smoke ----------
step "Smoke testing the deployed service"
sleep 3
# /healthz is intercepted by Google Frontend on Cloud Run; use the /_health alias.
HEALTH="$(curl -fsS "$URL/_health" || echo 'FAIL')"
READY="$(curl -fsS "$URL/readyz"  || echo 'FAIL')"
green "  /_health  → $HEALTH"
green "  /readyz   → $READY"

echo
bold "✓ Cockpit OS is live."
echo
echo "  Public URL:        $URL"
echo "  Dashboard:         $URL/"
echo "  Inbound hooks:     $URL/hooks/cockpit-:mappingId"
echo "  Computer callback: $URL/hooks/computer-done"
echo
echo "  Secrets are stored in Secret Manager. To read your tokens:"
echo "    gcloud secrets versions access latest --secret=$HOOKS_SECRET_NAME --project=$PROJECT_ID"
echo "    gcloud secrets versions access latest --secret=$ADMIN_SECRET_NAME --project=$PROJECT_ID"
echo
echo "  To deploy a new build later, just re-run this script."
echo "  To roll back:  gcloud run services update-traffic $SERVICE --to-revisions=<REVISION>=100 --region=$REGION"
