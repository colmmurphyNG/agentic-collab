/**
 * Rolling manifest of conversation threads, derived from dashboard messages. A thread is one
 * (agent, topic) pair; a message with no topic belongs to "general", the label the dashboard
 * already gives it. Pure functions only, so the grouping is testable without a database.
 */

import type { MessageDirection } from '../shared/types.ts';

export const MANIFEST_DEFAULT_HOURS = 36;
export const MANIFEST_MAX_HOURS = 168;
export const MANIFEST_PREVIEW_CHARS = 200;
export const MANIFEST_MAX_LINKS = 5;
export const MANIFEST_GENERAL_TOPIC = 'general';

export interface ManifestMessage {
  agent: string;
  topic: string | null;
  direction: MessageDirection;
  message: string;
  createdAt: string;
}

export interface ManifestRow {
  agent: string;
  topic: string;
  lastMessageAt: string;
  lastDirection: MessageDirection;
  preview: string;
  messageCount: number;
  links: string[];
}

// Absolute URLs run to whitespace or a closing delimiter; /pages/ paths only count when they start
// a token, so the /pages/ inside a full URL is not extracted a second time.
const LINK_PATTERN = /https?:\/\/[^\s<>"'`)\]]+|(?<![\w/:.~-])\/pages\/[\w.~%/-]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?*_]+$/;

/** http(s) URLs and /pages/... paths in order of appearance, trailing sentence punctuation removed. */
export function extractLinks(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(LINK_PATTERN)) {
    const link = match[0].replace(TRAILING_PUNCTUATION, '');
    if (link.length > '/pages/'.length) found.push(link);
  }
  return found;
}

/** One line, whitespace collapsed, cut to the limit with an ellipsis. */
export function makePreview(text: string, max = MANIFEST_PREVIEW_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Returns an integer hours value in 1..168, the default when absent, or null when it is not a whole number. */
export function parseManifestHours(raw: string | null): number | null {
  if (raw === null) return MANIFEST_DEFAULT_HOURS;
  if (!/^\d{1,9}$/.test(raw.trim())) return null;
  return Math.min(MANIFEST_MAX_HOURS, Math.max(1, parseInt(raw, 10)));
}

/** Groups messages (any order) into thread rows, newest thread first. */
export function buildManifest(messages: ManifestMessage[]): ManifestRow[] {
  const ordered = [...messages].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const rows = new Map<string, ManifestRow>();
  for (const m of ordered) {
    if (!m.agent) continue;
    const topic = m.topic?.trim() || MANIFEST_GENERAL_TOPIC;
    const key = `${m.agent}\u0000${topic}`;
    let row = rows.get(key);
    // Newest first, so the first message seen for a thread is its last one.
    if (!row) {
      row = { agent: m.agent, topic, lastMessageAt: m.createdAt, lastDirection: m.direction, preview: makePreview(m.message), messageCount: 0, links: [] };
      rows.set(key, row);
    }
    row.messageCount++;
    for (const link of extractLinks(m.message)) {
      if (row.links.length < MANIFEST_MAX_LINKS && !row.links.includes(link)) row.links.push(link);
    }
  }
  return [...rows.values()];
}
