# OpenClaw Bridge

Standalone Node.js polling bridge that connects **Cockpit OS** (Cloud Run) with **OpenClaw** running locally in WSL2.

## What it does

1. Polls `GET /api/chat/pending` on your Cockpit backend every 3 seconds for queued chat jobs.
2. Forwards each message to OpenClaw's local HTTP gateway.
3. Classifies OpenClaw's response:
   - Contains `[ASK]` → posts a clarifying question to `/api/feedback/ask` (shows up in the Feedback tab)
   - Contains `[ESCALATE]` or video-editing keywords → escalates to Computer via `/api/chat/escalate`
   - Everything else → posts a reply via `/api/chat/reply` (shows up in the Chat tab)

---

## Quick Start

### 1. Install

```bash
cd /path/to/cockpit-os/bridge
npm install
```

### 2. Set environment variables

Create a `.env` file (or export the variables in your shell):

```bash
export COCKPIT_BACKEND_URL="https://cockpit-os-646650189890.us-central1.run.app"
export COCKPIT_ADMIN_TOKEN="bbb5b4b87feb6a4d7cecee7bd6d1e9e3c857e934fccaca3ceb351b0e90f42510"
export OPENCLAW_GATEWAY_URL="http://127.0.0.1:18789"
export OPENCLAW_GATEWAY_TOKEN="<your-openclaw-token>"
```

Optional:
```bash
export BRIDGE_POLL_INTERVAL_MS=3000   # poll every 3s (default)
export BRIDGE_LOG_LEVEL=info           # "debug" | "info" | "error"
```

### 3. Run

```bash
npm start
# or
node openclaw-bridge.js
```

---

## Run as a systemd service in WSL2

This keeps the bridge running in the background and restarts automatically if it crashes.

### Create the service file

```bash
sudo nano /etc/systemd/system/openclaw-bridge.service
```

Paste this (adjust paths as needed):

```ini
[Unit]
Description=OpenClaw → Cockpit OS Bridge
After=network.target

[Service]
Type=simple
User=raine
WorkingDirectory=/home/raine/cockpit-os/bridge
Environment="COCKPIT_BACKEND_URL=https://cockpit-os-646650189890.us-central1.run.app"
Environment="COCKPIT_ADMIN_TOKEN=bbb5b4b87feb6a4d7cecee7bd6d1e9e3c857e934fccaca3ceb351b0e90f42510"
Environment="OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789"
Environment="OPENCLAW_GATEWAY_TOKEN=<your-openclaw-token>"
Environment="BRIDGE_LOG_LEVEL=info"
ExecStart=/usr/bin/node /home/raine/cockpit-os/bridge/openclaw-bridge.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

### Enable and start

```bash
sudo systemctl daemon-reload
sudo systemctl enable openclaw-bridge
sudo systemctl start openclaw-bridge
sudo systemctl status openclaw-bridge
```

### View logs

```bash
sudo journalctl -u openclaw-bridge -f
```

---

## OpenClaw response conventions

The bridge reads OpenClaw's response text and looks for signal strings:

| Signal in response              | Bridge action                        |
|---------------------------------|--------------------------------------|
| `[ASK] <question>`              | Posts to `/api/feedback/ask`         |
| `[ESCALATE]` or video-editing keywords | Posts to `/api/chat/escalate` |
| Anything else                   | Posts to `/api/chat/reply`           |

**To have OpenClaw ask a clarifying question:**
```
[ASK] Which reel clip should I use — the sunset taxi or the instrument panel?
```

**To have OpenClaw escalate to Computer for video editing:**
```
[ESCALATE] This requires video editing. Specs: Fredoka One font, 1080px, 9:16 crop.
```

---

## Troubleshooting

**"COCKPIT_ADMIN_TOKEN is required"**
→ Make sure you've exported the environment variable before running.

**HTTP 401 from Cockpit**
→ Check your `COCKPIT_ADMIN_TOKEN`. It must match the `COCKPIT_ADMIN_TOKEN` env var on Cloud Run.

**OpenClaw not responding**
→ Confirm OpenClaw's gateway is running: `curl -s http://127.0.0.1:18789/v1/health`

**Bridge running but no messages appearing**
→ Check that you're sending messages via the Chat tab on the Cockpit dashboard (iPad polls every 3s). The bridge only processes `status=queued` jobs.
