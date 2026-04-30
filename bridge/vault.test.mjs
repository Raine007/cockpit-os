/**
 * vault.test.mjs — tests for bridge/vault.js
 *
 * Run with: node --test bridge/vault.test.mjs
 *
 * Sets up a temp vault dir, exercises the public API, and runs adversarial
 * path-escape inputs to prove the validator can't be bypassed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Set up a fresh vault dir BEFORE importing vault.js (it reads env at module load).
const TMP_VAULT = mkdtempSync(path.join(os.tmpdir(), 'cockpit-vault-test-'));
process.env.COCKPIT_VAULT_PATH = TMP_VAULT;
process.env.COCKPIT_VAULT_DRY_RUN = '0'; // tests need real writes
process.env.COCKPIT_VAULT_ALLOWLIST = 'Daily Notes,Flying,Tasks,Chat,Inbox';

const vault = await import('./vault.js');

// Pre-create the allowlisted folders so write tests succeed.
for (const folder of ['Daily Notes', 'Flying', 'Tasks', 'Chat', 'Inbox']) {
  await fs.mkdir(path.join(TMP_VAULT, folder), { recursive: true });
}

process.on('exit', () => {
  try {
    rmSync(TMP_VAULT, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/* ─────────────── Basic enabled/dryRun ─────────────── */

test('isEnabled returns true when vault path is a directory', () => {
  assert.equal(vault.isEnabled(), true);
});

test('isDryRun reflects env var', () => {
  assert.equal(vault.isDryRun(), false);
});

test('listAllowedFolders returns configured allowlist', () => {
  const folders = vault.listAllowedFolders();
  assert.deepEqual(folders, ['Daily Notes', 'Flying', 'Tasks', 'Chat', 'Inbox']);
});

/* ─────────────── Path validation: legitimate inputs ─────────────── */

test('resolveVaultPath accepts a normal allowlisted path', () => {
  const abs = vault.resolveVaultPath('Daily Notes/2026-04-30.md');
  assert.ok(abs.startsWith(TMP_VAULT));
  assert.ok(abs.endsWith('2026-04-30.md'));
});

test('resolveVaultPath accepts paths with spaces', () => {
  const abs = vault.resolveVaultPath('Daily Notes/note with spaces.md');
  assert.ok(abs.includes('note with spaces.md'));
});

/* ─────────────── Path validation: adversarial inputs ─────────────── */

test('resolveVaultPath rejects empty string', () => {
  assert.throws(() => vault.resolveVaultPath(''), /non-empty/);
});

test('resolveVaultPath rejects null bytes', () => {
  assert.throws(() => vault.resolveVaultPath('Daily Notes/foo\0.md'), /null byte/);
});

test('resolveVaultPath rejects absolute Unix path', () => {
  assert.throws(() => vault.resolveVaultPath('/etc/passwd'), /must be relative/);
});

test('resolveVaultPath rejects Windows drive letter', () => {
  assert.throws(() => vault.resolveVaultPath('C:\\Windows\\System32'), /must be relative/);
});

test('resolveVaultPath rejects parent-dir escape', () => {
  assert.throws(() => vault.resolveVaultPath('../../../etc/passwd'), /escape|allowlisted/);
});

test('resolveVaultPath rejects sibling escape via ..', () => {
  assert.throws(() => vault.resolveVaultPath('Daily Notes/../../../outside.md'), /escape|allowlisted/);
});

test('resolveVaultPath rejects non-allowlisted folder', () => {
  assert.throws(() => vault.resolveVaultPath('Personal/secret.md'), /not allowlisted/);
});

test('resolveVaultPath rejects vault-root file (no folder)', () => {
  assert.throws(() => vault.resolveVaultPath('top-level.md'), /not allowlisted/);
});

test('resolveVaultPath rejects walk back to vault root then sideways', () => {
  // Daily Notes/../Personal/x.md — resolves to Personal/x.md which is not allowlisted.
  assert.throws(() => vault.resolveVaultPath('Daily Notes/../Personal/x.md'), /not allowlisted/);
});

if (os.platform() !== 'win32') {
  test('resolveVaultPath rejects symlink that escapes vault', async () => {
    const linkPath = path.join(TMP_VAULT, 'Daily Notes', 'evil-link');
    try {
      symlinkSync('/etc', linkPath);
    } catch {
      return; // symlinks may not be permitted in test env
    }
    assert.throws(() => vault.resolveVaultPath('Daily Notes/evil-link/passwd'), /symlink/);
    await fs.unlink(linkPath).catch(() => {});
  });
}

/* ─────────────── appendToFile + readFile ─────────────── */

test('appendToFile creates the file and writes content', async () => {
  const res = await vault.appendToFile('Inbox/note1.md', 'first line');
  assert.equal(res.written, true);
  const body = await vault.readFile('Inbox/note1.md');
  assert.equal(body, 'first line\n');
});

