/**
 * Tests for the schedule model (interval + time window + days ↔ cron).
 * Run with: `node --import tsx --test tests/schedule.spec.ts`
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  cronToSchedule,
  defaultScheduleDraft,
  describeDraftEnglish,
  formatMinutesOfDay,
  scheduleToCron,
} from '../src/schedule.ts'

test('default draft renders a work-hours polling cadence', () => {
  const draft = defaultScheduleDraft()
  assert.equal(scheduleToCron(draft), '*/30 9-18 * * *')
})

test('weekdays hourly window round-trips', () => {
  const expression = '0 10-18 * * 1-5'
  const draft = cronToSchedule(expression)
  assert.ok(draft)
  assert.equal(draft.dayMode, 'weekdays')
  assert.equal(draft.intervalMinutes, 60)
  assert.equal(draft.allDay, false)
  assert.equal(draft.startMinute, 10 * 60)
  assert.equal(draft.endMinute, 18 * 60)
  assert.equal(scheduleToCron(draft), expression)
})

test('every-30-minutes window round-trips', () => {
  const expression = '*/30 9-18 * * *'
  const draft = cronToSchedule(expression)
  assert.ok(draft)
  assert.equal(draft.dayMode, 'daily')
  assert.equal(draft.intervalMinutes, 30)
  assert.equal(draft.startMinute, 9 * 60)
  // The hour range 9-18 includes 18:30 — the true last fire.
  assert.equal(draft.endMinute, 18 * 60 + 30)
  assert.equal(scheduleToCron(draft), expression)
})

test('phase-shifted minute list round-trips', () => {
  const expression = '15,45 9-17 * * *'
  const draft = cronToSchedule(expression)
  assert.ok(draft)
  assert.equal(draft.intervalMinutes, 30)
  assert.equal(draft.startMinute, 9 * 60 + 15)
  assert.equal(draft.endMinute, 17 * 60 + 45)
  assert.equal(scheduleToCron(draft), expression)
})

test('all-day every 15 minutes round-trips', () => {
  const expression = '*/15 * * * *'
  const draft = cronToSchedule(expression)
  assert.ok(draft)
  assert.equal(draft.allDay, true)
  assert.equal(draft.intervalMinutes, 15)
  assert.equal(scheduleToCron(draft), expression)
})

test('all-day hourly at a phase round-trips', () => {
  const expression = '15 * * * *'
  const draft = cronToSchedule(expression)
  assert.ok(draft)
  assert.equal(draft.allDay, true)
  assert.equal(draft.intervalMinutes, 60)
  assert.equal(draft.startMinute, 15)
  assert.equal(scheduleToCron(draft), expression)
})

test('every minute round-trips', () => {
  const expression = '* * * * *'
  const draft = cronToSchedule(expression)
  assert.ok(draft)
  assert.equal(draft.intervalMinutes, 1)
  assert.equal(draft.allDay, true)
  assert.equal(scheduleToCron(draft), expression)
})

test('fixed daily time round-trips', () => {
  const expression = '0 9 * * *'
  const draft = cronToSchedule(expression)
  assert.ok(draft)
  assert.equal(draft.intervalMinutes, 1440)
  assert.equal(draft.startMinute, 9 * 60)
  assert.equal(draft.endMinute, 9 * 60)
  assert.equal(scheduleToCron(draft), expression)
})

test('fixed weekly time round-trips', () => {
  const expression = '30 8 * * 1,3,5'
  const draft = cronToSchedule(expression)
  assert.ok(draft)
  assert.equal(draft.dayMode, 'weekly')
  assert.deepEqual(draft.weekdays, [1, 3, 5])
  assert.equal(draft.intervalMinutes, 1440)
  assert.equal(draft.startMinute, 8 * 60 + 30)
  assert.equal(scheduleToCron(draft), expression)
})

