/**
 * Tests for the pure cron parser/calculator.
 * Run with: `node --import tsx --test tests/cron.spec.ts`
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  CronSyntaxError,
  describeCron,
  isValidTimeZone,
  matchesCron,
  nextCronMatch,
  parseCron,
  partsToUtc,
  zonedParts,
} from '../src/cron.ts'

test('parses a simple 5-field expression', () => {
  const cron = parseCron('*/15 9 * * 1-5')
  assert.equal(cron.seconds, false)
  assert.deepEqual(cron.minute.values, [0, 15, 30, 45])
  assert.deepEqual(cron.hour.values, [9])
  assert.equal(cron.dayOfMonth.wildcard, true)
  assert.deepEqual(cron.month.values, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  assert.deepEqual(cron.dayOfWeek.values, [1, 2, 3, 4, 5])
})

test('parses 6-field expression with seconds', () => {
  const cron = parseCron('30 0 12 * * MON')
  assert.equal(cron.seconds, true)
  assert.deepEqual(cron.second.values, [30])
  assert.deepEqual(cron.dayOfWeek.values, [1])
})

test('parses names and 0/7 Sunday forms', () => {
  assert.deepEqual(parseCron('0 9 1 JAN *').month.values, [1])
  assert.deepEqual(parseCron('0 9 * * SUN').dayOfWeek.values, [0])
  assert.deepEqual(parseCron('0 9 * * 7').dayOfWeek.values, [7])
  assert.deepEqual(parseCron('0 9 * * MON-FRI').dayOfWeek.values, [1, 2, 3, 4, 5])
})

test('rejects invalid expressions', () => {
  assert.throws(() => parseCron(''), CronSyntaxError)
  assert.throws(() => parseCron('*'), CronSyntaxError)
  assert.throws(() => parseCron('a b c d e'), CronSyntaxError)
  assert.throws(() => parseCron('60 * * * *'), CronSyntaxError)
  assert.throws(() => parseCron('* 24 * * *'), CronSyntaxError)
  assert.throws(() => parseCron('* * 0 * *'), CronSyntaxError)
  assert.throws(() => parseCron('* * 32 * *'), CronSyntaxError)
  assert.throws(() => parseCron('* * * 13 *'), CronSyntaxError)
  assert.throws(() => parseCron('* * * * 8'), CronSyntaxError)
  assert.throws(() => parseCron('* * * * FOO'), CronSyntaxError)
  assert.throws(() => parseCron('* * * * MON-FOO'), CronSyntaxError)
  assert.throws(() => parseCron('* * * * 3-1'), CronSyntaxError)
  assert.throws(() => parseCron('1-2-3 * * * *'), CronSyntaxError)
  assert.throws(() => parseCron('*/0 * * * *'), CronSyntaxError)
})

test('matches simple minute-level rules in UTC', () => {
  const everyMinute = parseCron('* * * * *')
  // 2026-06-01T00:00:00Z is a Monday.
  const base = Date.UTC(2026, 5, 1, 0, 0, 0)
  assert.equal(matchesCron(everyMinute, zonedParts(base, 'UTC')), true)

  const atNine = parseCron('0 9 * * *')
  assert.equal(matchesCron(atNine, zonedParts(Date.UTC(2026, 5, 1, 9, 0), 'UTC')), true)
  assert.equal(matchesCron(atNine, zonedParts(Date.UTC(2026, 5, 1, 9, 1), 'UTC')), false)

  const weekdaysNine = parseCron('0 9 * * 1-5')
  assert.equal(matchesCron(weekdaysNine, zonedParts(Date.UTC(2026, 5, 1, 9, 0), 'UTC')), true) // Mon
  assert.equal(matchesCron(weekdaysNine, zonedParts(Date.UTC(2026, 5, 6, 9, 0), 'UTC')), false) // Sat
})

test('day-of-month × day-of-week OR semantics', () => {
  const firstOrMonday = parseCron('0 9 1 * 1')
  // 2026-06-01 is BOTH the 1st and a Monday.
  assert.equal(matchesCron(firstOrMonday, zonedParts(Date.UTC(2026, 5, 1, 9, 0), 'UTC')), true)
  // 2026-06-08 is a Monday but not the 1st.
  assert.equal(matchesCron(firstOrMonday, zonedParts(Date.UTC(2026, 5, 8, 9, 0), 'UTC')), true)
  // 2026-06-15 is a Monday too.
  assert.equal(matchesCron(firstOrMonday, zonedParts(Date.UTC(2026, 5, 15, 9, 0), 'UTC')), true)
  // 2026-06-02 is neither.
  assert.equal(matchesCron(firstOrMonday, zonedParts(Date.UTC(2026, 5, 2, 9, 0), 'UTC')), false)
})

test('nextCronMatch advances minute by minute', () => {
  const everyMinute = parseCron('* * * * *')
  const from = Date.UTC(2026, 5, 1, 12, 30, 15)
  assert.equal(nextCronMatch(everyMinute, from, 'UTC'), Date.UTC(2026, 5, 1, 12, 31, 0))
})

