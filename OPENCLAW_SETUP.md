# Cockpit OS ↔ OpenClaw — Windows PC Setup

Wire OpenClaw on your Windows PC to consume the Cockpit OS MCP server, so OpenClaw becomes the agent doing real work (browser, files, shell, the 100+ AgentSkills) while Cockpit stays the dashboard + state store on Cloud Run.

> **Important:** OpenClaw on Windows runs through **WSL2** (Windows Subsystem for Linux). The OpenClaw team strongly recommends this — native Windows is not officially supported. WSL2 gives you a real Linux environment running inside Windows, no dual-boot needed.

---

## Step 0 — Install WSL2 (one-time, ~10 min)

Open **PowerShell as Administrator** and run:

```powershell
wsl --install
```

Reboot when prompted. After reboot, Ubuntu opens automatically and asks you to set a username + password. Pick anything — this is your Linux user, separate from Windows.

After that, open **Ubuntu** from the Start menu any time you want a Linux shell. Everything below runs there.

Optional but worth doing — install **Windows Terminal** from the Microsoft Store. It gives you a way better tabbed shell experience than the default one.

---

## Step 1 — Install Node.js inside WSL

In your Ubuntu terminal:

```bash
# Install nvm (Node version manager)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash

# Reload shell
source ~/.bashrc

# Install Node 22 LTS
nvm install 22
nvm use 22

# Verify
node --version    # should print v22.x
npm --version
```

## Step 2 — Install OpenClaw

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

`openclaw onboard` walks you through:
- Picking a model (Claude / GPT / Gemini / local Ollama on your GPU — your call, your API key)
- Connecting messaging channels (WhatsApp, Telegram, Discord, iMessage — pick whichever you want)
- Creating the workspace at `~/.openclaw/workspace`

When it finishes, the gateway runs as a background daemon inside WSL.

> **Heads up:** WSL2 daemons stop when you close the WSL window unless you run them under systemd or as a Windows service. The `--install-daemon` flag handles this — it sets up the gateway to auto-start when WSL boots. If it stops behaving, run `openclaw gateway restart`.

## Step 3 — Clone & build the Cockpit MCP server

```bash
# Clone wherever you want the source
cd ~
git clone <your-cockpit-repo-url> cockpit-os
cd cockpit-os

npm install
npm run build
npm link    # makes `cockpit-mcp` available on PATH inside WSL
```

Verify:

```bash
which cockpit-mcp
# /home/<you>/.nvm/versions/node/v22.x.x/bin/cockpit-mcp
```

> If you don't have a Git repo for Cockpit yet, I can zip the workspace tree (`/home/user/workspace/cockpit-os/`) so you can download it directly to WSL and `npm install` from there. Just ask.

## Step 4 — Register Cockpit as an MCP server in OpenClaw

Copy this whole block and paste it into your WSL shell:

```bash
openclaw mcp set cockpit '{
  "command": "cockpit-mcp",
  "env": {
    "COCKPIT_UID": "raine",
    "FIREBASE_PROJECT_ID": "cockpit-os-yt-1777481051",
    "COCKPIT_BACKEND_URL": "https://cockpit-os-646650189890.us-central1.run.app",
    "COCKPIT_ADMIN_TOKEN": "bbb5b4b87feb6a4d7cecee7bd6d1e9e3c857e934fccaca3ceb351b0e90f42510"
  }
}'
```

Verify:

```bash
openclaw mcp list
# cockpit   running   5 tools   stdio
```

The 5 tools are your registered capabilities: `note-append`, `task-create`, `task-list`, `flight-log`, plus any others you add later.

## Step 5 — Restart the gateway

```bash
openclaw gateway restart
```

## Step 6 — Test it from your phone

In whichever messaging channel you wired up in step 2 (WhatsApp / Telegram / Discord / iMessage), send your agent a message:

> "Add a quick note to Cockpit: pick up sectional charts at FBO Friday"

OpenClaw will:
1. Match it to the `note-append` capability via MCP
2. Call `cockpit-mcp` over stdio inside WSL
3. The capability writes via `COCKPIT_BACKEND_URL` to Cloud Run → Firestore
4. The note appears on your iPad in Quick Notes within 30s (next poll cycle)
5. The hourly Todoist sync routes it to **🏗️ Hustles** or **✈️ Pilot Training** etc.

---

## Why this is so good on a powerful PC

You said you have a beefy rig. That actually matters here:

- **Run a local model**: skip Claude/GPT API costs entirely. Install Ollama in WSL (`curl -fsSL https://ollama.com/install.sh | sh`), pull a model that fits your GPU (`ollama pull qwen2.5:32b` or `llama3.3:70b` if you have 24GB+ VRAM), point OpenClaw at it. Free agent labor forever.
- **24/7 uptime**: PC stays on → OpenClaw stays on → your phone always has an agent.
- **Browser automation has somewhere fast to run**: instead of me booting an isolated cloud browser per task, OpenClaw drives Chrome on your local machine.

## What this gets you

| Before | After |
|---|---|
| I (Computer) ran your Todoist sync — credit cost per run | OpenClaw runs locally on your PC, free, 24/7 |
| You typed notes only on the iPad UI | Type from WhatsApp / Telegram / Discord / iMessage and they hit Cockpit |
| Cockpit's `capabilities/` framework was dead code | Every capability is now a real OpenClaw tool |
| MCP server in `src/mcp/server.ts` was unused | Live, serving 5+ tools to your agent |
| Browser/research/file work cost Computer credits | OpenClaw does it on your hardware |

## After it's running, tell me and I'll:

1. Kill the hourly Todoist cron I scheduled (no longer needed — OpenClaw can do it locally)
2. Add a `todoist-sync` capability to Cockpit so OpenClaw owns that loop
3. Wire `/api/computer/offload` to POST to your local OpenClaw gateway (via Cloudflare Tunnel or Tailscale) so the iPad's "Send to Computer" button hits your PC instead of me

## Troubleshooting (Windows-specific)

- **`wsl: command not found`**: Windows version too old. Update to Windows 10 21H2+ or Windows 11.
- **WSL is slow / Node install hangs**: file system performance is bad on `/mnt/c/...`. Always work inside the Linux home dir (`~`), never on the Windows C: drive.
- **`openclaw mcp list` shows `cockpit` as `error`**: run `openclaw doctor --fix` and check `~/.openclaw/logs/`.
- **Tools don't show up in agent**: gateway didn't restart after `mcp set`. Run `openclaw gateway restart`.
- **`cockpit-mcp: command not found`**: `npm link` step failed. Use absolute path instead in step 4: `"command": "node", "args": ["/home/<you>/cockpit-os/dist/mcp/server.js"]`.
- **Auth errors writing to backend**: `COCKPIT_ADMIN_TOKEN` env var didn't make it through. Check with `openclaw mcp show cockpit`.
- **WSL daemon dies overnight**: the `--install-daemon` flag should have handled this, but if not, set up systemd auto-start: `sudo systemctl enable openclaw-gateway`. Or set `wsl --shutdown` policy to keep WSL up.

## Hit me up when you start

Open this guide on your iPad while you're at the PC. When a step breaks or returns a weird error, paste the output here and I'll unstick it.
