/**
 * Polling schedule model: the user-facing "interval + time window + days"
 * abstraction over a 5-field cron expression.
 *
 * Mature schedulers model recurring work as a frequency inside a time window
 * rather than a bare HH:MM instant:
 *   - Windows Task Scheduler: "repeat task every N minutes for a duration
 *     of Y" within a trigger window.
 *   - n8n Schedule Trigger: first-class interval mode (every N
 *     minutes/hours) plus day-of-week and time-range options.
 *   - GitHub Actions / cron conventions: `star/30 9-18 * * 1-5` (every 30
 *     minutes between 09:00 and 18:00 on weekdays).
 *
 * This module is the pure core of that model: it converts a schedule draft
 * to cron text (the durable form) and back, so the UI round-trips without
 * ever showing raw cron.
 *
 * Expressible subset (anything else round-trips as `undefined` → "custom"):
 *   - minute field: `*`, `star/N` (60 % N === 0), or a phase-shifted arithmetic
 *     list (`15,45`), all anchored per-hour;
 *   - hour field: `*`, `star/N`, a contiguous range (`9-18`), or an arithmetic
 *     list (`9,18` — an hour-unit step);
 *   - day-of-month `*`, month `*`, day-of-week any list.
 * @module dsh-polling/schedule
 */

import { parseCron, type CronExpression } from './cron.ts'

/** Which days of the week the schedule runs on. */
export type ScheduleDayMode = 'daily' | 'weekdays' | 'weekends' | 'weekly'

/**
 * One schedule draft: the editable shape behind the cron string.
 * Times are minutes of day (0-1439).
 */
export interface ScheduleDraft {
  readonly dayMode: ScheduleDayMode
  /** Cron weekday numbers (0 = Sunday) when `dayMode === 'weekly'`. */
  readonly weekdays: readonly number[]
  /** Minutes between consecutive fires (>= 1). */
  readonly intervalMinutes: number
  /** true: fires across all 24 hours; false: only inside the window. */
  readonly allDay: boolean
  /** Window start; also the phase anchor (`startMinute % 60` per hour). */
  readonly startMinute: number
  /** Window end (>= startMinute when not all-day). */
  readonly endMinute: number
}

/** Sensible default: every 30 minutes during work hours, daily. */
export function defaultScheduleDraft(): ScheduleDraft {
  return {
    dayMode: 'daily',
    weekdays: [1, 2, 3, 4, 5],
    intervalMinutes: 30,
    allDay: false,
    startMinute: 9 * 60,
    endMinute: 18 * 60,
  }
}

/** Format minutes of day as `HH:MM`. */
export function formatMinutesOfDay(minutes: number): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
}

/** Enumerate the fires of a draft as minutes of day (sorted ascending). */
function enumerateFires(draft: ScheduleDraft): number[] {
  const fires: number[] = []
  if (draft.intervalMinutes < 60) {
    // Minute-unit: the same per-hour minute list repeats each hour, so the
    // phase is `startMinute % 60`; the window's minute precision is honored
    // by filtering whole enumerations below.
    const minutesInHour: number[] = []
    for (let minute = draft.startMinute % 60; minute < 60; minute += draft.intervalMinutes) {
      minutesInHour.push(minute)
    }
    if (draft.allDay) {
      for (let hour = 0; hour < 24; hour++) {
        for (const minute of minutesInHour) fires.push(hour * 60 + minute)
      }
    } else {
      const startHour = Math.floor(draft.startMinute / 60)
      const endHour = Math.floor(draft.endMinute / 60)
      for (let hour = startHour; hour <= endHour; hour++) {
        for (const minute of minutesInHour) {
          const fire = hour * 60 + minute
          if (fire >= draft.startMinute && fire <= draft.endMinute) fires.push(fire)
        }
      }
    }
    return fires
  }
  // Hour-unit: fire times advance by whole intervals from the anchor; the
  // anchor's minutes are the phase, its hour only matters within a window.
  const step = draft.intervalMinutes
  const anchor = draft.allDay ? draft.startMinute % 60 : draft.startMinute
  const end = draft.allDay ? 24 * 60 - 1 : draft.endMinute
  for (let fire = anchor; fire <= end; fire += step) fires.push(fire)
  return fires
}

