/**
 * Host-plane polling scheduler: one bounded-timer owner that wakes on the
 * earliest enabled task's next fire, resumes the task's agent when needed,
 * and delivers the task instruction as a follow-up turn in the task's own
 * session. Survives restarts via the durable store (missed targets are
 * caught up once, on the next wake).
 * @module dsh-polling/scheduler
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { PollingTask, PollingRunOutcome } from './domain.ts'
import { nextRunFor, PollingTaskId } from './domain.ts'
import { createTaskSessionAgent } from './session-factory.ts'
import type { TaskService } from './task-service.ts'
import { pinSessionTitle } from './title.ts'
import { ensurePollingWorkspace } from './workspace.ts'

/** Largest delay Node timers represent without clamping. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** The current wall clock in RFC 3339 UTC. */
function nowIso(): string {
  return new Date().toISOString()
}

/** Default agent options from the deployment's model selection, when present. */
function defaultAgentOptions(ctx: Context): { provider?: string; model?: string } {
  const defaults = ctx.get('agentDefaultModel')
  if (defaults === undefined) return {}
  const selection = defaults.currentSelection()
  return { provider: selection.provider, model: selection.model }
}

/** Task model overrides merged over the deployment defaults. */
export function taskAgentOptions(
  task: Pick<PollingTask, 'provider' | 'model'>,
  base: { provider?: string; model?: string },
): { provider?: string; model?: string } {
  return {
    ...base,
    ...task.provider === undefined ? {} : { provider: task.provider },
    ...task.model === undefined ? {} : { model: task.model },
  }
}

/** Compose the task's recorded preset (or the default) onto a resumed agent. */
function mountPreset(
  ctx: Context,
  sessionId: SessionId,
): (agentCtx: Context) => Promise<void> {
  return async (agentCtx: Context): Promise<void> => {
    const presets = ctx.get('agentPresets')
    if (presets === undefined) return
    let presetId: string | undefined
    const persistence = ctx.get('sessionPersistence')
    if (persistence !== undefined) {
      try {
        const inspected = await persistence.inspect(sessionId)
        presetId = resolveSessionPreset({
          header: inspected.meta,
          events: inspected.events,
        })
      } catch {
        // Fall through: mount the default preset instead of failing the run.
      }
    }
    await presets.mount(agentCtx, presetId)
  }
}