test('appendToFile appends, does not overwrite', async () => {
  await vault.appendToFile('Inbox/note2.md', 'line A');
  await vault.appendToFile('Inbox/note2.md', 'line B');
  const body = await vault.readFile('Inbox/note2.md');
  assert.equal(body, 'line A\nline B\n');
});

test('appendToFile creates nested parent dirs when missing', async () => {
  const res = await vault.appendToFile('Flying/2026/04/30.md', 'sortie 1');
  assert.equal(res.written, true);
  const body = await vault.readFile('Flying/2026/04/30.md');
  assert.equal(body, 'sortie 1\n');
});

test('appendToFile preserves trailing newline if already present', async () => {
  await vault.appendToFile('Inbox/note3.md', 'with newline\n');
  const body = await vault.readFile('Inbox/note3.md');
  assert.equal(body, 'with newline\n');
});

test('readFile returns empty string for missing file (does not throw)', async () => {
  const body = await vault.readFile('Inbox/does-not-exist.md');
  assert.equal(body, '');
});

/* ─────────────── writeFileAtomic ─────────────── */

test('writeFileAtomic replaces file content atomically', async () => {
  await vault.writeFileAtomic('Tasks/Inbox.md', '- [ ] task one\n');
  const body1 = await vault.readFile('Tasks/Inbox.md');
  assert.equal(body1, '- [ ] task one\n');

  await vault.writeFileAtomic('Tasks/Inbox.md', '- [ ] task one\n- [ ] task two\n');
  const body2 = await vault.readFile('Tasks/Inbox.md');
  assert.equal(body2, '- [ ] task one\n- [ ] task two\n');
});

/* ─────────────── appendDailyNote ─────────────── */

test('appendDailyNote writes to today\'s file with timestamp', async () => {
  const res = await vault.appendDailyNote('hello vault', 'test');
  assert.equal(res.written, true);
  assert.match(res.path, /Daily Notes[\\/]\d{4}-\d{2}-\d{2}\.md$/);
  const today = new Date();
  const filename = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}.md`;
  const body = await vault.readFile(`Daily Notes/${filename}`);
  assert.match(body, /\*\*\d{2}:\d{2}\*\* _\(test\)_ hello vault/);
});

/* ─────────────── listMarkdownFiles ─────────────── */

test('listMarkdownFiles returns markdown files in a folder', async () => {
  await vault.appendToFile('Chat/a.md', 'a');
  await vault.appendToFile('Chat/b.md', 'b');
  await vault.appendToFile('Chat/notes.txt', 'not markdown');
  const files = await vault.listMarkdownFiles('Chat');
  assert.ok(files.some((f) => f.endsWith('a.md')));
  assert.ok(files.some((f) => f.endsWith('b.md')));
  assert.ok(!files.some((f) => f.endsWith('.txt')));
});

test('listMarkdownFiles ignores dotfiles (e.g. .obsidian)', async () => {
  await fs.mkdir(path.join(TMP_VAULT, 'Chat', '.hidden'), { recursive: true });
  const files = await vault.listMarkdownFiles('Chat', { recursive: true });
  assert.ok(!files.some((f) => f.includes('.hidden')));
});

test('listMarkdownFiles returns [] for missing folder', async () => {
  // Create an allowlisted folder we then remove just for this test.
  const probeRel = 'Inbox';
  // Use a path inside Inbox that doesn't exist.
  const files = await vault.listMarkdownFiles('Inbox/does-not-exist');
  assert.deepEqual(files, []);
});

/* ─────────────── Dry-run mode ─────────────── */

test('dry-run mode does not touch disk', async () => {
  // Re-import with DRY_RUN flipped on. Dynamic import ensures fresh module-load env read.
  const dryEnv = { ...process.env, COCKPIT_VAULT_DRY_RUN: '1' };
  const orig = process.env.COCKPIT_VAULT_DRY_RUN;
  process.env.COCKPIT_VAULT_DRY_RUN = '1';
  // Module already loaded; we test the side-effect path directly:
  // since our module read env at load, the easiest assertion is that
  // a fresh import path yields dryRun=true.
  const fresh = await import('./vault.js?dry=1');
  assert.equal(fresh.isDryRun(), true);
  const res = await fresh.appendToFile('Inbox/should-not-exist.md', 'nope');
  assert.equal(res.written, false);
  assert.equal(res.dryRun, true);
  // And the file should not have been created.
  const body = await vault.readFile('Inbox/should-not-exist.md');
  assert.equal(body, '');
  process.env.COCKPIT_VAULT_DRY_RUN = orig;
});

/* ─────────────── Diagnostic ─────────────── */

test('diagnostic returns sane info', () => {
  const d = vault.diagnostic();
  assert.equal(d.enabled, true);
  assert.equal(d.dryRun, false);
  assert.equal(d.vaultRoot, path.resolve(TMP_VAULT));
  assert.deepEqual(d.allowedFolders, ['Daily Notes', 'Flying', 'Tasks', 'Chat', 'Inbox']);
});
