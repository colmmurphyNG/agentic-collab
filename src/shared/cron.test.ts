import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, nextFireAt } from './cron.ts';


describe('parseCron — field validation', () => {
  it('should accept a 5-field expression of wildcards', () => {
    const c = parseCron('* * * * *');
    assert.equal(c.minute.wildcard, true);
    assert.equal(c.minute.allowed.length, 60);
    assert.equal(c.hour.allowed.length, 24);
  });

  it('should accept a literal-number field', () => {
    const c = parseCron('5 12 * * *');
    assert.deepEqual(c.minute.allowed, [5]);
    assert.deepEqual(c.hour.allowed, [12]);
    assert.equal(c.minute.wildcard, false);
  });

  it('should accept a */N step value', () => {
    const c = parseCron('0 */5 * * *');
    assert.deepEqual(c.hour.allowed, [0, 5, 10, 15, 20]);
    assert.equal(c.hour.wildcard, false);
  });

  it('should treat */1 as a wildcard equivalent', () => {
    const c = parseCron('*/1 * * * *');
    assert.equal(c.minute.wildcard, true);
    assert.equal(c.minute.allowed.length, 60);
  });

  it('should reject expressions with the wrong field count', () => {
    assert.throws(() => parseCron('* * * *'), /5 space-separated fields/);
    assert.throws(() => parseCron('* * * * * *'), /5 space-separated fields/);
  });

  it('should reject out-of-range literal values', () => {
    assert.throws(() => parseCron('60 * * * *'), /value 60 out of range/);
    assert.throws(() => parseCron('* 24 * * *'), /value 24 out of range/);
    assert.throws(() => parseCron('* * 0 * *'), /value 0 out of range/);
    assert.throws(() => parseCron('* * * 13 *'), /value 13 out of range/);
    assert.throws(() => parseCron('* * * * 7'), /value 7 out of range/);
  });

  it('should reject genuinely unsupported syntax with a clear error', () => {
    // Named day/month — not implemented in v1.1
    assert.throws(() => parseCron('MON * * * *'), /supported syntax/);
    // Garbage tokens
    assert.throws(() => parseCron('!@# * * * *'), /supported syntax/);
  });

  it('should reject a zero or negative step', () => {
    assert.throws(() => parseCron('*/0 * * * *'), /must be a positive integer/);
  });
});