/** Unique sorted values of one field derived from fire times. */
function fieldValues(fires: readonly number[], minutes: boolean): number[] {
  const set = new Set<number>()
  for (const fire of fires) set.add(minutes ? fire % 60 : Math.floor(fire / 60))
  return [...set].sort((a, b) => a - b)
}

/** Format a minute field: `*`, `star/N`, or an explicit list. */
function formatMinutes(values: readonly number[], phase: number, step: number): string {
  if (values.length === 1) return String(values[0]!)
  if (phase === 0 && 60 % step === 0) return step === 1 ? '*' : `*/${step}`
  return values.join(',')
}

/** Format an hour field: `*`, `star/N`, a contiguous range, or a list. */
function formatHours(values: readonly number[], step: number): string {
  if (values.length === 1) return String(values[0]!)
  if (values.length === 24) return '*'
  if (step === 1) return `${values[0]!}-${values[values.length - 1]!}`
  if (24 % step === 0 && values.length === 24 / step) return `*/${step}`
  return values.join(',')
}

/**
 * Render a draft as a 5-field cron expression.
 * @param draft - the schedule to render.
 * @returns the canonical cron text.
 */
export function scheduleToCron(draft: ScheduleDraft): string {
  const fires = enumerateFires(draft)
  const minutes = fieldValues(fires, true)
  const hours = fieldValues(fires, false)
  const hourUnit = draft.intervalMinutes >= 60
  const minuteStep = hourUnit ? 1 : draft.intervalMinutes
  const hourStep = hourUnit ? draft.intervalMinutes / 60 : 1

  const dayField = draft.dayMode === 'daily'
    ? '*'
    : draft.dayMode === 'weekdays'
      ? '1-5'
      : draft.dayMode === 'weekends'
        ? '0,6'
        : [...draft.weekdays].sort((a, b) => a - b).join(',')

  return [
    formatMinutes(minutes, draft.startMinute % 60, minuteStep),
    formatHours(hours, hourStep),
    '*',
    '*',
    dayField,
  ].join(' ')
}

/** The constant step of an arithmetic progression, or undefined. */
function progressionStep(values: readonly number[]): number | undefined {
  if (values.length < 2) return undefined
  const step = values[1]! - values[0]!
  if (step < 1) return undefined
  for (let index = 2; index < values.length; index++) {
    if (values[index]! - values[index - 1]! !== step) return undefined
  }
  return step
}

/** Whether values are exactly `phase + k*step` for k = 0..length-1. */
function isProgression(values: readonly number[], phase: number, step: number): boolean {
  for (let index = 0; index < values.length; index++) {
    if (values[index] !== phase + index * step) return false
  }
  return true
}

/** True when values cover 0..23 (a wildcard hour field). */
function isFullDay(hours: readonly number[]): boolean {
  return hours.length === 24 && hours[0] === 0 && hours[hours.length - 1] === 23
}

/** Derive the day selection from the day-of-week field. */
function dayModeOf(dow: CronExpression['dayOfWeek']): Pick<ScheduleDraft, 'dayMode' | 'weekdays'> {
  const values = dow.values
  if (dow.wildcard) return { dayMode: 'daily', weekdays: [] }
  if (values.length === 5 && values[0] === 1 && values[4] === 5) {
    return { dayMode: 'weekdays', weekdays: [] }
  }
  if (values.length === 2 && values[0] === 0 && values[1] === 6) {
    return { dayMode: 'weekends', weekdays: [] }
  }
  return { dayMode: 'weekly', weekdays: values.map(day => day % 7) }
}

/**
 * Parse a cron expression back into a draft, when it is expressible in the
 * interval + window model.
 * @param expression - 5-field cron text (6-field, restricted day-of-month,
 *   month, or non-divisor minute steps are not expressible).
 * @returns the draft, or undefined when the expression falls outside the model.
 */
