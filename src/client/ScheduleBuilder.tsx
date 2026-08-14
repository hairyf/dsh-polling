/**
 * Schedule builder: interval + time-window + days controls that produce a
 * 5-field cron string. Users only see friendly controls — the raw expression
 * never appears (it lives in the task record).
 *
 * Modeled after mature schedulers (Windows Task Scheduler's repeat-every-N
 * within a window, n8n's interval mode): a frequency (every N minutes/hours),
 * an optional time window (HH:MM–HH:MM or all day), and a day selection.
 * @module dsh-polling/client
 */

import { useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import {
  cronToSchedule,
  defaultScheduleDraft,
  formatMinutesOfDay,
  scheduleToCron,
  type ScheduleDayMode,
  type ScheduleDraft,
} from '../schedule.ts'
import { defaultTimeZone, nextCronMatch, parseCron } from '../cron.ts'
import css from './ScheduleBuilder.module.css'

/** Day-mode chips in UI order. */
const DAY_MODES: readonly ScheduleDayMode[] = ['daily', 'weekdays', 'weekends', 'weekly']

/** Weekday chips (0 = Sunday, matching cron). */
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const

/** Short weekday labels for the chips and weekly summaries. */
const WEEKDAY_SHORT = ['日', '一', '二', '三', '四', '五', '六']

/** Minute-unit intervals offered (divisors of 60 keep the model exact). */
const MINUTE_OPTIONS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30] as const

/** Hour-unit intervals offered. */
const HOUR_OPTIONS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 24] as const

/** Parse `HH:MM` into minutes of day; undefined when malformed. */
function parseTimeInput(raw: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim())
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined
  return hour * 60 + minute
}

/** Locale keys used by the schedule builder. */
type ScheduleLocaleKey =
  | 'schedule.unitMinute'
  | 'schedule.unitHour'
  | 'schedule.allDay'
  | 'schedule.start'
  | 'schedule.end'
  | 'schedule.everyMinute'
  | 'schedule.everyHour'
  | 'schedule.days.daily'
  | 'schedule.days.weekdays'
  | 'schedule.days.weekends'
  | 'schedule.days.weekly'
  | 'schedule.days.weeklyList'
  | 'schedule.summary.range'
  | 'schedule.summary.allDay'
  | 'schedule.summary.fixed'
  | 'schedule.from'
  | 'schedule.nextRun'
  | 'schedule.invalidRange'
  | 'schedule.customHint'

/** Build the 5-field cron string for a draft. */
function buildCron(state: ScheduleDraft): string {
  return scheduleToCron(state)
}

/**
 * Localized summary of a draft (used in the list rows and the editor).
 * @param draft - the schedule.
 * @param t - the polling namespace translator.
 * @returns the human-readable summary, e.g. `工作日 09:00–18:00 · 每 30 分钟`.
 */
export function summarizeSchedule(draft: ScheduleDraft, t: TranslateNS<typeof NS>): string {
  const days = draft.dayMode === 'daily'
    ? t('schedule.days.daily')
    : draft.dayMode === 'weekdays'
      ? t('schedule.days.weekdays')
      : draft.dayMode === 'weekends'
        ? t('schedule.days.weekends')
        : t('schedule.days.weeklyList', { days: draft.weekdays.map(day => WEEKDAY_SHORT[day % 7]!).join('、') })
  const fixedTime = draft.intervalMinutes >= 1440 && draft.startMinute === draft.endMinute
  if (fixedTime) {
    return t('schedule.summary.fixed', { days, time: formatMinutesOfDay(draft.startMinute) })
  }
  const freq = draft.intervalMinutes % 60 === 0
    ? t('schedule.everyHour', { n: String(draft.intervalMinutes / 60) })
    : t('schedule.everyMinute', { n: String(draft.intervalMinutes) })
  if (draft.allDay) {
    const base = t('schedule.summary.allDay', { days, freq })
    return draft.startMinute % 60 === 0
      ? base
      : `${base}${t('schedule.from', { time: formatMinutesOfDay(draft.startMinute % 60) })}`
  }
  return t('schedule.summary.range', {
    days,
    start: formatMinutesOfDay(draft.startMinute),
    end: formatMinutesOfDay(draft.endMinute),
    freq,
  })
}

/** Summary of a stored cron expression, or the custom fallback. */
export function summarizeCron(expression: string, t: TranslateNS<typeof NS>): string {
  const draft = cronToSchedule(expression)
  return draft === undefined ? t('schedule.custom') : summarizeSchedule(draft, t)
}

/** A draft cloned with one field replaced (exactOptionalPropertyTypes-safe). */
function withDraft(state: ScheduleDraft, patch: Partial<ScheduleDraft>): ScheduleDraft {
  return { ...state, ...patch }
}

/** Props for the schedule builder. */
export interface ScheduleBuilderProps {
  /** Current raw expression. */
  readonly value: string
  /** Emit a new raw expression whenever the controls change it. */
  readonly onChange: (expression: string) => void
  /** Locale translator bound to the polling namespace. */
  readonly t: TranslateNS<typeof NS>
}

/**
 * Interval + window + days schedule editor. Emits a raw 5-field expression
 * via `onChange`; the expression itself is never shown to the user.
 * @param props - the bound value and change callback.
 * @returns the builder controls.
 */
