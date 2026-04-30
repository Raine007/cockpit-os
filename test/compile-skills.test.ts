/**
 * Verifies every registered capability produces a syntactically reasonable
 * SKILL.md: required frontmatter keys, single-line metadata, body with the
 * expected sections.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.COCKPIT_DRY_RUN = '1';
process.env.COCKPIT_LOG_LEVEL = 'error';

import { capabilityRegistry } from '../src/framework/index.js';
import { renderSkill } from '../src/build/compile-skills.js';
import '../src/capabilities/index.js';

describe('renderSkill', () => {
  for (const cap of capabilityRegistry.list()) {
    it(`renders valid SKILL.md for ${cap.id}`, () => {
      const md = renderSkill(cap);
      // Frontmatter present
      assert.match(md, /^---\n/);
      assert.match(md, /\nname: cockpit-/);
      assert.match(md, /\ndescription: /);
      assert.match(md, /\nuser-invocable: true/);
      assert.match(md, /\ndisable-model-invocation: (true|false)/);
      // Metadata must be on a single line per OpenClaw parser rules.
      const metaMatch = md.match(/\nmetadata: (.*)\n/);
      assert.ok(metaMatch, 'metadata line missing');
      assert.doesNotMatch(metaMatch[1]!, /\n/, 'metadata must be single-line');
      // Body sections
      assert.match(md, /## What it does/);
      assert.match(md, /## When to use it/);
      assert.match(md, /## Inputs/);
      assert.match(md, /## Workflow/);
      assert.match(md, /## Guardrails/);
    });
  }
});
