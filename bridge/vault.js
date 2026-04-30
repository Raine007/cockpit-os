/**
 * vault.js — Obsidian vault module for openclaw-bridge.
 *
 * Read/write/append operations against a local Obsidian vault folder.
 * Hardened path validation; only the explicitly-allowed Cockpit
 * subfolders may be touched. Dry-run mode logs intent without writing.
 *
 * Env vars (set in the bridge service environment):
 *   COCKPIT_VAULT_PATH       Absolute path to the vault root.
 *                            Required to enable any vault operation.
 *   COCKPIT_VAULT_DRY_RUN    "1" = log intended writes, do not touch disk.
 *                            Default: "1" (safe). Flip to "0" to actually write.
 *   COCKPIT_VAULT_ALLOWLIST  Comma-separated list of subfolders we're allowed
 *                            to read/write. Default:
 *                            "Daily Notes,Flying,Tasks,Chat,Inbox"
 *
 * Public API:
 *   isEnabled()                      → boolean (vault path set + exists)
 *   isDryRun()                       → boolean
 *   listAllowedFolders()             → string[]
 *   resolveVaultPath(relPath)        → absolute path (throws if escape)
 *   appendToFile(relPath, text)      → { written: bool, path, bytes }
 *   readFile(relPath)                → string contents
 *   writeFileAtomic(relPath, text)   → { written: bool, path, bytes }
 *   appendDailyNote(text, source)    → { written: bool, path }
 *   listMarkdownFiles(relFolder)     → string[] (relative paths)
 *
 * Hard guarantees:
 *   1. No path may escape the vault root (resolved + prefix check).
 *   2. No path may target a folder outside the allowlist.
 *   3. Symlinks inside the vault are not followed for writes.
 *   4. Atomic writes via temp file + rename (no torn writes).
 *   5. Dry-run mode is default-on; explicit opt-in to write.
 */

