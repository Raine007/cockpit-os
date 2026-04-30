#!/usr/bin/env node
/**
 * openclaw-bridge.js
 *
 * Standalone Node.js polling bridge between Cockpit OS (Cloud Run) and
 * OpenClaw running inside WSL2 on Raine's Windows PC.
 *
 * What it does:
 *  1. Polls GET /api/chat/pending every 3 seconds for kind=chat, status=queued jobs.
 *  2. Forwards each job's message text to OpenClaw via POST {OPENCLAW_GATEWAY_URL}/v1/messages.
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
 * Uses the standard OpenClaw HTTP gateway API: POST /v1/messages
 * with a Bearer token in the Authorization header.
 *
 * If the job has a feedback_answer attached (from a re-queue after /feedback/answer),
 * it's appended to the message so OpenClaw has the full context.
 */
async function sendToOpenClaw(job) {
  const text = job.message_text || job.text || '';
  let content = text;
  if (job.feedback_answer) {
    content = `${text}\n\n[User answered clarifying question: ${job.feedback_answer}]`;
  }

  const url = `${OPENCLAW_GATEWAY_URL}/v1/messages`;
  const payload = {
    message: content,
    message_id: job.message_id,
    job_id: job.id,
    // Include full context if available
    context: {
      source: 'cockpit-bridge',
      job_id: job.id,
      message_id: job.message_id,
    },
  };

  log('debug', `→ OpenClaw: ${content.slice(0, 80)}...`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenClaw POST /v1/messages → HTTP ${res.status}: ${text}`);
  }

  const json = await res.json();
  // OpenClaw typically returns { response: string } or { text: string } or { content: string }
  return json.response || json.text || json.content || JSON.stringify(json);
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
    log('error', `job ${jobId} failed`, { error: String(err) });
    // Do NOT mark as done — leave it queued so the next poll retries.
    // (In production you'd want a retry counter to avoid infinite loops.)
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
