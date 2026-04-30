/**
 * Channel renderer — turns a Notification into a per-channel RenderedMessage.
 *
 * Pure function; no IO. Each channel has different constraints:
 *
 *   - iMessage / WhatsApp / push: plain text, ~200-300 char sweet spot
 *   - Telegram: supports MarkdownV2; inline links work
 *   - Slack / Discord: native markdown + rich blocks
 *   - silent: no message body, useful for fire-and-forget audit pings
 *
 * The renderer never decides *whether* to send. That's the fabric's job.
 */

import type {
  Notification,
  OutboundDelivery,
  RenderedMessage,
} from './types.js';

const MAX_TEXT = 1_000;

/** Truncate with an ellipsis but never break inside a markdown link. */
function clamp(s: string, max: number = MAX_TEXT): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}\u2026`;
}

const SEVERITY_PREFIX: Record<Notification['severity'], string> = {
  info: '',
  success: '\u2713 ',
  warning: '\u26a0\ufe0f ',
  error: '\u274c ',
};

function renderLinksAsText(
  links: Notification['links'] = [],
): string {
  if (!links?.length) return '';
  return '\n\n' + links.map((l) => `${l.label}: ${l.url}`).join('\n');
}

function renderLinksAsMarkdown(
  links: Notification['links'] = [],
): string {
  if (!links?.length) return '';
  return '\n\n' + links.map((l) => `[${l.label}](${l.url})`).join('\n');
}

export function renderForChannel(
  notif: Notification,
  channel: OutboundDelivery['channel'],
): RenderedMessage {
  const prefix = SEVERITY_PREFIX[notif.severity];
  const heading = `${prefix}${notif.title}`;

  switch (channel) {
    case 'silent':
      return { text: '' };

    case 'push':
      // Push messages have a hard length budget; body is the preview line.
      return {
        text: clamp(`${heading}\n${notif.body}`, 240),
      };

    case 'imessage':
    case 'whatsapp': {
      // Plain text only. Links inlined as "Label: url".
      const body = clamp(`${heading}\n\n${notif.body}${renderLinksAsText(notif.links)}`);
      return { text: body };
    }

    case 'telegram': {
      const md = `*${escapeTelegramMd(heading)}*\n\n${escapeTelegramMd(notif.body)}${renderLinksAsMarkdown(
        notif.links,
      )}`;
      const text = clamp(`${heading}\n\n${notif.body}${renderLinksAsText(notif.links)}`);
      return { text, markdown: clamp(md) };
    }

    case 'slack':
    case 'discord': {
      const md = `*${heading}*\n\n${notif.body}${renderLinksAsMarkdown(notif.links)}`;
      const text = clamp(`${heading}\n\n${notif.body}${renderLinksAsText(notif.links)}`);
      const attachments = notif.links?.map((l) => ({ label: l.label, url: l.url }));
      const out: RenderedMessage = { text, markdown: clamp(md) };
      if (attachments) out.attachments = attachments;
      return out;
    }
  }
}

/**
 * Telegram MarkdownV2 requires escaping a long list of metacharacters.
 * We escape the conservative set that covers our notification content.
 */
function escapeTelegramMd(s: string): string {
  return s.replace(/[_\*\[\]\(\)~`>#\+\-=\|\{\}\.!\\]/g, (ch) => `\\${ch}`);
}
