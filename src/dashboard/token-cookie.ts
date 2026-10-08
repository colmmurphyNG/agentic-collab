/**
 * The `conductor_token` cookie that lets browser-direct navigation (e.g.
 * `<a href="/scratch">`) authenticate, since a link can't send a bearer header.
 * It must persist like the localStorage token it mirrors: a session cookie is
 * dropped on browser restart while the token survives, and the next link then
 * gets a 401 until the dashboard reloads and re-sets it.
 */
export const TOKEN_COOKIE_MAX_AGE = 365 * 24 * 3600;

export function tokenCookie(token) {
  return `conductor_token=${encodeURIComponent(token)}; path=/; SameSite=Strict; max-age=${TOKEN_COOKIE_MAX_AGE}`;
}

export function clearedTokenCookie() {
  return 'conductor_token=; path=/; SameSite=Strict; max-age=0';
}