/** The process-local polling scheduler. */
export class PollingScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined
  private stop = Promise.withResolvers<void>()
  private run: Promise<void> | undefined
  private requested = false
  private stopping = false
  private faulted = false
  private disposal: Promise<void> | undefined

  /**
   * @param ctx - host service context.
   * @param tasks - the shared task registry.
   * @param pollingDir - absolute polling directory (the task sessions' cwd).
   */
  constructor(
    private readonly ctx: Context,
    private readonly tasks: TaskService,
    private readonly pollingDir: string,
  ) {}

  /**
   * Register the per-task model override: every model request made by a task
   * session's agent uses the task's provider/model when set. Live agents
   * (the user steering the task session) are covered too, because the
   * override applies at request time, not only at resume time.
   * @returns the event-listener disposer.
   */
  registerRequestOverride(): () => void {
    return this.ctx.on('agent/request', async (payload, next) => {
      const task = this.tasks.bySession(payload.agent.id)
      if (task === undefined || (task.provider === undefined && task.model === undefined)) {
        return next()
      }
      const config = await next()
      return {
        ...config,
        ...task.provider === undefined ? {} : { provider: task.provider },
        ...task.model === undefined ? {} : { model: task.model },
      }
    })
  }

  /** Begin the first drive (idempotent). */
  start(): void {
    this.requestDrive()
  }

  /** Recompute the timer after any task mutation or wake. */
  requestDrive(): void {
    if (this.stopping || this.faulted) return
    this.clearTimer()
    this.requested = true
    if (this.run !== undefined) return
    let run: Promise<void>
    try {
      run = this.ctx.agents.withoutInitiator(() => this.runRequested())
    } catch (error: unknown) {
      this.ctx.logger.warn(`polling: could not start scheduler: ${String(error)}`)
      return
    }
    this.run = run
    void run.then(
      () => this.retire(run),
      (error: unknown) => {
        this.ctx.logger.warn(`polling: scheduler drive failed: ${String(error)}`)
        this.faulted = true
        this.retire(run)
      },
    )
  }

  /** Stop future work and cancel timers. */
  dispose(): Promise<void> {
    return (this.disposal ??= (async () => {
      this.stopping = true
      this.requested = false
      this.clearTimer()
      this.stop.resolve()
      if (this.run !== undefined) await Promise.allSettled([this.run])
    })())
  }

  /** Drain coalesced triggers serially. */
  private async runRequested(): Promise<void> {
    while (this.requested && !this.stopping && !this.faulted) {
      this.requested = false
      await this.driveOnce()
    }
  }

  /** Retire one exact run and honor a trigger that landed during its tail. */
  private retire(run: Promise<void>): void {
    if (this.run !== run) return
    this.run = undefined
    if (this.requested && !this.stopping && !this.faulted) this.requestDrive()
  }

  private clearTimer(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Arm one bounded timer segment; every wake rechecks the wall clock. */
  private arm(target: number, now: number): void {
    const delay = Math.min(target - now, MAX_TIMER_DELAY_MS)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.requestDrive()
    }, delay)
  }

  /** Scan due tasks, fire each, then arm the earliest next target. */
  private async driveOnce(): Promise<void> {
    this.clearTimer()
    if (this.stopping || this.faulted) return
    const now = Date.now()

    // Due = the next fire strictly after the last recorded run instant
    // (creation when never run) has already passed. Anchoring on the last
    // run — not on "now" — is what makes automatic firing work at all
    // (nextCronMatch is strictly-after) and gives the documented catch-up
    // semantics: after downtime, the earliest missed fire runs once, then
    // the schedule resyncs to the future.
    for (const task of this.tasks.list()) {
      if (!task.enabled) continue
      const anchor = parseRunTime(task.lastRunAt ?? task.createdAt) ?? now
      const next = parseRunTime(nextRunFor(task, anchor))
      if (next !== undefined && next <= now) {
        await this.trigger(task.id)
      }
    }

    // Re-arm on the earliest enabled next target after firing (mutations may
    // have advanced the schedule).
    const latestNow = Date.now()
    let earliest: number | undefined
    for (const task of this.tasks.list()) {
      if (!task.enabled) continue
      const next = parseRunTime(nextRunFor(task, latestNow))
      if (next !== undefined && (earliest === undefined || next < earliest)) earliest = next
    }
    if (earliest !== undefined) this.arm(earliest, Date.now())
  }

  /**
   * Manually trigger one task now (used by polling_trigger and the web UI).
   * Fires the task immediately and records the run outcome. When the task's
   * agent is still running from a previous fire, the tick is skipped and
   * recorded as `skipped` — the "do not start a new instance" concurrency
   * policy of mature schedulers (Windows Task Scheduler, Kubernetes
   * CronJob's `Forbid`), which keeps long runs from stacking follow-ups.
   * @param taskId - the task to fire.
   * @returns the recorded outcome, or undefined when the task is unknown.
   */
  async trigger(taskId: string): Promise<PollingRunOutcome | undefined> {
    const task = this.tasks.get(PollingTaskId(taskId))
    if (task === undefined) return undefined
    let outcome: PollingRunOutcome
    try {
      const archived = this.isArchived(SessionId(task.sessionId))
      const live = archived ? undefined : this.ctx.agents.get(SessionId(task.sessionId))
      if (live !== undefined && live.status === 'running') {
        this.ctx.logger.info(
          `polling: task "${task.id}" tick skipped: a run is still in progress`,
        )
        outcome = 'skipped'
      } else {
        const agent = await this.ensureAgent(task)
        if (agent === undefined) {
          this.ctx.logger.warn(
            `polling: task "${task.id}" session "${task.sessionId}" could not be resumed`,
          )
          outcome = 'failed'
        } else {
          const message = createUserMessage({
            content: [{ type: 'text', text: renderRunPrompt(task, nowIso()) }],
            source: { kind: 'plugin', plugin: 'polling' },
          })
          agent.followup(message)
          outcome = 'ok'
        }
      }
    } catch (error: unknown) {
      this.ctx.logger.warn(`polling: task "${task.id}" fire failed: ${String(error)}`)
      outcome = 'failed'
    }
    try {
      await this.tasks.mutate(task.id, current => ({
        ...current,
        lastRunAt: nowIso(),
        lastRunOutcome: outcome,
      }))
    } catch (error: unknown) {
      this.ctx.logger.warn(`polling: task "${task.id}" run record failed: ${String(error)}`)
    }
    return outcome
  }

  /** Whether the task's session is in the workspace archive set. */
  private isArchived(sessionId: SessionId): boolean {
    const registry = this.ctx.get('workspaceRegistry')
    return registry !== undefined && registry.archivedSessionIds.includes(sessionId)
  }

  /**
   * Reuse the live agent, resume the task session's agent from storage, or —
   * when the task's session was archived (hidden from every surface) — create
   * a fresh session for the task. There is no unarchive API, so an archived
   * conversation cannot come back; the mature behavior is a new conversation
   * (the old one stays archived as history), matching what the user expects
   * from "run now" on an archived task.
   */
  private async ensureAgent(task: PollingTask): Promise<Agent | undefined> {
    const sessionId = SessionId(task.sessionId)
    if (this.isArchived(sessionId)) {
      return this.recreateSession(task)
    }
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) return live
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return undefined
    const headers = await persistence.list()
    const exists = headers.some(header => header.id === sessionId)
    if (!exists) return undefined
    const handle = await this.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: taskAgentOptions(task, defaultAgentOptions(this.ctx)),
      setup: mountPreset(this.ctx, sessionId),
    })
    // Re-pin the task name as the session title: sessions created before the
    // pinning fix (or renamed while idle) get their authoritative title now.
    pinSessionTitle(this.ctx, handle.agent.session, task.name)
    // Keep the agent live after the run: the user may open the task session
    // to steer it, and the web surface reuses the same live agent.
    return handle.agent
  }

  /**
   * Create a fresh session for the task (the archived one stays archived),
   * attach it to the polling workspace, and repoint the task's durable
   * sessionId. Returns undefined on failure so the caller records a failed
   * run instead of crashing the drive.
   */
  private async recreateSession(task: PollingTask): Promise<Agent | undefined> {
    try {
      const freshId = randomUUID() as SessionId
      const agent = await createTaskSessionAgent(
        this.ctx,
        freshId,
        this.pollingDir,
        taskAgentOptions(task, defaultAgentOptions(this.ctx)),
      )
      pinSessionTitle(this.ctx, agent.session, task.name)
      const { workspace } = await ensurePollingWorkspace(this.ctx, this.pollingDir)
      await workspace.attachSession(freshId)
      await this.tasks.mutate(task.id, current => ({ ...current, sessionId: freshId }))
      this.ctx.logger.info(
        `polling: task "${task.id}" got a fresh session "${freshId}" (the previous one was archived)`,
      )
      return agent
    } catch (error: unknown) {
      this.ctx.logger.warn(`polling: task "${task.id}" session recreation failed: ${String(error)}`)
      return undefined
    }
  }
}

/** Parse an RFC 3339 instant, returning undefined on garbage. */
function parseRunTime(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined
  const value = Date.parse(iso)
  return Number.isNaN(value) ? undefined : value
}

/** Render the run instruction delivered to the task agent. */
export function renderRunPrompt(task: PollingTask, nowIsoString: string): string {
  const zone = task.timeZone ?? 'server-local'
  const lines = [
    `[轮询任务 ${task.name}]`,
    `当前时间(UTC): ${nowIsoString}`,
    `任务时区: ${zone}`,
    `任务目标: ${task.description}`,
    '',
    '请执行以下任务步骤，完成后简要汇报结果：',
    task.prompt,
  ]
  return lines.join('\n')
}
