import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokenCookie, clearedTokenCookie, TOKEN_COOKIE_MAX_AGE } from './token-cookie.ts';

describe('tokenCookie', () => {
  it('should outlive the browser session, so a restart does not drop it while localStorage keeps the token', () => {
    assert.match(tokenCookie('abc'), new RegExp(`; max-age=${TOKEN_COOKIE_MAX_AGE}(;|$)`));
    assert.ok(TOKEN_COOKIE_MAX_AGE >= 30 * 24 * 3600);
  });

  it('should cover every page path and stay same-site only', () => {
    const c = tokenCookie('abc');
    assert.ok(c.startsWith('conductor_token=abc;'));
    assert.match(c, /; path=\/(;|$)/);
    assert.match(c, /; SameSite=Strict(;|$)/);
  });

  it('should encode characters that would break the cookie', () => {
    assert.ok(tokenCookie('a;b c').startsWith('conductor_token=a%3Bb%20c;'));
  });
});

describe('clearedTokenCookie', () => {
  it('should expire the cookie on the same path it was set on', () => {
    const c = clearedTokenCookie();
    assert.ok(c.startsWith('conductor_token=;'));
    assert.match(c, /; path=\/(;|$)/);
    assert.match(c, /; max-age=0(;|$)/);
  });
});