test('nextCronMatch finds the next daily nine', () => {
  const atNine = parseCron('0 9 * * *')
  const from = Date.UTC(2026, 5, 1, 8, 0, 0)
  assert.equal(nextCronMatch(atNine, from, 'UTC'), Date.UTC(2026, 5, 1, 9, 0, 0))
  const afterNine = Date.UTC(2026, 5, 1, 10, 0, 0)
  assert.equal(nextCronMatch(atNine, afterNine, 'UTC'), Date.UTC(2026, 5, 2, 9, 0, 0))
})

test('nextCronMatch respects weekdays', () => {
  // 2026-06-01 is Monday; next Friday 9am from Monday 08:00 is the same day.
  const weekdaysNine = parseCron('0 9 * * 1-5')
  const mondayMorning = Date.UTC(2026, 5, 1, 8, 0, 0)
  assert.equal(nextCronMatch(weekdaysNine, mondayMorning, 'UTC'), Date.UTC(2026, 5, 1, 9, 0, 0))
  // From Friday 10:00 the next weekday nine is Monday 9am.
  const fridayLate = Date.UTC(2026, 5, 5, 10, 0, 0)
  assert.equal(nextCronMatch(weekdaysNine, fridayLate, 'UTC'), Date.UTC(2026, 5, 8, 9, 0, 0))
})

test('nextCronMatch handles month boundaries', () => {
  const firstOfMonth = parseCron('0 0 1 * *')
  const from = Date.UTC(2026, 5, 15)
  assert.equal(nextCronMatch(firstOfMonth, from, 'UTC'), Date.UTC(2026, 6, 1))
  const december = Date.UTC(2026, 11, 15)
  assert.equal(nextCronMatch(firstOfMonth, december, 'UTC'), Date.UTC(2027, 0, 1))
})

test('nextCronMatch handles steps and seconds', () => {
  const everyFiveMinutes = parseCron('*/5 * * * *')
  const from = Date.UTC(2026, 5, 1, 12, 33)
  assert.equal(nextCronMatch(everyFiveMinutes, from, 'UTC'), Date.UTC(2026, 5, 1, 12, 35))

  const withSeconds = parseCron('10 * * * * *')
  const sFrom = Date.UTC(2026, 5, 1, 12, 33, 20)
  assert.equal(nextCronMatch(withSeconds, sFrom, 'UTC'), Date.UTC(2026, 5, 1, 12, 34, 10))
})

test('time zone conversion round-trips', () => {
  const utc = Date.UTC(2026, 5, 1, 12, 0, 0)
  const shanghai = zonedParts(utc, 'Asia/Shanghai')
  assert.deepEqual(
    { hour: shanghai.hour, minute: shanghai.minute, day: shanghai.day },
    { hour: 20, minute: 0, day: 1 },
  )
  const back = partsToUtc(shanghai, 'Asia/Shanghai')
  assert.equal(back, utc)
})

test('nextCronMatch interprets rules in a named zone', () => {
  // 9am Asia/Shanghai = 1am UTC.
  const atNine = parseCron('0 9 * * *')
  const from = Date.UTC(2026, 5, 1, 0, 30, 0)
  assert.equal(nextCronMatch(atNine, from, 'Asia/Shanghai'), Date.UTC(2026, 5, 1, 1, 0, 0))
})

test('DST gap wall time is skipped (Europe/Berlin 2026-03-29)', () => {
  // Europe/Berlin spring-forward 2026-03-29 02:00 → 03:00 local.
  // A rule firing at 02:30 local must skip to 03:30 local.
  const atTwoThirty = parseCron('30 2 * * *')
  const from = Date.UTC(2026, 2, 29, 0, 0, 0)
  const next = nextCronMatch(atTwoThirty, from, 'Europe/Berlin')!
  const parts = zonedParts(next, 'Europe/Berlin')
  // The next day (2026-03-30) at 02:30 local is a valid target; the walk must
  // not return the nonexistent 2026-03-29 02:30. Verify the result is a
  // real instant whose local wall time matches the rule.
  assert.equal(parts.hour, 2)
  assert.equal(parts.minute, 30)
  // And the instant must exist (round-trips).
  assert.equal(partsToUtc(parts, 'Europe/Berlin'), next)
})

test('isValidTimeZone', () => {
  assert.equal(isValidTimeZone('Asia/Shanghai'), true)
  assert.equal(isValidTimeZone('UTC'), true)
  assert.equal(isValidTimeZone('Not/AZone'), false)
})

test('describeCron produces stable summaries', () => {
  assert.equal(describeCron(parseCron('0 9 * * *')), 'at 09:00 daily')
  assert.equal(describeCron(parseCron('0 9 * * 1,3,5')), 'at 09:00 on Monday, Wednesday, Friday')
  assert.equal(describeCron(parseCron('0 9 1 * *')), 'at 09:00 on day 1 of the month')
})