describe('parseCron — JJ-1.1 range + list extensions', () => {
  it('should accept a m-n range', () => {
    const c = parseCron('* * * * 1-5');
    assert.deepEqual(c.dayOfWeek.allowed, [1, 2, 3, 4, 5]);
    assert.equal(c.dayOfWeek.wildcard, false);
  });

  it('should accept a m-n range that covers the full field as wildcard', () => {
    const c = parseCron('* * * * 0-6');
    assert.deepEqual(c.dayOfWeek.allowed, [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(c.dayOfWeek.wildcard, true);
  });

  it('should accept a comma-separated list of literals', () => {
    const c = parseCron('1,3,5 * * * *');
    assert.deepEqual(c.minute.allowed, [1, 3, 5]);
    assert.equal(c.minute.wildcard, false);
  });

  it('should accept a comma-separated list of ranges', () => {
    const c = parseCron('* * * * 1-3,5');
    assert.deepEqual(c.dayOfWeek.allowed, [1, 2, 3, 5]);
  });

  it('should accept a m-n/k range with step', () => {
    const c = parseCron('* 0-12/3 * * *');
    assert.deepEqual(c.hour.allowed, [0, 3, 6, 9, 12]);
  });

  it('should dedupe overlapping list terms', () => {
    const c = parseCron('1,1,2,2,3-5,4 * * * *');
    assert.deepEqual(c.minute.allowed, [1, 2, 3, 4, 5]);
  });

  it('should reject out-of-range ranges', () => {
    assert.throws(() => parseCron('* * * * 0-7'), /out of range/);
    assert.throws(() => parseCron('60-65 * * * *'), /out of range/);
  });

  it('should reject reversed ranges (lo > hi)', () => {
    assert.throws(() => parseCron('* * * * 5-1'), /lo > hi/);
  });

  it('should reject empty list terms', () => {
    assert.throws(() => parseCron('1,,3 * * * *'), /empty list term/);
  });

  it('should reject zero-step ranges', () => {
    assert.throws(() => parseCron('* 0-12/0 * * *'), /step.*positive integer/);
  });
});


describe('nextFireAt — JJ-1.1 weekday range (tl prev-sweep case)', () => {
  it('should fire Mon-Fri at 07:55 UTC for `55 7 * * 1-5`', () => {
    const cron = parseCron('55 7 * * 1-5');
    // 2026-06-01 is a Monday → next fire is Mon 07:55
    const monMorning = nextFireAt(cron, new Date(Date.UTC(2026, 5, 1, 0, 0, 0)));
    assert.equal(monMorning.toISOString(), '2026-06-01T07:55:00.000Z');

    const tuMorning = nextFireAt(cron, monMorning);
    assert.equal(tuMorning.toISOString(), '2026-06-02T07:55:00.000Z');

    // After Friday's fire, next should skip Sat/Sun and land on Mon
    const friMorning = nextFireAt(cron, new Date(Date.UTC(2026, 5, 5, 8, 0, 0)));
    assert.equal(friMorning.toISOString(), '2026-06-08T07:55:00.000Z');
  });

  it('should fire Mon-Fri at 13:05 UTC for `5 13 * * 1-5`', () => {
    const cron = parseCron('5 13 * * 1-5');
    const monAfternoon = nextFireAt(cron, new Date(Date.UTC(2026, 5, 1, 0, 0, 0)));
    assert.equal(monAfternoon.toISOString(), '2026-06-01T13:05:00.000Z');
  });

  it('should fire each value in a comma-list on subsequent calls', () => {
    const cron = parseCron('0 9,13,17 * * *');  // 3 fires per day
    const t0 = new Date(Date.UTC(2026, 5, 1, 0, 0, 0));
    const t1 = nextFireAt(cron, t0);
    assert.equal(t1.toISOString(), '2026-06-01T09:00:00.000Z');
    const t2 = nextFireAt(cron, t1);
    assert.equal(t2.toISOString(), '2026-06-01T13:00:00.000Z');
    const t3 = nextFireAt(cron, t2);
    assert.equal(t3.toISOString(), '2026-06-01T17:00:00.000Z');
    const t4 = nextFireAt(cron, t3);
    assert.equal(t4.toISOString(), '2026-06-02T09:00:00.000Z');
  });
});


describe('nextFireAt — every-5-hours (the canonical JJ case)', () => {
  it('should fire at 00:00, 05:00, 10:00, 15:00, 20:00 on the hour', () => {
    const cron = parseCron('0 */5 * * *');
    // from just after midnight UTC, next fire is 05:00
    let next = nextFireAt(cron, new Date(Date.UTC(2026, 5, 1, 0, 1, 0)));
    assert.equal(next.toISOString(), '2026-06-01T05:00:00.000Z');
    next = nextFireAt(cron, next);
    assert.equal(next.toISOString(), '2026-06-01T10:00:00.000Z');
    next = nextFireAt(cron, next);
    assert.equal(next.toISOString(), '2026-06-01T15:00:00.000Z');
    next = nextFireAt(cron, next);
    assert.equal(next.toISOString(), '2026-06-01T20:00:00.000Z');
    next = nextFireAt(cron, next);
    // Next 5h slot after 20:00 wraps to 00:00 the next day
    assert.equal(next.toISOString(), '2026-06-02T00:00:00.000Z');
  });
});


describe('nextFireAt — common patterns', () => {
  it('should fire at the next minute boundary for `* * * * *`', () => {
    const from = new Date(Date.UTC(2026, 5, 1, 12, 30, 25));  // 12:30:25
    const next = nextFireAt('* * * * *', from);
    assert.equal(next.toISOString(), '2026-06-01T12:31:00.000Z');
  });

  it('should fire daily at 9:00 UTC for `0 9 * * *`', () => {
    const from = new Date(Date.UTC(2026, 5, 1, 8, 0, 0));  // 08:00
    const next = nextFireAt('0 9 * * *', from);
    assert.equal(next.toISOString(), '2026-06-01T09:00:00.000Z');

    // Already past 09:00 → fire next day
    const after = nextFireAt('0 9 * * *', new Date(Date.UTC(2026, 5, 1, 10, 0, 0)));
    assert.equal(after.toISOString(), '2026-06-02T09:00:00.000Z');
  });

  it('should fire weekly on Friday at 17:00 for `0 17 * * 5`', () => {
    // 2026-06-01 is a Monday
    const from = new Date(Date.UTC(2026, 5, 1, 0, 0, 0));
    const next = nextFireAt('0 17 * * 5', from);
    // Next Friday is 2026-06-05
    assert.equal(next.toISOString(), '2026-06-05T17:00:00.000Z');
  });

  it('should fire monthly on the 1st at midnight for `0 0 1 * *`', () => {
    const from = new Date(Date.UTC(2026, 5, 2, 0, 0, 0));  // June 2
    const next = nextFireAt('0 0 1 * *', from);
    assert.equal(next.toISOString(), '2026-07-01T00:00:00.000Z');
  });

  it('should always return a time strictly after `from`', () => {
    const cron = parseCron('0 */5 * * *');
    const exact = new Date(Date.UTC(2026, 5, 1, 5, 0, 0));  // exactly on a fire time
    const next = nextFireAt(cron, exact);
    // Strictly after — next fire is 10:00, not 05:00 again
    assert.equal(next.toISOString(), '2026-06-01T10:00:00.000Z');
  });
});


describe('nextFireAt — day-of-month / day-of-week OR semantics', () => {
  it('should match either DOM or DOW when both are restricted (BSD/Linux cron OR)', () => {
    // Fire on the 1st OR on Sundays
    // 2026-06-01 is a Monday (DOM matches, DOW does not) → fire 00:00 same day at minute 0
    const cron = parseCron('0 0 1 * 0');
    const from = new Date(Date.UTC(2026, 4, 31, 23, 0, 0));  // May 31 23:00
    const next = nextFireAt(cron, from);
    // Next match: June 1 at 00:00 (DOM=1 matches)
    assert.equal(next.toISOString(), '2026-06-01T00:00:00.000Z');

    // Then Sunday June 7 at 00:00 should be next (DOW=0)
    const next2 = nextFireAt(cron, next);
    assert.equal(next2.toISOString(), '2026-06-07T00:00:00.000Z');
  });

  it('should AND DOM with month when DOW is wildcard', () => {
    // Fire on Feb 29 — only valid in leap years. From Jan 2026 the next
    // Feb 29 is in 2028 (~792 days), beyond our 366-day hard cap → throws.
    const cron = parseCron('0 0 29 2 *');
    const from = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    assert.throws(() => nextFireAt(cron, from), /no fire time/);

    // But from Mar 2027 the next Feb 29 (2028) IS within 366 days
    const fromCloser = new Date(Date.UTC(2027, 2, 1, 0, 0, 0));
    const next = nextFireAt(cron, fromCloser);
    assert.equal(next.toISOString(), '2028-02-29T00:00:00.000Z');
  });
});
