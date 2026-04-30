#!/usr/bin/env node
/**
 * openclaw-bridge.js
 *
 * Standalone Node.js polling bridge between Cockpit OS (Cloud Run) and
 * OpenClaw running inside WSL2 on Raine's Windows PC.
 *
 * What it does:
 *  1. Polls GET /api/chat/pending every 3 seconds for kind=chat, status=queued jobs.
 *  2. Forwards each job's message text to OpenClaw via POST {OPENCLAW_GATEWAY_URL}/api/sessions/main/messages.
 *     Falls back to /v1/chat/completions (OpenAI-compat) if the session route is missing.
 *  3. Inspects the response:
 *     - Contains "[ASK]"     → POST /api/feedback/ask  (clarification needed)
 *     - Contains "[ESCALATE]" or indicates video editing → POST /api/chat/escalate
 *     - Otherwise            → POST /api/chat/reply    (normal assistant reply)
 *
 * Configuration (environment variables):
 *   COCKPIT_BACKEND_URL      Cockpit Cloud Run URL (required)
 *   COCKPIT_ADMIN_TOKEN      Cockpit admin bearer token (required)
 *   OPENCLAW_GATEWAY_URL     OpenClaw HTTP gateway (default: http://127.0.0.1:18789)
 *   OPENCLAW_GATEWAY_TOKEN   OpenClaw bearer token (required)
 *   BRIDGE_POLL_INTERVAL_MS  Poll interval in ms (default: 3000)
 *   BRIDGE_LOG_LEVEL         "debug" | "info" | "error" (default: "info")
 *
 * Usage:
 *   npm install && node openclaw-bridge.js
 */

import fetch from 'node-fetch';

/* ─────────────────────────────────────────────────────────────────────────── */
/* Config                                                                      */
/* ─────────────────────────────────────────────────────────────────────────── */