import { promises as fs, existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/* ─────────────── Config ─────────────── */

const VAULT_PATH = (process.env.COCKPIT_VAULT_PATH || '').trim();
const DRY_RUN = (process.env.COCKPIT_VAULT_DRY_RUN ?? '1') !== '0';
const ALLOWLIST = (process.env.COCKPIT_VAULT_ALLOWLIST || 'Daily Notes,Flying,Tasks,Chat,Inbox')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/* ─────────────── Helpers ─────────────── */

function log(level, msg, data) {
  const prefix = `[vault][${level}] ${new Date().toISOString()} `;
  if (data !== undefined) {
    console[level === 'error' ? 'error' : 'log'](prefix + msg, JSON.stringify(data));
  } else {
    console[level === 'error' ? 'error' : 'log'](prefix + msg);
  }
}

/**
 * Normalize and validate a relative path against the vault root.
 * Throws if the resolved path escapes the vault or targets a folder
 * outside the allowlist. Never follows symlinks.
 */
export function resolveVaultPath(relPath) {
  if (!VAULT_PATH) {
    throw new Error('COCKPIT_VAULT_PATH not configured');
  }
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new Error('relPath must be a non-empty string');
  }
  if (relPath.includes('\0')) {
    throw new Error('relPath contains null byte');
  }
  // Block absolute paths and Windows drive letters in input.
  if (path.isAbsolute(relPath) || /^[a-zA-Z]:[\\/]/.test(relPath)) {
    throw new Error(`relPath must be relative: ${relPath}`);
  }

  const vaultRoot = path.resolve(VAULT_PATH);
  const resolved = path.resolve(vaultRoot, relPath);

  // Must stay inside the vault root.
  const rootWithSep = vaultRoot.endsWith(path.sep) ? vaultRoot : vaultRoot + path.sep;
  if (resolved !== vaultRoot && !resolved.startsWith(rootWithSep)) {
    throw new Error(`path escape blocked: ${relPath}`);
  }

  // Must be inside an allowlisted top-level folder.
  const rel = path.relative(vaultRoot, resolved);
  // Use forward-slash-normalized first segment so this works on Windows + Linux.
  const firstSegment = rel.split(/[\\/]/)[0];
  if (!ALLOWLIST.includes(firstSegment)) {
    throw new Error(`folder not allowlisted: ${firstSegment}`);
  }

  // Block writes through symlinks: if any ancestor inside the vault is a symlink, refuse.
  let cursor = resolved;
  while (cursor !== vaultRoot && cursor.startsWith(rootWithSep)) {
    if (existsSync(cursor)) {
      try {
        const st = lstatSync(cursor);
        if (st.isSymbolicLink()) {
          throw new Error(`symlink in path blocked: ${cursor}`);
        }
      } catch (e) {
        if (e && e.message && e.message.startsWith('symlink')) throw e;
        // Other lstat errors are non-fatal — file may not exist yet.
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  return resolved;
}

/* ─────────────── Public API ─────────────── */

export function isEnabled() {
  if (!VAULT_PATH) return false;
  try {
    const st = lstatSync(VAULT_PATH);
    return st.isDirectory();
  } catch {
    return false;
  }
}

export function isDryRun() {
  return DRY_RUN;
}

export function listAllowedFolders() {
  return ALLOWLIST.slice();
}

export function getVaultRoot() {
  return VAULT_PATH ? path.resolve(VAULT_PATH) : '';
}

/**
 * Append text to a vault file. Creates parent dirs and the file if missing.
 * Adds a trailing newline if the appended text does not end with one.
 */
export async function appendToFile(relPath, text) {
  const abs = resolveVaultPath(relPath);
  const payload = text.endsWith('\n') ? text : text + '\n';
  const bytes = Buffer.byteLength(payload, 'utf8');

  if (DRY_RUN) {
    log('info', 'DRY_RUN appendToFile', { relPath, bytes });
    return { written: false, path: abs, bytes, dryRun: true };
  }

  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.appendFile(abs, payload, 'utf8');
  log('info', 'appendToFile', { relPath, bytes });
  return { written: true, path: abs, bytes, dryRun: false };
}

export async function readFile(relPath) {
  const abs = resolveVaultPath(relPath);
  try {
    return await fs.readFile(abs, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return '';
    throw e;
  }
}

/**
 * Atomic write: write to a temp file in the same dir, fsync, rename.
 * Avoids torn writes if the process dies mid-write.
 */
export async function writeFileAtomic(relPath, text) {
  const abs = resolveVaultPath(relPath);
  const bytes = Buffer.byteLength(text, 'utf8');

  if (DRY_RUN) {
    log('info', 'DRY_RUN writeFileAtomic', { relPath, bytes });
    return { written: false, path: abs, bytes, dryRun: true };
  }

  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = path.join(
    path.dirname(abs),
    `.${path.basename(abs)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
  );
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(text, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, abs);
  log('info', 'writeFileAtomic', { relPath, bytes });
  return { written: true, path: abs, bytes, dryRun: false };
}

/**
 * Append a timestamped entry to today's daily note.
 * Path: Daily Notes/YYYY-MM-DD.md
 */
export async function appendDailyNote(text, source = 'cockpit') {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const filename = `${yyyy}-${mm}-${dd}.md`;
  const rel = path.join('Daily Notes', filename);
  const stamped = `- **${hh}:${min}** _(${source})_ ${text}`;
  return appendToFile(rel, stamped);
}

/**
 * List markdown files inside an allowlisted subfolder.
 * Returns relative paths from the vault root. Non-recursive by default.
 */
export async function listMarkdownFiles(relFolder, { recursive = false } = {}) {
  const abs = resolveVaultPath(relFolder);
  let entries;
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const childRel = path.join(relFolder, ent.name);
    if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
      out.push(childRel);
    } else if (ent.isDirectory() && recursive) {
      const nested = await listMarkdownFiles(childRel, { recursive: true });
      out.push(...nested);
    }
  }
  return out;
}

/* ─────────────── Diagnostic export ─────────────── */

export function diagnostic() {
  return {
    enabled: isEnabled(),
    dryRun: DRY_RUN,
    vaultRoot: getVaultRoot(),
    allowedFolders: listAllowedFolders(),
    platform: os.platform(),
    nodeVersion: process.version,
  };
}