export function ScheduleBuilder({ value, onChange, t }: ScheduleBuilderProps) {
  const [state, setState] = useState<ScheduleDraft>(() => cronToSchedule(value) ?? defaultScheduleDraft())
  const [external, setExternal] = useState(value)
  const [customFallback, setCustomFallback] = useState(() => cronToSchedule(value) === undefined)

  // The bound value changed outside this control (task reload/edit switch):
  // re-derive the builder state, unless it was this control that emitted it.
  if (value !== external && value !== buildCron(state)) {
    setExternal(value)
    const draft = cronToSchedule(value)
    setCustomFallback(draft === undefined)
    setState(draft ?? defaultScheduleDraft())
  }

  const apply = (next: ScheduleDraft): void => {
    if (!next.allDay && next.endMinute <= next.startMinute) {
      // Keep the last valid expression until the window is fixed.
      setState(next)
      return
    }
    setState(next)
    const expression = buildCron(next)
    setExternal(expression)
    setCustomFallback(false)
    onChange(expression)
  }

  const toggleWeekday = (day: number): void => {
    const weekdays = state.weekdays.includes(day)
      ? state.weekdays.filter(value => value !== day)
      : [...state.weekdays, day]
    apply(withDraft(state, { weekdays: weekdays.length === 0 ? [1] : weekdays }))
  }

  const intervalKey = state.intervalMinutes % 60 === 0
    ? `h${state.intervalMinutes / 60}`
    : `m${state.intervalMinutes}`
  const selectInterval = (key: string): void => {
    const value = Number(key.slice(1))
    const minutes = key.startsWith('h') ? value * 60 : value
    apply(withDraft(state, { intervalMinutes: minutes }))
  }
  const setDayMode = (mode: ScheduleDayMode): void => {
    apply(withDraft(state, { dayMode: mode }))
  }
  const setAllDay = (allDay: boolean): void => {
    apply(withDraft(state, { allDay, ...(allDay ? { startMinute: 0 } : {}) }))
  }
  const setStart = (raw: string): void => {
    const minutes = parseTimeInput(raw)
    if (minutes !== undefined) apply(withDraft(state, { startMinute: minutes }))
  }
  const setEnd = (raw: string): void => {
    const minutes = parseTimeInput(raw)
    if (minutes !== undefined) apply(withDraft(state, { endMinute: minutes }))
  }

  const windowInvalid = !state.allDay && state.endMinute <= state.startMinute
  const emitted = buildCron(state)

  // Live next-fire preview (server-local zone; the raw expression stays
  // internal to the computation).
  let nextRun = ''
  if (!windowInvalid) {
    try {
      const parsed = parseCron(emitted)
      const next = nextCronMatch(parsed, Date.now(), defaultTimeZone())
      if (next !== undefined) nextRun = new Date(next).toLocaleString()
    } catch {
      // Preview is best-effort; never block editing on it.
    }
  }

  return (
    <div className={css.builder}>
      {customFallback
        ? <div className={css.hint}>{t('schedule.customHint')}</div>
        : null}

      {/* One merged schedule control, two natural lines: days (with the
          weekday circles for "custom"), then window · frequency. */}
      <div className={css.row}>
        <div className={css.chips}>
          {DAY_MODES.map(mode => (
            <button
              key={mode}
              type="button"
              aria-pressed={state.dayMode === mode}
              className={state.dayMode === mode ? `${css.chip} ${css.chipActive}` : css.chip}
              onClick={() => setDayMode(mode)}
            >
              {t(`schedule.days.${mode}` as ScheduleLocaleKey)}
            </button>
          ))}
        </div>
        {state.dayMode === 'weekly' && (
          <div className={css.weekdays}>
            {WEEKDAYS.map(day => (
              <button
                key={day}
                type="button"
                aria-pressed={state.weekdays.includes(day)}
                className={state.weekdays.includes(day) ? `${css.weekday} ${css.weekdayOn}` : css.weekday}
                onClick={() => toggleWeekday(day)}
              >
                {WEEKDAY_SHORT[day]}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className={css.row}>
        <label className={css.check}>
          <input
            type="checkbox"
            checked={state.allDay}
            onChange={event => setAllDay(event.target.checked)}
          />
          <span>{t('schedule.allDay')}</span>
        </label>
        {!state.allDay && (
          <span className={css.window}>
            <input
              type="time"
              className={css.select}
              value={formatMinutesOfDay(state.startMinute)}
              onChange={event => setStart(event.target.value)}
              aria-label={t('schedule.start')}
            />
            <span className={css.sep}>–</span>
            <input
              type="time"
              className={css.select}
              value={formatMinutesOfDay(state.endMinute)}
              onChange={event => setEnd(event.target.value)}
              aria-label={t('schedule.end')}
            />
          </span>
        )}

        <span className={css.sep}>·</span>

        <select
          className={css.select}
          value={intervalKey}
          onChange={event => selectInterval(event.target.value)}
        >
          <optgroup label={t('schedule.unitMinute')}>
            {MINUTE_OPTIONS.map(value => (
              <option key={`m${value}`} value={`m${value}`}>
                {t('schedule.everyMinute', { n: String(value) })}
              </option>
            ))}
          </optgroup>
          <optgroup label={t('schedule.unitHour')}>
            {HOUR_OPTIONS.map(value => (
              <option key={`h${value}`} value={`h${value}`}>
                {t('schedule.everyHour', { n: String(value) })}
              </option>
            ))}
          </optgroup>
        </select>
      </div>

      {windowInvalid
        ? <div className={css.error}>{t('schedule.invalidRange')}</div>
        : null}

      <div className={css.preview}>
        <span className={css.previewLabel}>{t('schedule.nextRun')}</span>
        <span className={css.previewValue}>{nextRun === '' ? '–' : nextRun}</span>
      </div>
    </div>
  )
}
