import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderForChannel } from '../src/notifications/render.js';
import type { Notification } from '../src/notifications/types.js';

const base: Notification = {
  uid: 'u',
  kind: 'job-done:test',
  title: 'Done: weekly review',
  body: 'Finished weekly-review with 3 anomalies flagged.',
  severity: 'success',
  links: [
    { label: 'Report PDF', url: 'https://example.com/report.pdf' },
    { label: 'Source data', url: 'https://example.com/data.json' },
  ],
};

describe('renderForChannel', () => {
  it('produces plain text for iMessage with severity glyph', () => {
    const m = renderForChannel(base, 'imessage');
    assert.match(m.text, /✓ Done: weekly review/);
    assert.match(m.text, /Report PDF: https:\/\/example.com\/report.pdf/);
    assert.equal(m.markdown, undefined);
  });

  it('produces markdown for telegram with escaped metacharacters', () => {
    const m = renderForChannel(base, 'telegram');
    assert.ok(m.markdown);
    assert.match(m.markdown!, /\*✓ Done: weekly review\*/);
    // dot in "review." should be escaped → "review\."
    assert.match(m.markdown!, /flagged\\\./);
  });

  it('attaches links as structured attachments for slack', () => {
    const m = renderForChannel(base, 'slack');
    assert.ok(m.attachments);
    assert.equal(m.attachments!.length, 2);
    assert.equal(m.attachments![0]!.label, 'Report PDF');
  });

  it('returns empty body for silent channel', () => {
    const m = renderForChannel(base, 'silent');
    assert.equal(m.text, '');
  });

  it('clamps push messages to 240 chars', () => {
    const long = { ...base, body: 'x'.repeat(500) };
    const m = renderForChannel(long, 'push');
    assert.ok(m.text.length <= 240);
  });
});
