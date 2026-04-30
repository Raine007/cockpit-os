#!/usr/bin/env node
/**
 * compile-skills — generate one OpenClaw SKILL.md folder per capability.
 *
 * The output directory should point at an OpenClaw workspace skills dir.
 * Each capability becomes:
 *
 *   <out>/cockpit-<capability-id>/SKILL.md
 *
 * The skill body is a runbook that tells the LLM to invoke the matching MCP
 * tool. No skill ever reimplements capability logic — they just describe when
 * to call which tool and how to format the output.
 */

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import '../capabilities/index.js';
import { capabilityRegistry, DEFAULT_AUTO_INVOCABLE } from '../framework/index.js';
import type { AnyCapability } from '../framework/index.js';

const SKILL_PREFIX = 'cockpit-';

interface CompileOptions {
  /** Output directory for generated skill folders. */
  out: string;
  /** Whether to wipe the output directory first. */
  clean: boolean;
}

function parseArgs(argv: string[]): CompileOptions {
  const out =
    argv.find((a) => a.startsWith('--out='))?.slice('--out='.length) ??
    process.env.COCKPIT_SKILLS_OUT ??
    './skills-out';
  const clean = argv.includes('--clean');
  return { out: resolve(out), clean };
}

/**
 * Build a human-readable "Inputs" section from the Zod schema. We deliberately
 * keep this simple: name, type, required-or-not, description. Anything more
 * structured (enums, regex, defaults) just goes in the field description so
 * the LLM has it on hand.
 */
function describeInputs(cap: AnyCapability): string {
  if (!(cap.input instanceof z.ZodObject)) {
    return '_(no structured inputs)_';
  }
  const shape = cap.input.shape as Record<string, z.ZodTypeAny>;
  const lines: string[] = [];
  for (const [name, field] of Object.entries(shape)) {
    const isOptional = field.isOptional() || field.isNullable();
    const desc = collectDescription(field);
    const typeName = humanType(field);
    lines.push(
      `- **${name}** (${typeName}${isOptional ? ', optional' : ''})` +
        (desc ? ` — ${desc}` : ''),
    );
  }
  return lines.join('\n');
}

/**
 * Pull a description out of a possibly-wrapped Zod schema. Zod 4 stores it
 * on the public `description` getter; older shapes may put it on _def.
 */
function collectDescription(field: z.ZodTypeAny): string {
  const direct =
    (field as { description?: string }).description ??
    (field._def as { description?: string }).description;
  if (direct) return direct;

  const inner = unwrap(field);
  if (inner === field) return '';
  return collectDescription(inner);
}

/**
 * Walk one level inward through Optional/Nullable/Default/Pipe so the
 * compiler can present the user-meaningful type, not the wrapper class.
 */
function unwrap(field: z.ZodTypeAny): z.ZodTypeAny {
  // ZodOptional, ZodNullable, ZodDefault all expose innerType.
  const def = field._def as {
    innerType?: z.ZodTypeAny;
    in?: z.ZodTypeAny;
    type?: string;
  };
  if (def.innerType) return def.innerType;
  // ZodPipe (e.g. .transform()) — keep the source schema, since that's what
  // the caller actually provides.
  if (def.type === 'pipe' && def.in) return def.in;
  return field;
}

function humanType(field: z.ZodTypeAny): string {
  let inner: z.ZodTypeAny = field;
  // Walk repeatedly; e.g. ZodOptional<ZodPipe<ZodString, ZodTransform>>.
  for (let i = 0; i < 4; i++) {
    const next = unwrap(inner);
    if (next === inner) break;
    inner = next;
  }
  if (inner instanceof z.ZodString) return 'string';
  if (inner instanceof z.ZodNumber) return 'number';
  if (inner instanceof z.ZodBoolean) return 'boolean';
  if (inner instanceof z.ZodArray) return 'array';
  if (inner instanceof z.ZodObject) return 'object';
  if (inner instanceof z.ZodEnum) return 'enum';
  if (inner instanceof z.ZodLiteral) return 'literal';
  return inner.constructor.name.replace(/^Zod/, '').toLowerCase();
}