test('weekends round-trips', () => {
  const expression = '0 9 * * 0,6'
  const draft = cronToSchedule(expression)
  assert.ok(draft)
  assert.equal(draft.dayMode, 'weekends')
  assert.equal(scheduleToCron(draft), expression)
})

test('every-2-hours window round-trips', () => {
  const expression = '0 9,11,13,15,17 * * *'
  const draft = cronToSchedule(expression)
  assert.ok(draft)
  assert.equal(draft.intervalMinutes, 120)
  assert.equal(draft.startMinute, 9 * 60)
  assert.equal(draft.endMinute, 17 * 60)
  assert.equal(scheduleToCron(draft), expression)
})

test('sparse hour steps round-trip (9:00 and 18:00)', () => {
  const expression = '0 9,18 * * *'
  const draft = cronToSchedule(expression)
  assert.ok(draft)
  assert.equal(draft.intervalMinutes, 9 * 60)
  assert.equal(scheduleToCron(draft), expression)
})

test('all-day every 2 hours round-trips via step syntax', () => {
  const expression = '0 */2 * * *'
  const draft = cronToSchedule(expression)
  assert.ok(draft)
  assert.equal(draft.intervalMinutes, 120)
  // `*/2` covers hours 0..22; the model reads it as the precise window.
  assert.equal(draft.allDay, false)
  assert.equal(draft.startMinute, 0)
  assert.equal(draft.endMinute, 22 * 60)
  assert.equal(scheduleToCron(draft), expression)
})

test('unexpressible expressions fall back to undefined', () => {
  // Monthly day-of-month.
  assert.equal(cronToSchedule('0 9 15 * *'), undefined)
  // Month restriction.
  assert.equal(cronToSchedule('0 9 * JAN *'), undefined)
  // Seconds field.
  assert.equal(cronToSchedule('30 0 12 * * MON'), undefined)
  // Non-contiguous hours with a minute step.
  assert.equal(cronToSchedule('*/30 9,12 * * *'), undefined)
  // Non-divisor minute step.
  assert.equal(cronToSchedule('0,45 * * * *'), undefined)
  // Plain minute list (not a step pattern).
  assert.equal(cronToSchedule('1,2,3 * * * *'), undefined)
  // Invalid text.
  assert.equal(cronToSchedule('not cron'), undefined)
})

test('round-trip identity across a canonical set', () => {
  const canonical = [
    '*/30 9-18 * * *',
    '*/30 9-18 * * 1-5',
    '0 10-18 * * 1-5',
    '15,45 9-17 * * *',
    '*/15 * * * *',
    '15 * * * *',
    '* * * * *',
    '0 9 * * *',
    '30 8 * * 1,3,5',
    '0 9 * * 0,6',
    '0 9,11,13,15,17 * * *',
    '0 */2 * * *',
    '5,35 * * * *',
    '0 9,18 * * *',
    '30 9,18 * * *',
  ]
  for (const expression of canonical) {
    const draft = cronToSchedule(expression)
    assert.ok(draft, `expected "${expression}" to be expressible`)
    assert.equal(scheduleToCron(draft), expression, `identity failed for "${expression}"`)
  }
})

test('formatMinutesOfDay pads', () => {
  assert.equal(formatMinutesOfDay(0), '00:00')
  assert.equal(formatMinutesOfDay(9 * 60 + 5), '09:05')
  assert.equal(formatMinutesOfDay(23 * 60 + 59), '23:59')
})

test('english description reads naturally', () => {
  assert.equal(describeDraftEnglish({ ...defaultScheduleDraft() }), 'every 30 minutes between 09:00 and 18:00 daily')
  const weekdays = cronToSchedule('0 10-18 * * 1-5')
  assert.ok(weekdays)
  assert.equal(describeDraftEnglish(weekdays), 'every 1 hour between 10:00 and 18:00 on weekdays')
  const fixed = cronToSchedule('30 8 * * 1,3,5')
  assert.ok(fixed)
  assert.equal(describeDraftEnglish(fixed), 'at 08:30 on Mon, Wed, Fri')
})