export function cronToSchedule(expression: string): ScheduleDraft | undefined {
  let parsed: CronExpression
  try {
    parsed = parseCron(expression)
  } catch {
    return undefined
  }
  if (parsed.seconds || !parsed.month.wildcard || !parsed.dayOfMonth.wildcard) {
    return undefined
  }
  const { dayMode, weekdays } = dayModeOf(parsed.dayOfWeek)
  const minutes = parsed.minute.values
  const hours = parsed.hour.values
  const fullDay = isFullDay(hours)

  // Minute-unit: a truncated arithmetic minute list with a divisor step,
  // combined with either all hours or one contiguous hour range.
  const minuteStep = progressionStep(minutes)
  if (minuteStep !== undefined && 60 % minuteStep === 0) {
    const phase = minutes[0]!
    const truncated = minutes[minutes.length - 1]! + minuteStep >= 60
    if ((minuteStep === 1 && minutes.length === 60 || truncated) && isProgression(minutes, phase, minuteStep)) {
      if (fullDay) {
        return { dayMode, weekdays, intervalMinutes: minuteStep, allDay: true, startMinute: phase, endMinute: 0 }
      }
      const hourStep = progressionStep(hours)
      if (hourStep === 1) {
        const startHour = hours[0]!
        const endHour = hours[hours.length - 1]!
        const fires: number[] = []
        for (let hour = startHour; hour <= endHour; hour++) {
          for (let minute = phase; minute < 60; minute += minuteStep) fires.push(hour * 60 + minute)
        }
        const last = fires[fires.length - 1]
        if (last !== undefined) {
          return {
            dayMode, weekdays, intervalMinutes: minuteStep, allDay: false,
            startMinute: startHour * 60 + phase, endMinute: last,
          }
        }
      }
      return undefined
    }
  }

  // Hour-unit: a single minute value on an arithmetic hour progression
  // (a single hour value = one fixed time per day).
  if (minutes.length === 1) {
    const minute = minutes[0]!
    if (fullDay) {
      return { dayMode, weekdays, intervalMinutes: 60, allDay: true, startMinute: minute, endMinute: 0 }
    }
    const startHour = hours[0]!
    let intervalMinutes = 1440
    let ok = true
    if (hours.length > 1) {
      const hourStep = progressionStep(hours)
      ok = hourStep !== undefined && isProgression(hours, startHour, hourStep)
      if (ok) intervalMinutes = hourStep! * 60
    }
    if (ok) {
      const startMinute = startHour * 60 + minute
      const endMinute = hours.length === 1
        ? startMinute
        : hours[hours.length - 1]! * 60 + minute
      return { dayMode, weekdays, intervalMinutes, allDay: false, startMinute, endMinute }
    }
  }
  return undefined
}

/** English description of a draft (logs, tool results). */
export function describeDraftEnglish(draft: ScheduleDraft): string {
  const days = draft.dayMode === 'daily'
    ? 'daily'
    : draft.dayMode === 'weekdays'
      ? 'on weekdays'
      : draft.dayMode === 'weekends'
        ? 'on weekends'
        : `on ${draft.weekdays.map(day => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day % 7]!).join(', ')}`
  const start = formatMinutesOfDay(draft.startMinute)
  if (draft.intervalMinutes >= 1440 && draft.startMinute === draft.endMinute) {
    return `at ${start} ${days}`
  }
  const freq = draft.intervalMinutes % 60 === 0
    ? `every ${draft.intervalMinutes / 60} hour${draft.intervalMinutes / 60 === 1 ? '' : 's'}`
    : `every ${draft.intervalMinutes} minutes`
  if (draft.allDay) {
    return draft.startMinute % 60 === 0
      ? `${freq} ${days}`
      : `${freq} (from minute ${draft.startMinute % 60}) ${days}`
  }
  return `${freq} between ${start} and ${formatMinutesOfDay(draft.endMinute)} ${days}`
}
