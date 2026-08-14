/**
 * Pure-function cron expression parser and next-fire calculator.
 *
 * Supports the standard 5-field form (minute hour day-of-month month
 * day-of-week) and the 6-field form with a leading seconds field, plus:
 *   - `*` wildcard, `,` lists, `-` ranges, `/` steps
 *   - month names (JAN-DEC) and weekday names (SUN-SAT, 0 and 7 both = Sunday)
 *   - day-of-month × day-of-week OR semantics (standard cron: a date matches
 *     when EITHER restricted field matches)
 *   - explicit IANA time zones (defaults to the process local zone)
 *
 * Deterministic and side-effect free: every function returns plain values
 * and never reads clocks, environment, or files.
 *
 * @module dsh-polling/cron
 */

/** One parsed cron field: the set of allowed values in its domain. */
export interface CronField {
  /** Allowed values, sorted ascending and deduplicated. */
  readonly values: readonly number[]
  /** Whether this field was left unrestricted (`*` or an equivalent full range). */
  readonly wildcard: boolean
}

/** A parsed cron expression. */
export interface CronExpression {
  /** Whether the expression carries a leading seconds field. */
  readonly seconds: boolean
  readonly second: CronField
  readonly minute: CronField
  readonly hour: CronField
  readonly dayOfMonth: CronField
  readonly month: CronField
  readonly dayOfWeek: CronField
}

/** Error thrown for an expression that cannot be parsed. */
export class CronSyntaxError extends Error {
  constructor(
    message: string,
    readonly expression: string,
  ) {
    super(message)
    this.name = 'CronSyntaxError'
  }
}

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
}

const WEEKDAYS: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
}

/** Domain bounds per standard cron field (second, minute, hour, dom, month, dow). */
const DOMAINS: ReadonlyArray<readonly [number, number]> = [
  [0, 59], [0, 59], [0, 23], [1, 31], [1, 12], [0, 7],
]

/**
 * Parse one cron field token (e.g. `star/15`, `1-5`, `MON-FRI`, `1,15,30`).
 */
function parseField(
  token: string,
  min: number,
  max: number,
  names: Record<string, number> | undefined,
  expression: string,
  fieldLabel: string,
): CronField {
  if (token === '*') return { values: range(min, max), wildcard: true }

  const values = new Set<number>()
  let wildcard = false
  for (const part of token.split(',')) {
    if (part.length === 0) {
      throw new CronSyntaxError(`cron field "${fieldLabel}" contains an empty list entry`, expression)
    }
    const stepMatch = /^(.+?)\/(\d+)$/.exec(part)
    const step = stepMatch === null ? undefined : Number(stepMatch[2])
    const base = stepMatch === null ? part : stepMatch[1]!
    if (step !== undefined && step < 1) {
      throw new CronSyntaxError(`cron field "${fieldLabel}" has an invalid step in "${part}"`, expression)
    }
    if (base === '*') {
      wildcard = true
      for (let value = min; value <= max; value += step ?? 1) values.add(value)
      continue
    }
    const rangeMatch = /^(.+?)-(.+)$/.exec(base)
    if (rangeMatch !== null) {
      const from = parseValue(rangeMatch[1]!, min, max, names, expression, fieldLabel)
      const to = parseValue(rangeMatch[2]!, min, max, names, expression, fieldLabel)
      if (to < from) {
        throw new CronSyntaxError(
          `cron field "${fieldLabel}" has a descending range "${base}"`, expression,
        )
      }
      for (let value = from; value <= to; value += step ?? 1) values.add(value)
      continue
    }
    values.add(parseValue(base, min, max, names, expression, fieldLabel))
  }
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) {
    throw new CronSyntaxError(`cron field "${fieldLabel}" matches nothing`, expression)
  }
  return { values: sorted, wildcard }
}

/** Parse one bare numeric or named value. */
function parseValue(
  raw: string,
  min: number,
  max: number,
  names: Record<string, number> | undefined,
  expression: string,
  fieldLabel: string,
): number {
  const named = names?.[raw.toUpperCase()]
  let value: number
  if (named !== undefined) {
    value = named
  } else {
    if (!/^\d+$/.test(raw)) {
      throw new CronSyntaxError(
        `cron field "${fieldLabel}" has an unrecognized value "${raw}"`, expression,
      )
    }
    value = Number(raw)
  }
  if (value < min || value > max) {
    throw new CronSyntaxError(
      `cron field "${fieldLabel}" value ${value} is outside ${min}..${max}`, expression,
    )
  }
  return value
}

function range(min: number, max: number): number[] {
  const out: number[] = []
  for (let value = min; value <= max; value++) out.push(value)
  return out
}

/**
 * Parse a cron expression into its field sets.
 * @param expression - 5-field (`min hour dom month dow`) or 6-field
 *   (`sec min hour dom month dow`) cron text.
 * @returns the parsed expression.
 * @throws {@link CronSyntaxError} on any invalid input.
 */
