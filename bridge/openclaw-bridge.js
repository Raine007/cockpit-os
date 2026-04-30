#!/usr/bin/env node
/**
 * openclaw-bridge.js  (v2 — tool-calling)
 *
 * Polling bridge between Cockpit OS (Cloud Run) and OpenClaw on Raine's PC.
 *
 * What it does:
 *  1. Polls GET /api/chat/pending every 3s for kind=chat, status=queued.
 *  2. For each job:
 *      a. Pulls original message + tab_context.
 *      b. Asks the model with a system prompt that documents available tools.
 *      c. Runs a small tool-calling loop: parses [TOOL: name {json}] tags from the
 *         model output, executes them against Cockpit's /api/state/:key store,
 *         and feeds results back to the model. Loops up to MAX_TOOL_HOPS.
 *      d. Posts the final assistant text to /api/chat/reply, or escalates
 *         to Computer when the model emits [TOOL: escalate_to_computer ...].
 *
 * Configuration (env vars):
 *   COCKPIT_BACKEND_URL      Cockpit Cloud Run URL (required)
 *   COCKPIT_ADMIN_TOKEN      Cockpit admin bearer token (required)
 *   OLLAMA_URL               default http://127.0.0.1:11434
 *   OLLAMA_MODEL             default qwen2.5:7b-instruct
 *   OPENCLAW_GATEWAY_URL     default http://127.0.0.1:18789 (only if BACKEND=openclaw)
 *   OPENCLAW_GATEWAY_TOKEN   required when BRIDGE_BACKEND=openclaw
 *   BRIDGE_BACKEND           "ollama" (default) | "openclaw"
 *   BRIDGE_POLL_INTERVAL_MS  default 3000
 *   BRIDGE_LOG_LEVEL         "debug" | "info" | "error"  (default "info")
 *   BRIDGE_MAX_TOOL_HOPS     default 4
 */

import fetch from 'node-fetch';

/* ─────────────── Config ─────────────── */

