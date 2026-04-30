# Deploy cockpit-os from WSL

Condensed runbook. Total time: ~5 min after one-time setup.

## One-time setup (skip if done)

```bash
sudo apt update && sudo apt install -y google-cloud-cli git
gcloud auth login
gcloud auth application-default login
gcloud config set project <your-project-id>
cd ~ && git clone https://github.com/Raine007/cockpit-os.git   # only if not cloned
```

Clone in `~/`, NOT `/mnt/c/...` — Windows paths break Docker/Cloud Build.

## Deploy

```bash
cd ~/cockpit-os && git pull && bash deploy.sh
```

Idempotent. Enables APIs, runs Cloud Build, rolls out new Cloud Run revision.

## Verify

```bash
curl https://cockpit-os-646650189890.us-central1.run.app/api/version
gcloud run revisions list --service=cockpit-os --region=us-central1 --limit=3
```

New revision should increment (e.g. `00014` → `00015`).

## Troubleshooting

- **`gcloud auth login` hangs** — use `gcloud auth login --no-launch-browser` and paste the URL into a Windows browser manually.
- **Permission denied on deploy.sh** — `chmod +x deploy.sh`.
- **Build fails on missing API** — `deploy.sh` enables APIs automatically; if it skipped, run `gcloud services enable run.googleapis.com cloudbuild.googleapis.com firestore.googleapis.com`.
- **Wrong project** — `gcloud config get-value project` to check, `gcloud config set project <id>` to fix.

## Rollback

```bash
gcloud run services update-traffic cockpit-os --region=us-central1 --to-revisions=cockpit-os-00014-68z=100
```