export function parseCron(expression: string): CronExpression {
  if (typeof expression !== 'string') {
    throw new CronSyntaxError('cron expression must be a string', String(expression))
  }
  const fields = expression.trim().split(/\s+/)
  const seconds = fields.length === 6
  if (fields.length !== 5 && fields.length !== 6) {
    throw new CronSyntaxError(
      `cron expression must have 5 or 6 fields, got ${fields.length}`, expression,
    )
  }
  const [second, minute, hour, dayOfMonth, month, dayOfWeek] = seconds
    ? fields
    : [undefined, ...fields]
  return {
    seconds,
    second: parseField(second ?? '0', ...DOMAINS[0]!, undefined, expression, 'second'),
    minute: parseField(minute!, ...DOMAINS[1]!, undefined, expression, 'minute'),
    hour: parseField(hour!, ...DOMAINS[2]!, undefined, expression, 'hour'),
    dayOfMonth: parseField(dayOfMonth!, ...DOMAINS[3]!, undefined, expression, 'day-of-month'),
    month: parseField(month!, ...DOMAINS[4]!, MONTHS, expression, 'month'),
    dayOfWeek: parseField(dayOfWeek!, ...DOMAINS[5]!, WEEKDAYS, expression, 'day-of-week'),
  }
}

/** Wall-clock calendar parts in one time zone. */
export interface ZonedParts {
  readonly year: number
  /** 1-12. */
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
  /** Day of week: 0 = Sunday. */
  readonly weekday: number
}

const PARTS_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>()

/** Shared formatter per time zone (Intl.DateTimeFormat is expensive to mint). */
function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = PARTS_FORMATTER_CACHE.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    })
    PARTS_FORMATTER_CACHE.set(timeZone, formatter)
  }
  return formatter
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
}

/**
 * Decompose a UTC instant into wall-clock parts in a time zone.
 * @param utcMs - UTC epoch milliseconds.
 * @param timeZone - IANA zone name (e.g. `Asia/Shanghai`).
 * @returns the wall-clock parts.
 * @throws RangeError when the time zone is unknown (from Intl).
 */
export function zonedParts(utcMs: number, timeZone: string): ZonedParts {
  const parts = partsFormatter(timeZone).formatToParts(new Date(utcMs))
  const values: Record<string, string> = {}
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = part.value
  }
  const weekday = WEEKDAY_INDEX[values.weekday!]
  if (weekday === undefined) {
    throw new Error(`cron: formatter returned unknown weekday "${values.weekday}"`)
  }
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    weekday,
  }
}

/** The naive UTC epoch of a wall time (as if the zone offset were zero). */
function naiveEpoch(parts: ZonedParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
}

/** Zone offset (UTC − wall) at a UTC instant, in milliseconds. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  return naiveEpoch(zonedParts(utcMs, timeZone)) - utcMs
}

/**
 * Convert wall-clock parts back to a UTC instant in a time zone.
 *
 * Handles the two daylight-saving edge cases conservatively:
 * - a wall time inside a DST gap does not exist; returns `undefined`
 * - an overlap (clocks set back) resolves to the FIRST, earlier instant
 * @param parts - wall-clock parts.
 * @param timeZone - IANA zone name.
 * @returns the UTC instant, or `undefined` when the wall time does not exist.
 */
export function partsToUtc(parts: ZonedParts, timeZone: string): number | undefined {
  const naive = naiveEpoch(parts)
  // First guess: the offset in effect at the naive instant. Exact except
  // within one hour of a DST transition.
  const candidate = naive - zoneOffsetMs(naive, timeZone)
  // Verify the candidate maps back to the requested wall time. A gap maps to
  // a different wall time (clocks jumped forward); re-derive with the
  // candidate's own offset and re-verify before declaring the time missing.
  const verified = zonedParts(candidate, timeZone)
  if (sameWall(verified, parts)) return candidate
  const secondCandidate = naive - zoneOffsetMs(candidate, timeZone)
  const secondVerified = zonedParts(secondCandidate, timeZone)
  return sameWall(secondVerified, parts) ? secondCandidate : undefined
}

function sameWall(left: ZonedParts, right: ZonedParts): boolean {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute
    && left.second === right.second
}

/**
 * Whether a wall-clock calendar combination matches a parsed expression.
 * Standard cron OR semantics: when BOTH day-of-month and day-of-week are
 * restricted, a match on either field satisfies the date.
 */
export function matchesCron(expression: CronExpression, parts: ZonedParts): boolean {
  if (!includes(expression.month, parts.month)) return false
  if (!includes(expression.hour, parts.hour)) return false
  if (!includes(expression.minute, parts.minute)) return false
  if (!includes(expression.second, parts.second)) return false
  const domOk = includes(expression.dayOfMonth, parts.day)
  const dowOk = includes(expression.dayOfWeek, parts.weekday)
  if (expression.dayOfMonth.wildcard || expression.dayOfWeek.wildcard) {
    return domOk && dowOk
  }
  return domOk || dowOk
}

