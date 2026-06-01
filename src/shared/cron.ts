/**
 * Minimal 5-field cron parser for the JJ jobs capability.
 *
 * Supports:
 *   - Literal numbers: `5` means 'at minute 5'
 *   - Wildcard: `*` means 'any value in the field's range'
 *   - Step values: `*​/N` means 'every Nth value starting from 0'
 *   - Ranges: `m-n` means 'every value from m to n inclusive'
 *   - Lists: `a,b,c` means 'each listed value' — list members may themselves
 *     be literals or ranges (e.g. `1-3,5,8-10`)
 *   - Range with step: `m-n/k` means 'every kth value from m to n'
 *
 * NOT supported (intentional, for v1):
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


/**
 * Parse one comma-list term — either a literal, a range (`m-n`), or a
 * range with step (`m-n/k`). Returns the set of integers it expands to.
 * Used internally by parseField via the comma split.
 */
function parseFieldTerm(term: string, min: number, max: number, fieldName: string): number[] {
  // m-n/k — range with step
  const rangeStepMatch = term.match(/^(\d+)-(\d+)\/(\d+)$/);
  if (rangeStepMatch) {
    const lo = parseInt(rangeStepMatch[1]!, 10);
    const hi = parseInt(rangeStepMatch[2]!, 10);
    const step = parseInt(rangeStepMatch[3]!, 10);
    if (!Number.isFinite(step) || step <= 0) {
      throw new Error(`invalid cron field '${fieldName}': step in '${term}' must be a positive integer`);
    }
    if (lo < min || lo > max || hi < min || hi > max) {
      throw new Error(`invalid cron field '${fieldName}': range '${term}' out of range [${min},${max}]`);
    }
    if (lo > hi) {
      throw new Error(`invalid cron field '${fieldName}': range '${term}' has lo > hi`);
    }
    const out: number[] = [];
    for (let i = lo; i <= hi; i += step) out.push(i);
    return out;
  }

  // m-n — range
  const rangeMatch = term.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const lo = parseInt(rangeMatch[1]!, 10);
    const hi = parseInt(rangeMatch[2]!, 10);
    if (lo < min || lo > max || hi < min || hi > max) {
      throw new Error(`invalid cron field '${fieldName}': range '${term}' out of range [${min},${max}]`);
    }
    if (lo > hi) {
      throw new Error(`invalid cron field '${fieldName}': range '${term}' has lo > hi`);
    }
    const out: number[] = [];
    for (let i = lo; i <= hi; i++) out.push(i);
    return out;
  }

  // literal
  if (/^\d+$/.test(term)) {
    const value = parseInt(term, 10);
    if (value < min || value > max) {
      throw new Error(`invalid cron field '${fieldName}': value ${value} out of range [${min},${max}]`);
    }
    return [value];
  }

  throw new Error(`invalid cron field '${fieldName}': term '${term}' — supported syntax: literal, m-n, m-n/k`);
}


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

  // Comma-separated list — each term may be a literal, range, or range with step.
  // The single-term case (no comma) falls through this path naturally.
  if (/^[\d,\-/]+$/.test(spec)) {
    const terms = spec.split(',');
    const seen = new Set<number>();
    for (const term of terms) {
      const trimmed = term.trim();
      if (trimmed === '') {
        throw new Error(`invalid cron field '${fieldName}': empty list term in '${spec}'`);
      }
      for (const value of parseFieldTerm(trimmed, min, max, fieldName)) {
        seen.add(value);
      }
    }
    const allowed = [...seen].sort((a, b) => a - b);
    // wildcard=true only when allowed set covers the full [min,max] range
    const wildcard = allowed.length === (max - min + 1) && allowed[0] === min && allowed[allowed.length - 1] === max;
    return { allowed, wildcard };
  }

  throw new Error(`invalid cron field '${fieldName}': '${spec}' — supported syntax: literal, *, */N, m-n, m-n/k, comma-separated lists thereof`);
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
