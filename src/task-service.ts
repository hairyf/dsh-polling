/**
 * In-memory task registry with serialized atomic persistence. All reads and
 * writes go through one instance shared by the scheduler, the model tools,
 * and the RPC routes, so concurrent mutations never interleave on disk.
 * @module dsh-polling/task-service
 */

import type {
  PollingTask,
  PollingTaskError,
  PollingTaskId,
  PollingTaskView,
  ValidatedPollingTaskPatch,
} from './domain.ts'
import { applyTaskPatch, nextRunFor, taskView } from './domain.ts'
import { readStore, writeStore } from './store.ts'

/** One mutation outcome: the updated task, or a stable domain error. */
export type TaskMutationResult = PollingTask | PollingTaskError

/** The polling task registry service. */
export class TaskService {
  private tasks: PollingTask[] = []
  private loaded = false
  private operationTail: Promise<void> = Promise.resolve()

  /**
   * @param file - absolute path to the tasks.json store file.
   */
  constructor(private readonly file: string) {}

  /** Load the store once; a missing file starts empty. */
  async init(): Promise<void> {
    if (this.loaded) return
    const store = await readStore(this.file)
    this.tasks = [...store.tasks]
    this.loaded = true
  }

  /** All tasks in creation order. */
  list(): PollingTask[] {
    return [...this.tasks]
  }

  /** Find one task by id. */
  get(id: PollingTaskId): PollingTask | undefined {
    return this.tasks.find(task => task.id === id)
  }

  /** Find one task by its session id. */
  bySession(sessionId: string): PollingTask | undefined {
    return this.tasks.find(task => task.sessionId === sessionId)
  }

  /** Model/UI views of every task (with derived next-run times). */
  views(now = Date.now()): PollingTaskView[] {
    return this.tasks.map(task => taskView(task, now))
  }

  /**
   * Append one task and persist. Serialized with every other mutation.
   * @returns the stored task.
   */
  async create(task: PollingTask): Promise<PollingTask> {
    return this.enqueue(async () => {
      this.tasks = [...this.tasks, task]
      await this.persist()
      return task
    })
  }

  /**
   * Replace one task's fields and persist.
   * @returns the updated task, or a stable domain error.
   */
  async update(
    id: PollingTaskId,
    patch: ValidatedPollingTaskPatch,
  ): Promise<TaskMutationResult> {
    return this.enqueue(async () => {
      const task = this.tasks.find(candidate => candidate.id === id)
      if (task === undefined) {
        return { code: 'task_not_found', message: `no polling task with id "${id}".` } as const
      }
      const next = applyTaskPatch(task, patch, new Date().toISOString())
      this.tasks = this.tasks.map(candidate => candidate.id === id ? next : candidate)
      await this.persist()
      return next
    })
  }

  /**
   * Apply a caller-owned mutation to one task (used by the scheduler to
   * record run outcomes) and persist.
   * @returns the updated task, or undefined when the task vanished.
   */
  async mutate(id: PollingTaskId, fn: (task: PollingTask) => PollingTask): Promise<PollingTask | undefined> {
    return this.enqueue(async () => {
      const task = this.tasks.find(candidate => candidate.id === id)
      if (task === undefined) return undefined
      const next = fn(task)
      this.tasks = this.tasks.map(candidate => candidate.id === id ? next : candidate)
      await this.persist()
      return next
    })
  }

  /**
   * Remove one task and persist.
   * @returns true when a task was removed, false when it was unknown.
   */
  async delete(id: PollingTaskId): Promise<boolean> {
    return this.enqueue(async () => {
      const before = this.tasks.length
      this.tasks = this.tasks.filter(task => task.id !== id)
      const removed = this.tasks.length !== before
      if (removed) await this.persist()
      return removed
    })
  }

  /** Atomically rewrite the store file with the in-memory state. */
  private async persist(): Promise<void> {
    await writeStore(this.file, { version: 1, tasks: this.tasks })
  }

  /** Serialize mutations on one tail promise (writes never interleave). */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

/** Helper: compute the next-run instant of a task, in UTC ISO form. */
export function nextRunAt(task: PollingTask, now = Date.now()): string | undefined {
  return nextRunFor(task, now)
}