const COCKPIT_BACKEND_URL = (process.env.COCKPIT_BACKEND_URL || '').replace(/\/$/, '');
const COCKPIT_ADMIN_TOKEN = process.env.COCKPIT_ADMIN_TOKEN || '';
const OPENCLAW_GATEWAY_URL = (process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789').replace(/\/$/, '');
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';
const POLL_INTERVAL_MS = parseInt(process.env.BRIDGE_POLL_INTERVAL_MS || '3000', 10);
const LOG_LEVEL = process.env.BRIDGE_LOG_LEVEL || 'info';

/* ─────────────────────────────────────────────────────────────────────────── */
/* Startup validation                                                          */
/* ─────────────────────────────────────────────────────────────────────────── */

function validateConfig() {
  const errors = [];
  if (!COCKPIT_BACKEND_URL) errors.push('COCKPIT_BACKEND_URL is required');
  if (!COCKPIT_ADMIN_TOKEN) errors.push('COCKPIT_ADMIN_TOKEN is required');
  if (!OPENCLAW_GATEWAY_TOKEN) errors.push('OPENCLAW_GATEWAY_TOKEN is required');
  if (errors.length) {
    console.error('[bridge] Missing configuration:\n  ' + errors.join('\n  '));
    process.exit(1);
  }
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Logger                                                                      */
/* ─────────────────────────────────────────────────────────────────────────── */

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

/* ─────────────────────────────────────────────────────────────────────────── */
/* Cockpit API helpers                                                         */
/* ─────────────────────────────────────────────────────────────────────────── */

function cockpitHeaders() {
  return {
    'Authorization': `Bearer ${COCKPIT_ADMIN_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

async function cockpitGet(path) {
  const url = `${COCKPIT_BACKEND_URL}${path}`;
  const res = await fetch(url, { headers: cockpitHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Cockpit GET ${path} → HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

async function cockpitPost(path, body) {
  const url = `${COCKPIT_BACKEND_URL}${path}`;
  const res = await fetch(url, {
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

/* ─────────────────────────────────────────────────────────────────────────── */
/* OpenClaw gateway helper                                                     */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * Send a message to OpenClaw and return its response text.
 *
 * Tries OpenClaw's native session HTTP API first:
 *   POST /api/sessions/main/messages   body: { message: "..." }
 *
 * If that 404s (older / different gateway), falls back to the OpenAI-compatible
 * route, which must be enabled in openclaw.json:
 *   POST /v1/chat/completions          body: { model, messages: [...] }
 *
 * If the job has a feedback_answer attached (from a re-queue after /feedback/answer),
 * it's appended to the message so OpenClaw has the full context.
 */
function extractText(json) {
  if (!json || typeof json !== 'object') return '';
  // /api/sessions/.../messages typical shapes
  if (typeof json.response === 'string') return json.response;
  if (typeof json.text === 'string') return json.text;
  if (typeof json.content === 'string') return json.content;
  if (typeof json.reply === 'string') return json.reply;
  if (typeof json.output_text === 'string') return json.output_text;
  if (json.message && typeof json.message.content === 'string') return json.message.content;
  if (json.message && typeof json.message.text === 'string') return json.message.text;
  // /v1/chat/completions OpenAI shape
  if (Array.isArray(json.choices) && json.choices[0]) {
    const c = json.choices[0];
    if (c.message && typeof c.message.content === 'string') return c.message.content;
    if (typeof c.text === 'string') return c.text;
  }
  // /v1/responses shape
  if (Array.isArray(json.output) && json.output.length) {
    const parts = [];
    for (const item of json.output) {
      if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (typeof c.text === 'string') parts.push(c.text);
        }
      }
    }
    if (parts.length) return parts.join('\n');
  }
  return '';
}

async function tryEndpoint(url, payload, label) {
  // OpenClaw on local Ollama can take 30+ seconds to first-token on cold start.
  const controller = new AbortController();
  const timeoutMs = parseInt(process.env.OPENCLAW_TIMEOUT_MS || '120000', 10);
  const t = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(t);
  }
  const bodyText = await res.text();
  if (!res.ok) {
    const err = new Error(`OpenClaw POST ${label} → HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  let json;
  try { json = JSON.parse(bodyText); } catch { json = { text: bodyText }; }
  const text = extractText(json);
  if (!text) {
    log('debug', `${label} returned no recognizable text field`, { shape: Object.keys(json || {}) });
    return JSON.stringify(json).slice(0, 800);
  }
  return text;
}

async function sendToOpenClaw(job) {
  const text = job.message_text || job.text || '';
  let content = text;
  if (job.feedback_answer) {
    content = `${text}\n\n[User answered clarifying question: ${job.feedback_answer}]`;
  }
  if (!content || !content.trim()) {
    throw new Error('empty message text — cannot forward to OpenClaw');
  }

  log('debug', `→ OpenClaw: ${content.slice(0, 80)}...`);

  // OpenClaw 2026.4.27+ exposes OpenAI-compatible /v1/chat/completions.
  // Model id format uses a slash, e.g. "openclaw/main" (NOT "openclaw:main").
  return await tryEndpoint(
    `${OPENCLAW_GATEWAY_URL}/v1/chat/completions`,
    {
      model: process.env.OPENCLAW_MODEL || 'openclaw/main',
      messages: [
        { role: 'system', content: 'You are OpenClaw, helping Raine via the Cockpit OS chat. Keep replies concise. If the user asks for a video edit (Reels/captions/9:16/blur N-numbers), respond with [ESCALATE] followed by what they asked for. If you need clarification before proceeding, respond with [ASK] followed by your single clarifying question.' },
        { role: 'user', content },
      ],
      stream: false,
    },
    '/v1/chat/completions'
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Response classifier                                                         */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * Heuristics to classify an OpenClaw response:
 *
 *  "ask"      → OpenClaw needs clarification before proceeding.
 *               Signals: response text contains "[ASK]"
 *
 *  "escalate" → Task needs Computer (heavy work: video editing, etc.)
 *               Signals: response text contains "[ESCALATE]" OR
 *                        response references video editing terms
 *
 *  "reply"    → Normal conversational response.
 */
function classifyResponse(responseText) {
  if (!responseText) return 'reply';

  const upper = responseText.toUpperCase();

  if (upper.includes('[ASK]')) return 'ask';

  if (
    upper.includes('[ESCALATE]') ||
    upper.includes('VIDEO EDITING') ||
    upper.includes('EDIT THE REEL') ||
    upper.includes('CUT THE CLIP') ||
    upper.includes('FCPX') ||
    upper.includes('PREMIERE PRO') ||
    upper.includes('DAVINCI')
  ) {
    return 'escalate';
  }

  return 'reply';
}

/**
 * Extract a clarifying question from an [ASK] response.
 * The convention is: [ASK] <question text here>
 * or the question follows on the next line.
 */
function extractQuestion(responseText) {
  const match = responseText.match(/\[ASK\][:\s]*([\s\S]+)/i);
  if (match) return match[1].trim();
  // Fallback: return the whole response minus the tag
  return responseText.replace(/\[ASK\]/gi, '').trim() || 'OpenClaw needs clarification.';
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* In-flight job tracker (prevent double-processing)                          */
/* ─────────────────────────────────────────────────────────────────────────── */

const _inFlight = new Set();
const _failCounts = new Map();

/* ─────────────────────────────────────────────────────────────────────────── */
/* Core job processor                                                          */
/* ─────────────────────────────────────────────────────────────────────────── */

async function processJob(job) {
  const jobId = job.id;

  if (_inFlight.has(jobId)) {
    log('debug', `job ${jobId} already in flight — skipping`);
    return;
  }
  _inFlight.add(jobId);

  log('info', `processing job ${jobId} for message ${job.message_id}`);

  try {
    // Fetch the original message text from Cockpit (the job only has message_id)
    // We do a quick fetch of all messages and find this one.
    let messageText = job.feedback_answer
      ? `[re-queued with feedback answer: ${job.feedback_answer}]`
      : '';

    try {
      const msgsData = await cockpitGet('/api/chat/messages');
      const msgs = msgsData.messages || [];
      const origMsg = msgs.find((m) => m.id === job.message_id);
      if (origMsg) {
        messageText = origMsg.text || '';
      }
    } catch (err) {
      log('error', `failed to fetch messages for job ${jobId}`, { error: String(err) });
    }

    // Attach the fetched message text so sendToOpenClaw can use it
    const enrichedJob = { ...job, message_text: messageText };

    // Forward to OpenClaw
    const responseText = await sendToOpenClaw(enrichedJob);
    log('debug', `← OpenClaw response: ${responseText.slice(0, 120)}`);

    const classification = classifyResponse(responseText);
    log('info', `job ${jobId} classified as: ${classification}`);

    if (classification === 'ask') {
      // OpenClaw needs clarification — write to feedback_requests
      const question = extractQuestion(responseText);
      await cockpitPost('/api/feedback/ask', {
        message_id: job.message_id,
        question,
      });
      log('info', `job ${jobId}: feedback question posted — "${question.slice(0, 60)}"`);

    } else if (classification === 'escalate') {
      // Escalate to Computer for heavy work
      const reason = responseText.includes('[ESCALATE]')
        ? responseText.replace(/\[ESCALATE\]/gi, '').trim()
        : responseText.slice(0, 200);
      await cockpitPost('/api/chat/escalate', {
        message_id: job.message_id,
        reason,
        task_payload: {
          original_text: messageText,
          openclaw_response: responseText,
        },
      });
      log('info', `job ${jobId}: escalated to Computer`);

    } else {
      // Normal reply
      await cockpitPost('/api/chat/reply', {
        message_id: job.message_id,
        reply_text: responseText,
        role: 'assistant',
      });
      log('info', `job ${jobId}: reply posted`);
    }

  } catch (err) {
    const errMsg = String(err);
    log('error', `job ${jobId} failed`, { error: errMsg });
    // Track retry count; after 3 failures, post the error back as a reply so the user
    // sees what went wrong and we stop hammering OpenClaw forever.
    const fails = (_failCounts.get(jobId) || 0) + 1;
    _failCounts.set(jobId, fails);
    if (fails >= 3) {
      try {
        await cockpitPost('/api/chat/reply', {
          message_id: job.message_id,
          reply_text: `⚠️ Bridge could not reach OpenClaw after ${fails} tries.\n\n${errMsg.slice(0, 500)}`,
          role: 'assistant',
        });
        log('info', `job ${jobId}: error reply posted after ${fails} failures`);
      } catch (e) {
        log('error', `job ${jobId}: failed to post error reply`, { error: String(e) });
      }
      _failCounts.delete(jobId);
    }
  } finally {
    _inFlight.delete(jobId);
  }
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Poll loop                                                                   */
/* ─────────────────────────────────────────────────────────────────────────── */

async function poll() {
  try {
    const data = await cockpitGet('/api/chat/pending?status=queued');
    const jobs = (data.jobs || []).filter((j) => j.kind === 'chat');

    if (jobs.length > 0) {
      log('debug', `poll: ${jobs.length} queued job(s)`);
    }

    // Process jobs concurrently (each guard against double-processing via _inFlight)
    await Promise.all(jobs.map((job) => processJob(job)));

  } catch (err) {
    // Log but don't crash — transient network errors are expected
    log('error', 'poll failed', { error: String(err) });
  }
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Entry point                                                                 */
/* ─────────────────────────────────────────────────────────────────────────── */

validateConfig();

log('info', 'OpenClaw Bridge starting', {
  cockpit: COCKPIT_BACKEND_URL,
  openclaw: OPENCLAW_GATEWAY_URL,
  pollIntervalMs: POLL_INTERVAL_MS,
});

// Run immediately on startup, then on interval
poll();
setInterval(poll, POLL_INTERVAL_MS);

// Graceful shutdown
process.on('SIGINT', () => {
  log('info', 'shutting down (SIGINT)');
  process.exit(0);
});
process.on('SIGTERM', () => {
  log('info', 'shutting down (SIGTERM)');
  process.exit(0);
});