const COCKPIT_BACKEND_URL = (process.env.COCKPIT_BACKEND_URL || '').replace(/\/$/, '');
const COCKPIT_ADMIN_TOKEN = process.env.COCKPIT_ADMIN_TOKEN || '';
const OPENCLAW_GATEWAY_URL = (process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789').replace(/\/$/, '');
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct';
const BACKEND = (process.env.BRIDGE_BACKEND || 'ollama').toLowerCase();
const POLL_INTERVAL_MS = parseInt(process.env.BRIDGE_POLL_INTERVAL_MS || '3000', 10);
const LOG_LEVEL = process.env.BRIDGE_LOG_LEVEL || 'info';
const MAX_TOOL_HOPS = parseInt(process.env.BRIDGE_MAX_TOOL_HOPS || '4', 10);
const MODEL_TIMEOUT_MS = parseInt(process.env.OPENCLAW_TIMEOUT_MS || '120000', 10);
const HEALTH_CHECK_INTERVAL_MS = parseInt(process.env.BRIDGE_HEALTH_CHECK_MS || '15000', 10);

// Backend health state — when unhealthy, jobs wait instead of failing loudly.
let _backendHealthy = true;
let _lastHealthCheckMs = 0;
let _lastHealthError = '';

/* ─────────────── Validation ─────────────── */

function validateConfig() {
  const errors = [];
  if (!COCKPIT_BACKEND_URL) errors.push('COCKPIT_BACKEND_URL is required');
  if (!COCKPIT_ADMIN_TOKEN) errors.push('COCKPIT_ADMIN_TOKEN is required');
  if (BACKEND === 'openclaw' && !OPENCLAW_GATEWAY_TOKEN) errors.push('OPENCLAW_GATEWAY_TOKEN is required when BRIDGE_BACKEND=openclaw');
  if (errors.length) {
    console.error('[bridge] Missing configuration:\n  ' + errors.join('\n  '));
    process.exit(1);
  }
}

/* ─────────────── Logger ─────────────── */

const LOG_LEVELS = { debug: 0, info: 1, error: 2 };
const LOG_THRESHOLD = LOG_LEVELS[LOG_LEVEL] ?? 1;

function log(level, msg, data) {
  if ((LOG_LEVELS[level] ?? 1) < LOG_THRESHOLD) return;
  const prefix = `[bridge][${level}] ${new Date().toISOString()} `;
  if (data !== undefined) {
    console[level === 'error' ? 'error' : 'log'](prefix + msg, JSON.stringify(data));
  } else {
    console[level === 'error' ? 'error' : 'log'](prefix + msg);
  }
}

/* ─────────────── Cockpit API helpers ─────────────── */

function cockpitHeaders() {
  return { 'Authorization': `Bearer ${COCKPIT_ADMIN_TOKEN}`, 'Content-Type': 'application/json' };
}

async function cockpitGet(path) {
  const res = await fetch(`${COCKPIT_BACKEND_URL}${path}`, { headers: cockpitHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Cockpit GET ${path} → HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

async function cockpitPost(path, body) {
  const res = await fetch(`${COCKPIT_BACKEND_URL}${path}`, {
    method: 'POST',
    headers: cockpitHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Cockpit POST ${path} → HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

async function cockpitPutState(key, value) {
  const res = await fetch(`${COCKPIT_BACKEND_URL}/api/state/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: cockpitHeaders(),
    body: JSON.stringify({ value }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Cockpit PUT /api/state/${key} → HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

async function cockpitGetState(key, fallback) {
  try {
    const data = await cockpitGet(`/api/state/${encodeURIComponent(key)}`);
    return (data && data.value !== undefined && data.value !== null) ? data.value : fallback;
  } catch {
    return fallback;
  }
}

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}

/* ─────────────── Tools ─────────────── */
/**
 * Each tool: async (args, ctx) => { ok: bool, result?: any, error?: string }
 * ctx contains: { tab, jobId, messageId, originalText }
 */
const TOOLS = {
  async add_task(args) {
    const text = (args && args.text) ? String(args.text).trim() : '';
    const project = (args && args.project) ? String(args.project) : 'today';
    if (!text) return { ok: false, error: 'missing "text"' };
    const key = `tasks_${todayKey()}`;
    const list = await cockpitGetState(key, []);
    const arr = Array.isArray(list) ? list : [];
    const id = 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    arr.push({ id, text, project, done: false, ts: new Date().toISOString() });
    await cockpitPutState(key, arr);
    return { ok: true, result: { id, text, project, total_today: arr.length } };
  },

  async mark_done(args) {
    const id = args && args.id ? String(args.id) : '';
    const text = args && args.text ? String(args.text).toLowerCase() : '';
    const key = `tasks_${todayKey()}`;
    const list = await cockpitGetState(key, []);
    const arr = Array.isArray(list) ? list : [];
    let target = null;
    if (id) target = arr.find((t) => t.id === id);
    if (!target && text) target = arr.find((t) => (t.text || '').toLowerCase().includes(text));
    if (!target) return { ok: false, error: 'no matching task found' };
    target.done = true;
    target.done_ts = new Date().toISOString();
    await cockpitPutState(key, arr);
    return { ok: true, result: { id: target.id, text: target.text, done: true } };
  },

  async list_tasks() {
    const key = `tasks_${todayKey()}`;
    const list = await cockpitGetState(key, []);
    const arr = Array.isArray(list) ? list : [];
    return { ok: true, result: arr.map((t) => ({ id: t.id, text: t.text, project: t.project, done: !!t.done })) };
  },

  async add_note(args) {
    const text = (args && args.text) ? String(args.text).trim() : '';
    if (!text) return { ok: false, error: 'missing "text"' };
    const list = await cockpitGetState('quick_notes', []);
    const arr = Array.isArray(list) ? list : [];
    const id = 'n_' + Date.now().toString(36);
    arr.unshift({ id, text, ts: new Date().toISOString() });
    await cockpitPutState('quick_notes', arr.slice(0, 200));
    return { ok: true, result: { id, total_notes: Math.min(arr.length, 200) } };
  },

  async set_caption(args) {
    const text = (args && args.text) ? String(args.text) : '';
    if (!text) return { ok: false, error: 'missing "text"' };
    await cockpitPutState('caption_draft', text);
    return { ok: true, result: { length: text.length } };
  },

  async log_discipline(args) {
    const score = args && typeof args.score === 'number' ? args.score : null;
    if (score === null || score < 0 || score > 10) return { ok: false, error: 'score must be 0-10' };
    const note = (args && args.note) ? String(args.note) : '';
    const key = `discipline_log_${todayKey()}`;
    const list = await cockpitGetState(key, []);
    const arr = Array.isArray(list) ? list : [];
    arr.push({ score, note, ts: new Date().toISOString() });
    await cockpitPutState(key, arr);
    return { ok: true, result: { score, total_today: arr.length } };
  },

  async get_holdings() {
    const h = await cockpitGetState('holdings', []);
    return { ok: true, result: Array.isArray(h) ? h : [] };
  },
};

const TOOL_DOC = `
AVAILABLE TOOLS (use only when the user asks you to DO something, not for chit-chat):
- add_task   {"text": "fix camera bracket", "project": "today|content|flight|money"} — adds a task to today's list
- mark_done  {"text": "camera bracket"} OR {"id": "t_xxx"} — marks a task done
- list_tasks {} — returns today's tasks
- add_note   {"text": "..."} — appends to quick notes
- set_caption {"text": "..."} — saves a caption draft
- log_discipline {"score": 8, "note": "skipped sweets"} — logs discipline score 0-10
- get_holdings {} — returns portfolio holdings
- escalate_to_computer {"reason": "..."} — punt to the bigger Computer agent for video edits / things you can't do

TOOL CALL FORMAT (one per line, tool blocks must be the FIRST thing in your reply):
[TOOL: tool_name {"arg":"value"}]

After the tool runs, you'll be asked to continue. Then respond with a SHORT, FRIENDLY confirmation (1-2 sentences). Do not call the same tool twice with the same args.

If the user is just chatting, DO NOT call tools. Reply normally in 1-3 sentences.
`.trim();

/* ─────────────── Prompt builder ─────────────── */

function buildSystemPrompt(tab, tabContext) {
  const tabBlurb = {
    today: 'You are looking at the TODAY tab: schedule, content reels, discipline tracker, and to-do list.',
    money: 'You are looking at the MONEY tab: holdings, monthly budget, job income.',
    flight: 'You are looking at the FLIGHT tab: flight log, CFI notes, training progress.',
  }[tab || 'today'] || '';

  let ctxBlurb = '';
  try {
    if (tabContext && typeof tabContext === 'object') {
      const trimmed = JSON.stringify(tabContext).slice(0, 1500);
      ctxBlurb = `\nCURRENT TAB CONTEXT (snapshot):\n${trimmed}\n`;
    }
  } catch { /* noop */ }

  return [
    "You are OpenClaw, Raine's personal local AI assistant running on his PC.",
    "Style: short, direct, 1-3 sentences max, no fluff. Slight callsign-vibe is fine but never robotic.",
    tabBlurb,
    ctxBlurb,
    TOOL_DOC,
  ].filter(Boolean).join('\n\n');
}

/* ─────────────── Tool tag parser ─────────────── */
/**
 * Finds [TOOL: name {json}] blocks. Tolerates code fences and whitespace.
 * Returns { calls: [{name, args, raw}], cleanText }.
 */
function parseToolCalls(text) {
  if (!text) return { calls: [], cleanText: '' };
  const calls = [];
  const re = /\[TOOL\s*:\s*([a-z_][a-z0-9_]*)\s*(\{[\s\S]*?\})?\s*\]/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    let args = {};
    if (m[2]) {
      try { args = JSON.parse(m[2]); } catch { args = { _parse_error: m[2] }; }
    }
    calls.push({ name, args, raw: m[0] });
  }
  const cleanText = text.replace(re, '').replace(/```[a-z]*\s*```/gi, '').trim();
  return { calls, cleanText };
}

/* ─────────────── Model call ─────────────── */

function extractText(json) {
  if (!json || typeof json !== 'object') return '';
  if (typeof json.response === 'string') return json.response;
  if (typeof json.text === 'string') return json.text;
  if (typeof json.content === 'string') return json.content;
  if (typeof json.reply === 'string') return json.reply;
  if (typeof json.output_text === 'string') return json.output_text;
  if (json.message && typeof json.message.content === 'string') return json.message.content;
  if (json.message && typeof json.message.text === 'string') return json.message.text;
  if (Array.isArray(json.choices) && json.choices[0]) {
    const c = json.choices[0];
    if (c.message && typeof c.message.content === 'string') return c.message.content;
    if (typeof c.text === 'string') return c.text;
  }
  return '';
}

/**
 * Lightweight health probe for the configured backend. Avoids burning a
 * full chat-completion attempt when the backend is obviously down.
 *
 *  - ollama:   GET /api/version          (cheap, no model load)
 *  - openclaw: GET /healthz, fall back to base URL
 *
 * Result is cached for HEALTH_CHECK_INTERVAL_MS so we don't hammer it.
 */
async function checkBackendHealth(force = false) {
  const now = Date.now();
  if (!force && now - _lastHealthCheckMs < HEALTH_CHECK_INTERVAL_MS) {
    return _backendHealthy;
  }
  _lastHealthCheckMs = now;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 4000);
  try {
    let url;
    if (BACKEND === 'ollama') {
      url = `${OLLAMA_URL}/api/version`;
    } else {
      url = `${OPENCLAW_GATEWAY_URL}/healthz`;
    }
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!_backendHealthy) log('info', `backend recovered (${BACKEND})`);
    _backendHealthy = true;
    _lastHealthError = '';
    return true;
  } catch (err) {
    const wasHealthy = _backendHealthy;
    _backendHealthy = false;
    _lastHealthError = String(err).slice(0, 200);
    if (wasHealthy) log('error', `backend unhealthy (${BACKEND}): ${_lastHealthError}`);
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function chatComplete(messages) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    let url, headers, payload;
    if (BACKEND === 'ollama') {
      url = `${OLLAMA_URL}/v1/chat/completions`;
      headers = { 'Content-Type': 'application/json' };
      payload = { model: OLLAMA_MODEL, messages, max_tokens: 384, stream: false };
    } else {
      url = `${OPENCLAW_GATEWAY_URL}/v1/chat/completions`;
      headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENCLAW_GATEWAY_TOKEN}` };
      payload = { model: process.env.OPENCLAW_MODEL || 'openclaw/main', messages, max_tokens: 384, stream: false };
    }
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal });
    const bodyText = await res.text();
    if (!res.ok) throw new Error(`POST ${url} → HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
    let json;
    try { json = JSON.parse(bodyText); } catch { json = { text: bodyText }; }
    // Successful call → mark backend healthy regardless of cached state.
    _backendHealthy = true;
    _lastHealthError = '';
    return extractText(json) || '';
  } catch (err) {
    // Network-class errors mark the backend unhealthy so the next poll waits.
    const msg = String(err);
    if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|socket hang up|aborted|fetch failed/i.test(msg)) {
      _backendHealthy = false;
      _lastHealthError = msg.slice(0, 200);
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

/* ─────────────── Tool-calling loop ─────────────── */

async function runToolLoop(systemPrompt, userText, ctx) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userText },
  ];

  let escalated = null;
  let finalText = '';

  for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
    const reply = await chatComplete(messages);
    log('debug', `hop ${hop} model reply: ${reply.slice(0, 120)}`);
    const { calls, cleanText } = parseToolCalls(reply);

    if (calls.length === 0) {
      finalText = cleanText || reply;
      break;
    }

    // Execute tools (sequentially — small N, simpler error handling)
    const toolResults = [];
    let earlyEscalate = null;
    for (const call of calls) {
      if (call.name === 'escalate_to_computer') {
        earlyEscalate = call.args && call.args.reason ? String(call.args.reason) : 'Model requested escalation';
        toolResults.push({ name: call.name, result: { ok: true, escalated: true } });
        continue;
      }
      const fn = TOOLS[call.name];
      if (!fn) {
        toolResults.push({ name: call.name, result: { ok: false, error: `unknown tool "${call.name}"` } });
        continue;
      }
      try {
        const r = await fn(call.args || {}, ctx);
        toolResults.push({ name: call.name, result: r });
        log('info', `tool ${call.name} → ${JSON.stringify(r).slice(0, 120)}`);
      } catch (e) {
        toolResults.push({ name: call.name, result: { ok: false, error: String(e).slice(0, 200) } });
        log('error', `tool ${call.name} threw`, { error: String(e) });
      }
    }

    if (earlyEscalate) {
      escalated = earlyEscalate;
      finalText = cleanText || `Escalating to Computer: ${earlyEscalate}`;
      break;
    }

    // Append assistant turn + tool result and continue the loop
    messages.push({ role: 'assistant', content: reply });
    messages.push({
      role: 'user',
      content:
        'TOOL_RESULTS: ' + JSON.stringify(toolResults) +
        '\n\nNow respond to the user with a short confirmation (1-2 sentences). Do NOT call any more tools unless absolutely necessary.',
    });
  }

  if (!finalText) {
    finalText = "(Reached tool-call limit. Try rephrasing.)";
  }

  return { finalText, escalated };
}

/* ─────────────── Job processor ─────────────── */

const _inFlight = new Set();
const _failCounts = new Map();

async function processJob(job) {
  const jobId = job.id;
  if (_inFlight.has(jobId)) return;
  _inFlight.add(jobId);

  log('info', `processing job ${jobId} (msg ${job.message_id})`);

  try {
    // Fetch original message + tab context
    let messageText = '';
    let contextTab = job.context_tab || 'today';
    let tabContext = job.tab_context || null;

    try {
      const msgsData = await cockpitGet('/api/chat/messages');
      const msgs = msgsData.messages || [];
      const orig = msgs.find((m) => m.id === job.message_id);
      if (orig) {
        messageText = orig.text || '';
        if (orig.context_tab) contextTab = orig.context_tab;
        if (orig.tab_context) tabContext = orig.tab_context;
      }
    } catch (err) {
      log('error', `fetch messages failed`, { error: String(err) });
    }

    if (job.feedback_answer) {
      messageText = `${messageText}\n\n[User answered clarifying question: ${job.feedback_answer}]`;
    }
    if (!messageText.trim()) throw new Error('empty message text — nothing to forward');

    const systemPrompt = buildSystemPrompt(contextTab, tabContext);
    const ctx = { tab: contextTab, jobId, messageId: job.message_id, originalText: messageText };

    const { finalText, escalated } = await runToolLoop(systemPrompt, messageText, ctx);

    if (escalated) {
      await cockpitPost('/api/chat/escalate', {
        message_id: job.message_id,
        reason: escalated,
        task_payload: { original_text: messageText, openclaw_response: finalText, tab: contextTab },
      });
      log('info', `job ${jobId}: escalated to Computer`);
    } else {
      await cockpitPost('/api/chat/reply', {
        message_id: job.message_id,
        reply_text: finalText,
        role: 'assistant',
      });
      log('info', `job ${jobId}: reply posted (${finalText.length} chars)`);
    }
    _failCounts.delete(jobId);

  } catch (err) {
    const errMsg = String(err);
    log('error', `job ${jobId} failed`, { error: errMsg });
    const fails = (_failCounts.get(jobId) || 0) + 1;
    _failCounts.set(jobId, fails);
    // If the backend just went unhealthy, don't count this against the job —
    // hold it until the backend recovers.
    const isNetworkErr = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|socket hang up|aborted|fetch failed/i.test(errMsg);
    if (isNetworkErr && !_backendHealthy) {
      _failCounts.set(jobId, Math.max(0, fails - 1)); // un-count this attempt
      return;
    }

    if (fails >= 3) {
      const friendly = isNetworkErr
        ? `OpenClaw is offline right now. Your message is queued and will be answered when it's back.`
        : `⚠️ Bridge error after ${fails} tries: ${errMsg.slice(0, 400)}`;
      try {
        await cockpitPost('/api/chat/reply', {
          message_id: job.message_id,
          reply_text: friendly,
          role: 'assistant',
        });
      } catch (e) {
        log('error', `failed to post error reply`, { error: String(e) });
      }
      _failCounts.delete(jobId);
    }
  } finally {
    _inFlight.delete(jobId);
  }
}

/* ─────────────── Poll loop ─────────────── */

async function poll() {
  try {
    const data = await cockpitGet('/api/chat/pending?status=queued');
    const jobs = (data.jobs || []).filter((j) => j.kind === 'chat');
    if (!jobs.length) return;

    // Health gate: if the local model is down, don't burn retries — just
    // wait for it to come back. Jobs stay queued and get picked up later.
    const healthy = await checkBackendHealth();
    if (!healthy) {
      log('debug', `poll: ${jobs.length} queued but backend unhealthy — holding`);
      return;
    }

    log('debug', `poll: ${jobs.length} queued`);
    await Promise.all(jobs.map((j) => processJob(j)));
  } catch (err) {
    log('error', 'poll failed', { error: String(err) });
  }
}

/* ─────────────── Entry ─────────────── */

validateConfig();

log('info', 'OpenClaw Bridge v2 (tool-calling) starting', {
  cockpit: COCKPIT_BACKEND_URL,
  backend: BACKEND,
  ollama: OLLAMA_URL,
  ollamaModel: OLLAMA_MODEL,
  pollIntervalMs: POLL_INTERVAL_MS,
  maxToolHops: MAX_TOOL_HOPS,
});

poll();
setInterval(poll, POLL_INTERVAL_MS);

process.on('SIGINT', () => { log('info', 'SIGINT'); process.exit(0); });
process.on('SIGTERM', () => { log('info', 'SIGTERM'); process.exit(0); });
