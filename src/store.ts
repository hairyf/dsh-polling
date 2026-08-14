/**
 * Task registry persistence: a small JSON file under the DSH home,
 * written atomically (temp file + rename). Zero storage-service
 * dependencies so the plugin runs in any composition.
 * @module dsh-polling/store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { PollingTask, PollingTaskStore } from './domain.ts'

/** The durable store version we read and write. */
export const STORE_VERSION = 1 as const

/** Empty v1 store. */
export function emptyStore(): PollingTaskStore {
  return { version: STORE_VERSION, tasks: [] }
}

/**
 * Read the store file; a missing or unreadable file yields the empty store
 * (first run). A present file that fails shape validation throws — a
 * corrupt store must fail loud, never silently reset.
 * @param file - absolute path to tasks.json.
 */
export async function readStore(file: string): Promise<PollingTaskStore> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore()
    throw error
  }
  const parsed: unknown = JSON.parse(raw)
  if (!isStore(parsed)) {
    throw new Error(`polling store "${file}" is corrupt: shape validation failed`)
  }
  return parsed
}

/** Shape validation for the v1 store (closed, no unknown extras accepted). */
function isStore(value: unknown): value is PollingTaskStore {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.version !== STORE_VERSION) return false
  if (!Array.isArray(record.tasks)) return false
  return record.tasks.every(isTask)
}

/** Shape validation for one task record. */
function isTask(value: unknown): value is PollingTask {
  if (typeof value !== 'object' || value === null) return false
  const task = value as Record<string, unknown>
  return typeof task.id === 'string'
    && typeof task.sessionId === 'string'
    && typeof task.name === 'string'
    && typeof task.cron === 'string'
    && typeof task.description === 'string'
    && typeof task.prompt === 'string'
    && typeof task.enabled === 'boolean'
    && typeof task.createdAt === 'string'
    && typeof task.updatedAt === 'string'
    && (task.timeZone === undefined || typeof task.timeZone === 'string')
    && (task.provider === undefined || typeof task.provider === 'string')
    && (task.model === undefined || typeof task.model === 'string')
    && (task.lastRunAt === undefined || typeof task.lastRunAt === 'string')
    && (task.lastRunOutcome === undefined
      || task.lastRunOutcome === 'ok'
      || task.lastRunOutcome === 'failed'
      || task.lastRunOutcome === 'aborted'
      || task.lastRunOutcome === 'skipped')
}

/**
 * Atomically write the store: serialize to a temp sibling and rename over
 * the target, so a crash mid-write never leaves a truncated tasks.json.
 * @param file - absolute path to tasks.json.
 * @param store - the full store to persist.
 */
export async function writeStore(file: string, store: PollingTaskStore): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temp, JSON.stringify(store, null, 2), 'utf8')
  await rename(temp, file)
}
