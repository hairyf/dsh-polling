/**
 * Polling task domain model: durable records, validation, and stable error
 * codes. Pure logic — no I/O, no clocks, no service access.
 * @module dsh-polling/domain
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { CronSyntaxError, isValidTimeZone, nextCronMatch, parseCron } from './cron.ts'

/** Stable task identity, unique across the deployment. */
export type PollingTaskId = Branded<'PollingTaskId'>

/** Brand a raw string as a task id (compile-time only). */
export function PollingTaskId(id: string): PollingTaskId {
  return id as PollingTaskId
}

/** Coarse outcome of the most recent run, recorded at trigger time. */
export type PollingRunOutcome = 'ok' | 'failed' | 'aborted' | 'skipped'

/** Durable v1 polling task record. */
export interface PollingTask {
  /** Stable identity. */
  readonly id: PollingTaskId
  /** The session that owns this task's execution history. */
  readonly sessionId: SessionId
  /** Display name (also the session title). */
  readonly name: string
  /** 5- or 6-field cron expression. */
  readonly cron: string
  /** IANA zone the cron expression is interpreted in; absent = server local. */
  readonly timeZone?: string
  /** Background description of the goal (model context). */
  readonly description: string
  /** Natural-language step instructions delivered to the model on each run. */
  readonly prompt: string
  /** Provider route override for this task's runs (absent = deployment default). */
  readonly provider?: string
  /** Model id override for this task's runs (absent = deployment default). */
  readonly model?: string
  /** Whether the scheduler may fire this task. */
  readonly enabled: boolean
  /** RFC 3339 UTC creation instant. */
  readonly createdAt: string
  /** RFC 3339 UTC last modification instant. */
  readonly updatedAt: string
  /** RFC 3339 UTC of the most recent trigger, when one fired. */
  readonly lastRunAt?: string
  /** Outcome recorded at trigger time. */
  readonly lastRunOutcome?: PollingRunOutcome
}

/** Model/UI-facing view of a task (record + derived scheduling state). */
export interface PollingTaskView extends PollingTask {
  /** RFC 3339 UTC of the next scheduled fire, when computable. */
  readonly nextRunAt?: string
}

/** The on-disk store shape (v1). */
export interface PollingTaskStore {
  readonly version: 1
  readonly tasks: readonly PollingTask[]
}

/* ── stable error codes ──────────────────────────────────────────────────── */

export interface InvalidNameError {
  readonly code: 'invalid_name'
  readonly message: string
}

export interface InvalidCronError {
  readonly code: 'invalid_cron'
  readonly message: string
}

export interface InvalidTimeZoneError {
  readonly code: 'invalid_time_zone'
  readonly message: string
}

export interface EmptyPromptError {
  readonly code: 'empty_prompt'
  readonly message: string
}

export interface TaskNotFoundError {
  readonly code: 'task_not_found'
  readonly message: string
}

export interface InternalTaskError {
  readonly code: 'internal_error'
  readonly message: string
}

export interface PersistenceUncertainError {
  readonly code: 'persistence_uncertain'
  readonly message: string
  readonly operation: 'create' | 'update' | 'delete' | 'list'
}

/** Closed v1 polling domain error union. */
export type PollingTaskError =
  | InvalidNameError
  | InvalidCronError
  | InvalidTimeZoneError
  | EmptyPromptError
  | TaskNotFoundError
  | InternalTaskError
  | PersistenceUncertainError

/** Input shape accepted when creating a task. */
export interface PollingTaskInput {
  readonly name: string
  readonly cron: string
  readonly description?: string
  readonly prompt: string
  readonly timeZone?: string
  readonly provider?: string
  readonly model?: string
  readonly enabled?: boolean
}

/** Validated, canonicalized creation input. */
export interface ValidatedPollingTaskInput {
  readonly name: string
  readonly cron: string
  readonly description: string
  readonly prompt: string
  readonly timeZone?: string
  readonly provider?: string
  readonly model?: string
  readonly enabled: boolean
}

/** Fields accepted when editing an existing task. */
export interface PollingTaskPatch {
  readonly name?: string
  readonly cron?: string
  readonly description?: string
  readonly prompt?: string
  readonly timeZone?: string
  readonly provider?: string
  readonly model?: string
  readonly enabled?: boolean
}

/** A validated patch: same shape as the input, only supplied keys present. */
export type ValidatedPollingTaskPatch = {
  [K in keyof PollingTaskPatch]?: NonNullable<PollingTaskPatch[K]>
}

/** Mutable construction shape for {@link ValidatedPollingTaskPatch}. */
type MutablePatch = {
  -readonly [K in keyof PollingTaskPatch]?: NonNullable<PollingTaskPatch[K]>
}

/**
 * Validate creation input and canonicalize it.
 * @returns the validated input, or a stable domain error.
 */
