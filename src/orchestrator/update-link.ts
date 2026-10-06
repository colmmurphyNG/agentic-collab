// Link validation for updates, kept outside routes.ts so it can be tested on its own.

const UPDATE_LINK_MAX = 2000;

/**
 * Only http(s) URLs and the orchestrator's own /pages/ paths. Quotes, angle brackets, backslashes
 * and whitespace are refused too, so a link can never break out of the href it is rendered into.
 */
export function updateLinkError(link: unknown): string | null {
  if (typeof link !== 'string' || !link.trim()) return 'link required';
  const value = link.trim();
  if (value.length > UPDATE_LINK_MAX) return `link must be at most ${UPDATE_LINK_MAX} characters`;
  if (/[\s"'<>\x60\\\x00-\x1F\x7F]/.test(value)) return 'link must not contain spaces, quotes, angle brackets or backslashes';
  if (value.startsWith('/pages/')) return null;
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname) return null;
    } catch {
      // Falls through to the rejection below.
    }
  }
  return 'link must be an http:// or https:// URL, or a path starting with /pages/';
}