function effectGuardrail(cap: AnyCapability): string {
  switch (cap.effect) {
    case 'read':
      return 'Safe to invoke without confirmation. Pure read.';
    case 'write':
      return 'Writes data to Cockpit OS. Confirm intent before invoking.';
    case 'destroy':
      return 'DESTRUCTIVE. Always ask the user for explicit confirmation before invoking.';
    case 'external':
      return 'Calls an external service. May have rate limits or cost; mind retries.';
  }
}

function renderSkill(cap: AnyCapability): string {
  const skillName = `${SKILL_PREFIX}${cap.id}`;
  const autoInvocable = cap.autoInvocable ?? DEFAULT_AUTO_INVOCABLE[cap.effect];
  const tags = cap.tags ?? [];

  // Frontmatter. Per OpenClaw docs, `metadata` must be a single-line JSON
  // object. We inline it here on purpose.
  const metadata = JSON.stringify({
    openclaw: {
      ...(cap.emoji ? { emoji: cap.emoji } : {}),
      requires: { config: ['mcp.servers.cockpit.enabled'] },
    },
  });

  const frontmatter =
    `---\n` +
    `name: ${skillName}\n` +
    `description: ${cap.description.replace(/\n/g, ' ')}\n` +
    `user-invocable: true\n` +
    `disable-model-invocation: ${autoInvocable ? 'false' : 'true'}\n` +
    `metadata: ${metadata}\n` +
    `---\n`;

  const body = [
    `# ${skillName}`,
    '',
    `> Generated from \`cockpit-os\` capability \`${cap.id}\`. Do not edit by hand —`,
    `> change the capability source and re-run \`cockpit-compile-skills\`.`,
    '',
    '## What it does',
    '',
    cap.description,
    '',
    `**Effect class:** \`${cap.effect}\`.`,
    `**Tags:** ${tags.length ? tags.map((t) => `\`${t}\``).join(', ') : '_none_'}.`,
    '',
    '## When to use it',
    '',
    `Invoke this when the user\'s intent matches the description above. ${effectGuardrail(cap)}`,
    '',
    '## Inputs',
    '',
    describeInputs(cap),
    '',
    '## Workflow',
    '',
    `1. Confirm the inputs you have are sufficient. If a required input is missing, ask the user — do not guess.`,
    `2. Call the MCP tool \`${cap.id}\` exposed by the \`cockpit\` MCP server.`,
    `3. Pass the validated inputs as the tool arguments.`,
    `4. The tool returns a JSON object. Summarize the result for the user in plain language.`,
    `5. If the tool returns \`isError: true\`, surface the error message verbatim and stop — do not retry blindly.`,
    '',
    '## Output format',
    '',
    `Reply with a one-line confirmation that includes the new id (if any) and the most relevant fields from the result. Keep it terse; the user is on a phone.`,
    '',
    '## Guardrails',
    '',
    `- ${effectGuardrail(cap)}`,
    `- Never invent ids, dates, or tail numbers. If the user did not say, ask.`,
    `- If \`dryRun: true\` appears in the result, tell the user nothing was actually written.`,
    '',
    '<!-- generated-by: cockpit-os/compile-skills -->',
    '',
  ].join('\n');

  return frontmatter + body;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const caps = capabilityRegistry.list();

  if (caps.length === 0) {
    console.error('No capabilities registered; nothing to compile.');
    process.exit(1);
  }

  if (opts.clean) {
    await rm(opts.out, { recursive: true, force: true });
  }
  await mkdir(opts.out, { recursive: true });

  const written: string[] = [];
  for (const cap of caps) {
    const folder = join(opts.out, `${SKILL_PREFIX}${cap.id}`);
    await mkdir(folder, { recursive: true });
    const file = join(folder, 'SKILL.md');
    await writeFile(file, renderSkill(cap), 'utf8');
    written.push(file);
  }

  console.error(`Wrote ${written.length} skill(s) to ${opts.out}`);
  for (const f of written) console.error(`  - ${f}`);
}

const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/compile-skills.ts') ||
  process.argv[1]?.endsWith('/compile-skills.js');

if (isDirectRun) {
  main().catch((err) => {
    console.error('compile-skills failed:', err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}

export { renderSkill, main };
// Suppress unused-warnings on dirname/fileURLToPath if tree-shaken later.
void dirname;
void fileURLToPath;