export function validateTaskInput(input: PollingTaskInput): ValidatedPollingTaskInput | PollingTaskError {
  const name = input.name.trim()
  if (name.length === 0) {
    return { code: 'invalid_name', message: 'name must be non-empty after trimming.' }
  }
  if (name.length > 200) {
    return { code: 'invalid_name', message: 'name must be at most 200 characters.' }
  }
  const prompt = input.prompt.trim()
  if (prompt.length === 0) {
    return { code: 'empty_prompt', message: 'prompt must be non-empty after trimming.' }
  }
  if (input.timeZone !== undefined && !isValidTimeZone(input.timeZone)) {
    return {
      code: 'invalid_time_zone',
      message: `unknown IANA time zone "${input.timeZone}".`,
    }
  }
  try {
    parseCron(input.cron)
  } catch (error) {
    return {
      code: 'invalid_cron',
      message: error instanceof CronSyntaxError ? error.message : 'cron expression is invalid.',
    }
  }
  return {
    name,
    cron: input.cron.trim(),
    description: (input.description ?? '').trim(),
    prompt,
    ...input.timeZone === undefined ? {} : { timeZone: input.timeZone },
    ...input.provider === undefined ? {} : { provider: input.provider.trim() },
    ...input.model === undefined ? {} : { model: input.model.trim() },
    enabled: input.enabled ?? true,
  }
}

/** Canonicalize a patch: validate only supplied keys, return a clean object. */
export function validateTaskPatch(patch: PollingTaskPatch): ValidatedPollingTaskPatch | PollingTaskError {
  const keys = Object.keys(patch) as (keyof PollingTaskPatch)[]
  if (keys.length === 0) {
    return { code: 'invalid_name', message: 'no fields to update.' }
  }
  const out: MutablePatch = {}
  for (const key of keys) {
    switch (key) {
      case 'name': {
        const name = patch.name?.trim() ?? ''
        if (name.length === 0) {
          return { code: 'invalid_name', message: 'name must be non-empty after trimming.' }
        }
        if (name.length > 200) {
          return { code: 'invalid_name', message: 'name must be at most 200 characters.' }
        }
        out.name = name
        break
      }
      case 'prompt': {
        const prompt = patch.prompt?.trim() ?? ''
        if (prompt.length === 0) {
          return { code: 'empty_prompt', message: 'prompt must be non-empty after trimming.' }
        }
        out.prompt = prompt
        break
      }
      case 'cron': {
        const cron = patch.cron?.trim() ?? ''
        try {
          parseCron(cron)
        } catch (error) {
          return {
            code: 'invalid_cron',
            message: error instanceof CronSyntaxError ? error.message : 'cron expression is invalid.',
          }
        }
        out.cron = cron
        break
      }
      case 'timeZone': {
        const timeZone = patch.timeZone
        if (timeZone !== undefined && !isValidTimeZone(timeZone)) {
          return {
            code: 'invalid_time_zone',
            message: `unknown IANA time zone "${timeZone}".`,
          }
        }
        if (timeZone !== undefined) out.timeZone = timeZone
        break
      }
      case 'description':
        out.description = (patch.description ?? '').trim()
        break
      case 'provider':
        if (patch.provider !== undefined) out.provider = patch.provider.trim()
        break
      case 'model':
        if (patch.model !== undefined) out.model = patch.model.trim()
        break
      case 'enabled':
        if (patch.enabled !== undefined) out.enabled = patch.enabled
        break
    }
  }
  return out
}

/** Compute the next fire instant for one task from its durable fields. */
export function nextRunFor(
  task: Pick<PollingTask, 'cron' | 'timeZone'>,
  from = Date.now(),
): string | undefined {
  try {
    const expression = parseCron(task.cron)
    const next = nextCronMatch(expression, from, task.timeZone)
    return next === undefined ? undefined : new Date(next).toISOString()
  } catch {
    return undefined
  }
}

/** Build the model/UI view of a task. */
export function taskView(task: PollingTask, now = Date.now()): PollingTaskView {
  const next = task.enabled ? nextRunFor(task, now) : undefined
  return {
    ...task,
    ...next === undefined ? {} : { nextRunAt: next },
  }
}

/** Create a task record from validated input (pure; no I/O). */
export function createTaskRecord(
  id: PollingTaskId,
  sessionId: SessionId,
  input: ValidatedPollingTaskInput,
  nowIso: string,
): PollingTask {
  return {
    id,
    sessionId,
    name: input.name,
    cron: input.cron,
    description: input.description,
    prompt: input.prompt,
    enabled: input.enabled,
    createdAt: nowIso,
    updatedAt: nowIso,
    ...input.timeZone === undefined ? {} : { timeZone: input.timeZone },
    ...input.provider === undefined ? {} : { provider: input.provider },
    ...input.model === undefined ? {} : { model: input.model },
  }
}

/** Apply a validated patch to a record (pure). */
export function applyTaskPatch(
  task: PollingTask,
  patch: ValidatedPollingTaskPatch,
  nowIso: string,
): PollingTask {
  return {
    ...task,
    ...(patch.name === undefined ? {} : { name: patch.name }),
    ...(patch.cron === undefined ? {} : { cron: patch.cron }),
    ...(patch.description === undefined ? {} : { description: patch.description }),
    ...(patch.prompt === undefined ? {} : { prompt: patch.prompt }),
    ...(patch.timeZone === undefined ? {} : { timeZone: patch.timeZone }),
    ...(patch.provider === undefined ? {} : { provider: patch.provider }),
    ...(patch.model === undefined ? {} : { model: patch.model }),
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    updatedAt: nowIso,
  }
}