function includes(field: CronField, value: number): boolean {
  let low = 0
  let high = field.values.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const candidate = field.values[mid]!
    if (candidate === value) return true
    if (candidate < value) low = mid + 1
    else high = mid - 1
  }
  return false
}

/**
 * Compute the next UTC instant strictly after `from` at which the expression
 * matches, interpreted in `timeZone`.
 *
 * The search walks the target zone's wall clock on a naive time axis (the
 * wall-clock fields ARE the naive UTC fields, so stepping is pure
 * arithmetic), checks each candidate against the expression, and converts a
 * match back to a real UTC instant via {@link partsToUtc}. Wall times that
 * do not exist (DST gaps) convert to `undefined` and are skipped. The walk
 * is bounded by a one-year horizon; expressions whose next match lies beyond
 * it return `undefined`.
 * @param expression - parsed cron expression.
 * @param from - exclusive lower bound, UTC epoch milliseconds.
 * @param timeZone - IANA zone; defaults to the process local zone.
 * @returns the next matching UTC instant, or `undefined` past the horizon.
 */
export function nextCronMatch(
  expression: CronExpression,
  from: number,
  timeZone = defaultTimeZone(),
): number | undefined {
  const stepMs = (expression.seconds ? 1 : 60) * 1000
  const horizon = from + 366 * 24 * 60 * 60 * 1000
  // First candidate strictly after `from`, aligned to the step boundary on
  // the naive wall-clock axis.
  let naive = Math.floor(from / stepMs) * stepMs + stepMs

  for (let guard = 0; guard < 366 * 24 * 60 * 60; guard++) {
    const wall = naiveWallParts(naive)
    if (matchesCron(expression, wall)) {
      const utc = partsToUtc(wall, timeZone)
      if (utc !== undefined && utc > from) return utc
      // A match that does not exist in this zone (DST gap) or does not land
      // strictly after `from` cannot be returned; keep walking.
    }
    naive += stepMs
    if (naive > horizon) return undefined
  }
  return undefined
}

/** Wall-clock parts from a naive wall-clock epoch (UTC getters = wall fields). */
function naiveWallParts(naiveMs: number): ZonedParts {
  const date = new Date(naiveMs)
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    weekday: date.getUTCDay(),
  }
}

let cachedDefaultZone: string | undefined

/** The process-local IANA zone (cached; falls back to UTC on failure). */
export function defaultTimeZone(): string {
  if (cachedDefaultZone !== undefined) return cachedDefaultZone
  try {
    cachedDefaultZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    cachedDefaultZone = 'UTC'
  }
  return cachedDefaultZone
}

/** Validate an IANA time zone name without creating a formatter. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format()
    return true
  } catch {
    return false
  }
}

/** Convenience: parse + validate time zone in one call. */
export function parseCronWithZone(expression: string, timeZone?: string): CronExpression {
  const parsed = parseCron(expression)
  if (timeZone !== undefined && !isValidTimeZone(timeZone)) {
    throw new CronSyntaxError(`unknown time zone "${timeZone}"`, expression)
  }
  return parsed
}

/**
 * Render a human-readable summary of an expression (for tool results and
 * UI hints). Deterministic and locale-independent.
 */
export function describeCron(expression: CronExpression): string {
  const minute = expression.minute.values
  const hour = expression.hour.values
  const dom = expression.dayOfMonth
  const month = expression.month
  const dow = expression.dayOfWeek
  const time = `${pad(hour[0] ?? 0)}:${pad(minute[0] ?? 0)}`
  if (month.wildcard && dom.wildcard && dow.wildcard) return `at ${time} daily`
  if (month.wildcard && dom.wildcard && !dow.wildcard) {
    return `at ${time} on ${dow.values.map(weekdayName).join(', ')}`
  }
  if (month.wildcard && dow.wildcard && !dom.wildcard) {
    return `at ${time} on day ${dom.values.join(', ')} of the month`
  }
  if (dom.wildcard && dow.wildcard && !month.wildcard) {
    return `at ${time} in ${month.values.join(', ')}`
  }
  return `at ${time} (cron ${renderFields(expression)})`
}

function renderFields(expression: CronExpression): string {
  const f = (field: CronField): string => field.wildcard ? '*' : field.values.join(',')
  return expression.seconds
    ? `${f(expression.second)} ${f(expression.minute)} ${f(expression.hour)} ${f(expression.dayOfMonth)} ${f(expression.month)} ${f(expression.dayOfWeek)}`
    : `${f(expression.minute)} ${f(expression.hour)} ${f(expression.dayOfMonth)} ${f(expression.month)} ${f(expression.dayOfWeek)}`
}

function weekdayName(value: number): string {
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  return names[value % 7]!
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}
