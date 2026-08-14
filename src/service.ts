/**
 * Polling business service: the shared operations behind the model tools and
 * the web RPC routes — create/list/update/delete/trigger, plus the polling
 * workspace and per-task session lifecycle.
 * @module dsh-polling/service
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PollingTaskView } from './domain.ts'
import {
  createTaskRecord,
  PollingTaskId,
  type PollingRunOutcome,
  type PollingTask,
  type PollingTaskError,
  type PollingTaskInput,
  type PollingTaskPatch,
  type TaskNotFoundError,
  validateTaskInput,
  validateTaskPatch,
} from './domain.ts'
import type { PollingScheduler } from './scheduler.ts'
import { createTaskSessionAgent } from './session-factory.ts'
import type { TaskService } from './task-service.ts'
import { pinSessionTitle } from './title.ts'
import { ensurePollingWorkspace, pinPollingWorkspace } from './workspace.ts'

/** Stable error for a task that is not registered. */
function notFound(id: string): TaskNotFoundError {
  return { code: 'task_not_found', message: `no polling task with id "${id}".` }
}

/** The polling business service. */
export class PollingService {
  /**
   * @param ctx - host context (needs `agents`, `workspaceRegistry`, and
   *   optionally `agentPresets` / `sessionPersistence` / `agentDefaultModel`).
   * @param tasks - the shared task registry.
   * @param scheduler - the shared scheduler (rearmed on every mutation).
   * @param pollingDir - absolute polling directory.
   * @param keepPinned - whether to force the workspace back to the top after
   *   external reordering (optional; default false).
   */
  constructor(
    private readonly ctx: Context,
    private readonly tasks: TaskService,
    private readonly scheduler: PollingScheduler,
    private readonly pollingDir: string,
    private readonly keepPinned: boolean,
  ) {}

  /** Absolute polling directory. */
  get dir(): string {
    return this.pollingDir
  }

  /** Model/UI views of all tasks. */
  list(now = Date.now()): PollingTaskView[] {
    return this.tasks.views(now)
  }

  /** One task view by id. */
  get(id: string): PollingTaskView | undefined {
    const task = this.tasks.get(PollingTaskId(id))
    if (task === undefined) return undefined
    return this.tasks.views().find(view => view.id === task.id)
  }

  /**
   * Create a task: validate input, ensure the polling workspace, create the
   * task session (with the deployment default agent preset), attach it to
   * the workspace, persist the task, and rearm the scheduler.
   * @returns the created task view, or a stable domain error.
   */
  async create(input: PollingTaskInput): Promise<PollingTaskView | PollingTaskError> {
    const validated = validateTaskInput(input)
    if ('code' in validated) return validated

    const id = PollingTaskId(randomUUID())
    const sessionId = randomUUID() as SessionId
    let task: PollingTask
    try {
      const { workspace } = await ensurePollingWorkspace(this.ctx, this.pollingDir)
      task = await this.createTaskSession(id, sessionId, validated)
      await workspace.attachSession(sessionId)
      if (this.keepPinned) await pinPollingWorkspace(this.ctx, workspace.id)
      await this.tasks.create(task)
    } catch (error: unknown) {
      this.ctx.logger.warn(`polling: task creation failed: ${String(error)}`)
      return { code: 'internal_error', message: 'The polling task could not be created.' }
    }
    this.scheduler.requestDrive()
    return this.tasks.views().find(view => view.id === id)!
  }

  /**
   * Update one task's fields. A name change re-pins the live session title
   * (a persisted-but-idle session gets its title refreshed at the next
   * scheduler resume).
   * @returns the updated task view, or a stable domain error.
   */
  async update(id: string, patch: PollingTaskPatch): Promise<PollingTaskView | PollingTaskError> {
    const validated = validateTaskPatch(patch)
    if ('code' in validated) return validated
    const before = this.tasks.get(PollingTaskId(id))
    const result = await this.tasks.update(PollingTaskId(id), validated)
    if ('code' in result) return result
    if (validated.name !== undefined && before !== undefined && validated.name !== before.name) {
      const live = this.ctx.agents.get(before.sessionId)
      if (live !== undefined) pinSessionTitle(this.ctx, live.session, validated.name)
    }
    this.scheduler.requestDrive()
    return this.tasks.views().find(view => view.id === result.id)!
  }

  /**
   * Remove one task registration (its session and history are retained).
   * @returns true when removed, false when unknown.
   */
  async delete(id: string): Promise<boolean | PollingTaskError> {
    const task = this.tasks.get(PollingTaskId(id))
    if (task === undefined) return notFound(id)
    const removed = await this.tasks.delete(PollingTaskId(id))
    if (removed) this.scheduler.requestDrive()
    return removed
  }

  /**
   * Fire one task immediately.
   * @returns the recorded outcome, or a stable domain error when unknown.
   */
  async trigger(id: string): Promise<PollingRunOutcome | PollingTaskError> {
    const task = this.tasks.get(PollingTaskId(id))
    if (task === undefined) return notFound(id)
    const outcome = await this.scheduler.trigger(task.id)
    return outcome ?? notFound(id)
  }

  /** Create the per-task session and agent, returning the durable task. */
  private async createTaskSession(
    id: ReturnType<typeof PollingTaskId>,
    sessionId: SessionId,
    input: Parameters<typeof createTaskRecord>[2],
  ): Promise<PollingTask> {
    const agent = await createTaskSessionAgent(this.ctx, sessionId, this.pollingDir, {
      ...input.provider === undefined ? {} : { provider: input.provider },
      ...input.model === undefined ? {} : { model: input.model },
    })
    // Keep the agent live: the user may open the task session to steer it.
    // The task name is the session's authoritative title: pin it now so
    // automatic title generation (scheduled after the first delivered run
    // instruction) never overrides it.
    pinSessionTitle(this.ctx, agent.session, input.name)
    return createTaskRecord(id, sessionId, input, new Date().toISOString())
  }
}
