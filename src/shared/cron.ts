/**
 * Minimal 5-field cron parser for the JJ jobs capability.
 *
 * Supports:
 *   - Literal numbers: `5` means 'at minute 5'
 *   - Wildcard: `*` means 'any value in the field's range'
 *   - Step values: `*​/N` means 'every Nth value starting from 0'
 *
 * NOT supported (intentional, for v1):
 *   - Lists (`1,3,5`)
 *   - Ranges (`1-5`)
 *   - Named days/months (`MON`, `JAN`)
 *   - Seconds (Quartz-style 6-field cron)
 *   - DST handling — all calculations operate on UTC; jobs that need
 *     local-time precision will drift twice a year.
 *
 * Field order matches Linux cron:
 *   minute (0-59)  hour (0-23)  day-of-month (1-31)  month (1-12)  day-of-week (0-6, Sunday=0)
 *
 * If both day-of-month and day-of-week are restricted (i.e. neither is `*`),
 * cron semantics OR them (match if either passes). This matches BSD/Linux cron.
 *
 * Zero-dep — pure stdlib JS, no Date library.
 */


export type CronFieldSpec = {
  /** Set of allowed values for this field, sorted ascending. */
  allowed: number[];
  /** True when the field accepted any value in its range (`*` or `*​/1`). */
  wildcard: boolean;
};


export type CronExpression = {
  raw: string;
  minute: CronFieldSpec;
  hour: CronFieldSpec;
  dayOfMonth: CronFieldSpec;
  month: CronFieldSpec;
  dayOfWeek: CronFieldSpec;
};


const FIELD_RANGES = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 6 },
] as const;


function parseField(spec: string, min: number, max: number, fieldName: string): CronFieldSpec {
  spec = spec.trim();
  if (spec === '') {
    throw new Error(`invalid cron field '${fieldName}': empty`);
  }

  if (spec === '*') {
    const allowed: number[] = [];
    for (let i = min; i <= max; i++) allowed.push(i);
    return { allowed, wildcard: true };
  }

  const stepMatch = spec.match(/^\*\/(\d+)$/);
  if (stepMatch) {
    const step = parseInt(stepMatch[1]!, 10);
    if (!Number.isFinite(step) || step <= 0) {
      throw new Error(`invalid cron field '${fieldName}': step '${spec}' must be a positive integer`);
    }
    const allowed: number[] = [];
    for (let i = min; i <= max; i += step) allowed.push(i);
    return { allowed, wildcard: step === 1 };
  }

  if (/^\d+$/.test(spec)) {
    const value = parseInt(spec, 10);
    if (value < min || value > max) {
      throw new Error(`invalid cron field '${fieldName}': value ${value} out of range [${min},${max}]`);
    }
    return { allowed: [value], wildcard: false };
  }

  throw new Error(`invalid cron field '${fieldName}': '${spec}' — only literals, '*', and '*​/N' are supported`);
}


export function parseCron(expr: string): CronExpression {
  if (typeof expr !== 'string') {
    throw new Error('cron expression must be a string');
  }
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron expression must have 5 space-separated fields; got ${parts.length}: '${expr}'`);
  }
  const fields: Record<string, CronFieldSpec> = {};
  for (let i = 0; i < 5; i++) {
    const { name, min, max } = FIELD_RANGES[i]!;
    fields[name] = parseField(parts[i]!, min, max, name);
  }
  return {
    raw: expr.trim(),
    minute: fields['minute']!,
    hour: fields['hour']!,
    dayOfMonth: fields['dayOfMonth']!,
    month: fields['month']!,
    dayOfWeek: fields['dayOfWeek']!,
  };
}


/**
 * Compute the next moment (strictly after `from`) when the cron expression
 * matches. Operates in UTC. Returns a Date.
 *
 * Strategy: increment the time minute-by-minute until all five fields
 * match. The number of iterations is bounded — for any valid cron the next
 * fire is at most ~366 days away (yearly schedules like `0 0 1 1 *`), so
 * a hard cap of 366 × 24 × 60 = ~527K minutes is more than enough. In
 * practice the loop exits in seconds for any non-pathological cron.
 *
 * For higher throughput we could skip-ahead per field, but the simpler
 * minute-walk is correct and fast enough for jobs that fire at most every
 * minute.
 */
export function nextFireAt(expr: CronExpression | string, from: Date = new Date()): Date {
  const cron = typeof expr === 'string' ? parseCron(expr) : expr;

  const minuteSet = new Set(cron.minute.allowed);
  const hourSet = new Set(cron.hour.allowed);
  const monthSet = new Set(cron.month.allowed);
  const dayOfMonthSet = new Set(cron.dayOfMonth.allowed);
  const dayOfWeekSet = new Set(cron.dayOfWeek.allowed);
  const domWildcard = cron.dayOfMonth.wildcard;
  const dowWildcard = cron.dayOfWeek.wildcard;

  // Start at the next whole minute strictly after `from`.
  const candidate = new Date(Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth(),
    from.getUTCDate(),
    from.getUTCHours(),
    from.getUTCMinutes() + 1,
    0,
    0,
  ));

  const HARD_CAP_MINUTES = 366 * 24 * 60;
  for (let i = 0; i < HARD_CAP_MINUTES; i++) {
    const dom = candidate.getUTCDate();
    const dow = candidate.getUTCDay();
    const matchDom = dayOfMonthSet.has(dom);
    const matchDow = dayOfWeekSet.has(dow);
    // BSD/Linux cron OR semantics: when both DOM and DOW are restricted,
    // either match passes. When one is wildcard, AND semantics apply.
    let dayOk: boolean;
    if (domWildcard && dowWildcard) {
      dayOk = true;
    } else if (domWildcard) {
      dayOk = matchDow;
    } else if (dowWildcard) {
      dayOk = matchDom;
    } else {
      dayOk = matchDom || matchDow;
    }

    if (
      minuteSet.has(candidate.getUTCMinutes()) &&
      hourSet.has(candidate.getUTCHours()) &&
      monthSet.has(candidate.getUTCMonth() + 1) &&
      dayOk
    ) {
      return candidate;
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  throw new Error(`no fire time for cron '${cron.raw}' within ${HARD_CAP_MINUTES} minutes of ${from.toISOString()}`);
}
