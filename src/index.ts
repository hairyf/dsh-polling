/**
 * dsh-polling — polling-task plugin for DeepSeek Harness.
 *
 * Zero-upstream-change plugin: polling tasks live as a real workspace of
 * sessions, the scheduler runs on the host plane, the model creates/manages
 * tasks by natural language through `polling_*` tools, and the web UI talks
 * to the host through the `/polling` RPC channel.
 * @module dsh-polling
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-session-persistence'
import z from '@deepseek-ai/schemastery'
import { registerPollingRpc } from './routes.ts'
import { PollingScheduler } from './scheduler.ts'
import { PollingService } from './service.ts'
import { TaskService } from './task-service.ts'
import { registerPollingTools } from './tools.ts'
import { ensurePollingWorkspace, pinPollingWorkspace } from './workspace.ts'

export type * from './domain.ts'
export { PollingScheduler } from './scheduler.ts'
export { PollingService } from './service.ts'
export { TaskService } from './task-service.ts'
export * from './cron.ts'

/** Cordis function-plugin name. */
export const name = 'polling'

/** Services required before the plugin activates. */
export const inject = ['agents', 'tools']

/** Default polling directory under the DSH home. */
export const POLLING_DIR_NAME = 'polling'

/** Plugin configuration. */
export interface Config {
  /**
   * Absolute directory holding the polling workspace and tasks.json.
   * Defaults to `<dshHome>/polling`.
   */
  dir?: string
  /**
   * Whether to force the polling workspace back to the top of the sidebar
   * list whenever it is moved away (default false — the workspace is pinned
   * at creation only).
   */
  keepPinned?: boolean
}

/**
 * Mount the polling plugin: load the task registry, start the scheduler,
 * register the model tools and the web RPC channel, and ensure the polling
 * workspace once the workspace registry is available.
 * @param ctx - host plugin context.
 * @param config - plugin configuration.
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const dir = config.dir ?? dshHomePath(POLLING_DIR_NAME)
  const keepPinned = config.keepPinned ?? false

  const tasks = new TaskService(join(dir, 'tasks.json'))
  await tasks.init()

  const scheduler = new PollingScheduler(ctx, tasks, dir)
  const service = new PollingService(ctx, tasks, scheduler, dir, keepPinned)

  // Register effects: dispose tools/RPC on unload; stop the scheduler last.
  ctx.effect(() => {
    const disposeTools = registerPollingTools(ctx, service)
    const disposeRpc = registerPollingRpc(ctx, service)
    const disposeRequestOverride = scheduler.registerRequestOverride()
    scheduler.start()
    return async () => {
      disposeTools()
      disposeRequestOverride()
      await disposeRpc()
      await scheduler.dispose()
    }
  }, 'polling.lifecycle()')

  // Ensure the workspace registration exists once `workspaceRegistry` is
  // ready (newly created registrations land at the top of the sidebar
  // automatically). Deployments without the registry (e.g. headless) skip
  // this: the model tools and scheduler never depend on it.
  ctx.inject(['workspaceRegistry'], (registryCtx: Context) => {
    registryCtx.effect(() => {
      let created = false
      let workspaceId: string | undefined
      void (async () => {
        try {
          const { created: fresh, workspace } = await ensurePollingWorkspace(registryCtx, dir)
          created = fresh
          workspaceId = workspace.id
          registryCtx.logger.info(
            fresh
              ? `polling: workspace "${workspace.title}" created at ${dir}`
              : `polling: workspace "${workspace.title}" ready at ${dir}`,
          )
          if (keepPinned) await pinPollingWorkspace(registryCtx, workspace.id)
        } catch (error: unknown) {
          registryCtx.logger.warn(`polling: workspace setup failed: ${String(error)}`)
        }
      })()
      return () => {
        // Workspace registrations are durable; nothing to undo beyond the
        // in-flight setup. `created`/`workspaceId` are kept for diagnostics.
        void created
        void workspaceId
      }
    }, 'polling.workspace()')
  })

  // Serve the `polling` settings namespace so the client Plugins tab
  // ("插件配置") dispatches the polling card. `settings` is an optional Host
  // service; deployments without it (e.g. headless) skip this gracefully.
  // The namespace exists purely as a dispatch key — the card reads no
  // settings scope — so an empty schema is correct.
  ctx.inject(['settings'], (settingsCtx: Context) => {
    settingsCtx.settings.register(settingsNamespace('polling'), z.object({}))
  })
}
