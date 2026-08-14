/**
 * Polling workspace lifecycle: ensure the polling directory + workspace
 * registration exist, and optionally keep the workspace pinned at the top
 * of the sidebar list.
 * @module dsh-polling/workspace
 */

import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'

/** The polling workspace display title. */
export const POLLING_WORKSPACE_TITLE = '轮询'

/** Resolved polling workspace facts. */
export interface PollingWorkspace {
  readonly workspace: Workspace
  /** Whether this call created the registration (false = pre-existing). */
  readonly created: boolean
}

/**
 * Ensure the polling directory exists and is registered as a workspace.
 * A newly created registration is prepended to the registry order (top of
 * the sidebar) by the registry itself.
 * @param ctx - host context with `workspaceRegistry`.
 * @param dir - the polling directory (created if missing).
 * @returns the workspace and whether it was just created.
 */
export async function ensurePollingWorkspace(ctx: Context, dir: string): Promise<PollingWorkspace> {
  await mkdir(dir, { recursive: true })
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) {
    throw new Error('polling: workspaceRegistry service is not composed')
  }
  const existing = await registry.resolveByPath(dir)
  if (existing !== undefined) return { workspace: existing, created: false }
  const workspace = await registry.create(dir, POLLING_WORKSPACE_TITLE)
  return { workspace, created: true }
}

/**
 * Move the polling workspace to the first position of the registry order
 * (DOM-insertBefore semantics: before the current first workspace).
 * @param ctx - host context with `workspaceRegistry`.
 * @param workspaceId - the polling workspace id.
 */
export async function pinPollingWorkspace(
  ctx: Context,
  workspaceId: WorkspaceId,
): Promise<void> {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return
  const order = registry.list()
  if (order.length === 0 || order[0]!.id === workspaceId) return
  await registry.insertBefore(workspaceId, order[0]!.id)
}
