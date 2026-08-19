/**
 * dsh-polling client half: registers the polling tasks management page in
 * the Plugins settings section, plus the session-header polling action.
 * The settings page is the primary management surface; the header action is
 * an additional per-session quick entry.
 * @module dsh-polling/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle, IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { TaskAction, type TaskActionInjected } from './TaskAction.tsx'
import { TasksSettingsTab, type TasksSettingsTabInjected } from './TasksSettingsTab.tsx'
import { en, NS, zh, type PollingKey } from './locales.ts'

export type { TaskActionInjected, TaskActionProps } from './TaskAction.tsx'
export type { TasksSettingsTabInjected, TasksSettingsTabProps } from './TasksSettingsTab.tsx'
export type { ClientTaskInput, ClientTaskPatch, ClientTaskView } from './TasksSettingsTab.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Polling task menu and editor copy. */
    'polling': PollingKey
  }
}

/** Required services for locale registration and the slot contributions. */
export const inject = ['connection', 'sessions', 'slots', 'locale']

/**
 * Client plugin body: register the dictionaries, the settings tab, and the
 * header action.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-polling: dictionaries')
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  const rpc: ClientConnectionRpc = connection.rpc
  const api: IApiClient = connection.api

  // Settings → Plugins → "插件配置" tab: one card owning the polling task
  // management page (list, create, edit, run). Cards are the section's
  // first-class shape for plugin-owned surfaces.
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    // Keyed slot: the key is the settings namespace the Host serves, so the
    // Plugins tab dispatches this card for the `polling` namespace.
    key: NS,
    // After the shipped bash (0), agent-loop (10), and web-search (20) cards.
    order: 30,
    locale: NS,
    inject: (): TasksSettingsTabInjected => ({ rpc, api }),
  }, TasksSettingsTab))

  // Session-header quick entry (task sessions only).
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'polling-task',
      // After the subagent catalog (session lineage) and the job list
      // (process work): task management is the deepest session-local concern.
      order: 30,
      locale: NS,
      inject: (): TaskActionInjected => ({ rpc, api }),
    }, TaskAction),
  )
}
