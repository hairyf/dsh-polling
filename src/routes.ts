/**
 * Web RPC channel: exposes the polling service to the browser half through
 * `ctx.connection.rpc.handle('/polling', ...)`. Third-party channels are a
 * first-class extension point — no upstream allowlist needed.
 * @module dsh-polling/routes
 */

import type { Context } from '@deepseek-ai/cordis'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { HostConnectionRpc } from '@deepseek-ai/dsh-client-connection'
import type { PollingTaskInput, PollingTaskPatch } from './domain.ts'
import type { PollingService } from './service.ts'

/** One decoded endpoint dispatch. */
type EndpointHandler = (payload: unknown, signal: AbortSignal) => Promise<unknown>

/** Map endpoint name → handler; unknown endpoints answer `rpc-not-found`. */
function buildHandlers(service: PollingService): Record<string, EndpointHandler> {
  return {
    'tasks/list': async () => service.list(),
    'tasks/get': async (payload) => {
      const { id } = payload as { id: string }
      const task = service.get(id)
      if (task === undefined) {
        return { code: 'task_not_found', message: `no polling task with id "${id}".` }
      }
      return task
    },
    'tasks/create': async (payload) => service.create(payload as PollingTaskInput),
    'tasks/update': async (payload) => {
      const { id, patch } = payload as { id: string; patch: PollingTaskPatch }
      return service.update(id, patch)
    },
    'tasks/delete': async (payload) => {
      const { id } = payload as { id: string }
      const result = await service.delete(id)
      if (result === true) return { id, deleted: true }
      if (result === false) return { id, deleted: false }
      return result
    },
    'tasks/trigger': async (payload) => {
      const { id } = payload as { id: string }
      const result = await service.trigger(id)
      if (typeof result === 'string') return { id, outcome: result }
      return result
    },
  }
}

/** Success envelope. */
function ok(value: unknown): RpcResult<unknown> {
  return { ok: true, value }
}

/** Failure envelope (stable codes only, never internal stack traces). */
function err(message: string): RpcResult<never> {
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

/**
 * Register the `/polling` RPC channel.
 * @param ctx - host context with `connection`.
 * @param service - the polling business service.
 * @returns the async channel disposer.
 */
export function registerPollingRpc(ctx: Context, service: PollingService): () => Promise<void> {
  const connection = ctx.get('connection') as { readonly rpc: HostConnectionRpc } | undefined
  if (connection === undefined) {
    // No web transport composed (e.g. headless); the model tools still work.
    return async () => {}
  }
  const handlers = buildHandlers(service)
  return connection.rpc.handle(
    '/polling',
    async (endpoint: string, payload: unknown, signal: AbortSignal): Promise<RpcResult<unknown>> => {
      const handler = handlers[endpoint]
      if (handler === undefined) return err(`unknown polling endpoint "${endpoint}"`)
      try {
        return ok(await handler(payload, signal))
      } catch (error: unknown) {
        return err(error instanceof Error ? error.message : String(error))
      }
    },
    { authority: 'loopback' },
  )
}
