import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  defineCapability,
  capabilityRegistry,
  register,
} from '../src/framework/index.js';

describe('defineCapability', () => {
  it('rejects invalid ids', () => {
    assert.throws(() =>
      defineCapability({
        id: 'Bad ID',
        description: 'long enough description',
        input: z.object({}),
        effect: 'read',
        handler: async () => ({}),
      }),
    );
  });

  it('rejects empty descriptions', () => {
    assert.throws(() =>
      defineCapability({
        id: 'good-id',
        description: 'short',
        input: z.object({}),
        effect: 'read',
        handler: async () => ({}),
      }),
    );
  });

  it('accepts a valid capability', () => {
    const cap = defineCapability({
      id: 'good-one',
      description: 'a perfectly fine description for the model',
      input: z.object({ x: z.string() }),
      effect: 'read',
      handler: async ({ x }) => ({ echo: x }),
    });
    assert.equal(cap.id, 'good-one');
  });
});

describe('capabilityRegistry', () => {
  it('rejects duplicate ids', () => {
    capabilityRegistry._resetForTesting();
    register(
      defineCapability({
        id: 'dupe',
        description: 'first registration of this capability',
        input: z.object({}),
        effect: 'read',
        handler: async () => ({}),
      }),
    );
    assert.throws(() =>
      register(
        defineCapability({
          id: 'dupe',
          description: 'second registration of this capability',
          input: z.object({}),
          effect: 'read',
          handler: async () => ({}),
        }),
      ),
    );
  });
});
