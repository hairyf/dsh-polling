/**
 * Polling tasks settings card: a collapsible card in the "插件配置" tab —
 * the header names the plugin like the shipped cards, expanding reveals the
 * full task management page (list, create, edit, run).
 * @module dsh-polling/client
 */

import { useCallback, useEffect, useState } from 'react'
import type { ClientConnectionRpc, IApiClient, RpcResult } from '@deepseek-ai/dsh-client-connection/client'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-client-connection/client'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { ScheduleBuilder, summarizeCron } from './ScheduleBuilder.tsx'
import { loadModelGroups, modelOptions, selectedProviderOf } from './model-catalog.ts'
import { NS, type PollingKey } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './TasksSettingsTab.module.css'

/** Wire task view (mirrors the host domain view). */
export interface ClientTaskView {
  readonly id: string
  readonly sessionId: string
  readonly name: string
  readonly cron: string
  readonly timeZone?: string
  readonly provider?: string
  readonly model?: string
  readonly description: string
  readonly prompt: string
  readonly enabled: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastRunAt?: string
  readonly lastRunOutcome?: 'ok' | 'failed' | 'aborted' | 'skipped'
  readonly nextRunAt?: string
}

/** Wire input for create/update. */
export interface ClientTaskInput {
  readonly name: string
  readonly cron: string
  readonly description?: string
  readonly prompt: string
  readonly timeZone?: string
  readonly provider?: string
  readonly model?: string
  readonly enabled?: boolean
}

/** Wire patch for updates (same shape, all optional). */
export interface ClientTaskPatch {
  readonly name?: string
  readonly cron?: string
  readonly description?: string
  readonly prompt?: string
  readonly timeZone?: string
  readonly provider?: string
  readonly model?: string
  readonly enabled?: boolean
}

/** Injected share: the connection RPC client for the `/polling` channel. */
export interface TasksSettingsTabInjected {
  readonly rpc: ClientConnectionRpc
  /** Full connection API client (for the session.model catalog). */
  readonly api: IApiClient
}

/** Full props for the settings card. */
export type TasksSettingsTabProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<typeof NS>
  & TasksSettingsTabInjected

/** Stable empty array for the initial render. */
const NO_TASKS: readonly ClientTaskView[] = []

/** Format an RFC 3339 instant for display (local time, compact). */
function formatTime(iso: string | undefined): string {
  if (iso === undefined) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString()
}

/** Outcome dot semantics. */
function dotState(task: ClientTaskView): 'ongoing' | 'done' | 'error' | 'warning' {
  if (!task.enabled) return 'done'
  if (task.lastRunOutcome === 'failed') return 'error'
  if (task.lastRunOutcome === 'skipped') return 'warning'
  return 'ongoing'
}

/** Empty editor draft. */
function emptyDraft(): Draft {
  return {
    name: '',
    cron: '*/30 9-18 * * *',
    description: '',
    prompt: '',
    model: '',
    enabled: true,
  }
}

/** Editor-internal draft: every field concrete so inputs bind without undefined. */
interface Draft {
  name: string
  cron: string
  description: string
  prompt: string
  model: string
  enabled: boolean
}

/** Trimmed optional wire field: empty strings stay absent. */
function optionalTrim(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * The polling tasks settings card.
 * @param props - slot currency, translator, and the RPC client.
 * @returns the collapsible card.
 */
export function TasksSettingsTab({ t, rpc, api }: TasksSettingsTabProps) {
  const [open, setOpen] = useState(false)
  const [tasks, setTasks] = useState<readonly ClientTaskView[]>(NO_TASKS)
  const [loadError, setLoadError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [editing, setEditing] = useState<ClientTaskView | 'new' | null>(null)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [modelGroups, setModelGroups] = useState<readonly ModelProviderGroup[]>([])

  /** Load the provider-grouped model catalog once (uses the most recent session). */
  useEffect(() => {
    let cancelled = false
    void loadModelGroups(api).then(groups => {
      if (!cancelled) setModelGroups(groups)
    })
    return () => { cancelled = true }
  }, [api])

  /** Fetch the task list. */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await rpc.call('/polling', 'tasks/list', null)
      if (!result.ok) {
        // Surface the full server error so the cause is never invisible.
        setLoadError(`${t('error.rpc')} (${JSON.stringify(result.error)})`)
        return
      }
      const value = result.value as unknown
      if (Array.isArray(value)) {
        setTasks(value as ClientTaskView[])
        setLoadError(undefined)
      } else {
        setLoadError(String((value as { code?: string })?.code ?? 'unexpected response'))
      }
    } catch (callError: unknown) {
      console.error('dsh-polling: task list failed', callError)
      setLoadError(callError instanceof Error ? `${callError.message}\n${callError.stack ?? ''}` : String(callError))
    }
  }, [rpc, t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** One RPC call with error surfacing. */
  const call = useCallback(
    async <T,>(endpoint: string, payload: unknown): Promise<T | undefined> => {
      setBusy(true)
      try {
        const result: RpcResult<unknown> = await rpc.call('/polling', endpoint, payload)
        if (!result.ok) {
          setError(t('error.rpc'))
          return undefined
        }
        return result.value as T
      } catch (callError: unknown) {
        setError(callError instanceof Error ? callError.message : String(callError))
        return undefined
      } finally {
        setBusy(false)
      }
    },
    [rpc, t],
  )

  const runAction = async (action: () => Promise<unknown>, successNotice: string): Promise<void> => {
    setError(undefined)
    setNotice(undefined)
    const value = await action()
    if (value !== undefined && typeof value === 'object' && 'code' in (value as object)) {
      setError(t('editor.error', { message: String((value as { message?: string }).message ?? '') }))
      return
    }
    setNotice(successNotice)
    await refresh()
  }

  const create = async (): Promise<void> => {
    const model = optionalTrim(draft.model)
    const provider = model === undefined ? undefined : selectedProviderOf(model, modelGroups)
    const input: ClientTaskInput = {
      name: draft.name.trim(),
      cron: draft.cron.trim(),
      description: draft.description.trim(),
      prompt: draft.prompt.trim(),
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      enabled: draft.enabled,
    }
    await runAction(() => call('tasks/create', input), t('editor.saved'))
    if (error === undefined) setEditing(null)
  }

  const update = async (): Promise<void> => {
    if (editing === null || editing === 'new') return
    const model = optionalTrim(draft.model)
    const provider = model === undefined ? undefined : selectedProviderOf(model, modelGroups)
    const patch: ClientTaskPatch = {
      name: draft.name.trim(),
      cron: draft.cron.trim(),
      description: draft.description.trim(),
      prompt: draft.prompt.trim(),
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      enabled: draft.enabled,
    }
    await runAction(() => call('tasks/update', { id: editing.id, patch }), t('editor.saved'))
    if (error === undefined) setEditing(null)
  }

  const toggleEnabled = async (task: ClientTaskView): Promise<void> => {
    await runAction(
      () => call('tasks/update', { id: task.id, patch: { enabled: !task.enabled } }),
      t('editor.saved'),
    )
  }

  const runNow = async (task: ClientTaskView): Promise<void> => {
    await runAction(
      () => call('tasks/trigger', { id: task.id }),
      t('trigger.started'),
    )
  }

  const removeTask = async (task: ClientTaskView): Promise<void> => {
    if (!window.confirm(t('delete.confirm', { name: task.name }))) return
    await runAction(() => call('tasks/delete', { id: task.id }), t('delete.done'))
  }

  const startEdit = (task: ClientTaskView): void => {
    setError(undefined)
    setNotice(undefined)
    setDraft({
      name: task.name,
      cron: task.cron,
      description: task.description,
      prompt: task.prompt,
      model: task.model ?? '',
      enabled: task.enabled,
    })
    setEditing(task)
  }

  const startNew = (): void => {
    setError(undefined)
    setNotice(undefined)
    setDraft(emptyDraft())
    setEditing('new')
  }

  const save = (): void => {
    setError(undefined)
    void (editing === 'new' ? create() : update())
  }

  if (loadError !== undefined) {
    return (
      <li className={`${css.card} ${open ? css.cardOpen : ''}`}>
        <button
          type="button"
          className={css.header}
          aria-expanded={open}
          onClick={() => setOpen(current => !current)}
        >
          <span className={css.headText}>
            <span className={css.name}>{t('card.title')}</span>
            <span className={css.description}>{t('card.description')}</span>
          </span>
          <span className={`${css.chevron} ${open ? css.chevronOpen : ''}`}>▾</span>
        </button>
        {open
          ? (
            <div className={css.body}>
              <div className={css.page}>
                <div className={css.error}>{loadError}</div>
                <button type="button" onClick={() => { setLoadError(undefined); void refresh() }}>
                  {t('editor.cancel')}
                </button>
              </div>
            </div>
          )
          : null}
      </li>
    )
  }

  return (
    <li className={`${css.card} ${open ? css.cardOpen : ''}`}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
      >
        <span className={css.headText}>
          <span className={css.name}>{t('card.title')}</span>
          <span className={css.description}>{t('card.description')}</span>
        </span>
        <span className={`${css.chevron} ${open ? css.chevronOpen : ''}`}>▾</span>
      </button>
      {open
        ? (
          <div className={css.body}>
            <div className={css.page}>
              <div className={css.toolbar}>
                <button type="button" className={css.primary} onClick={startNew}>
                  {t('menu.new')}
                </button>
                {notice !== undefined ? <span className={css.notice}>{notice}</span> : null}
                {error !== undefined ? <span className={css.error}>{error}</span> : null}
              </div>

              {editing !== null
                ? (
          <div className={css.editor}>
            <div className={css.editorTitle}>
              {editing === 'new' ? t('editor.newTitle') : t('editor.title')}
            </div>
            <label className={css.field}>
              <span>{t('editor.name')}</span>
              <input value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} />
            </label>
            <div className={css.field}>
              <span>{t('editor.schedule')}</span>
              <ScheduleBuilder
                value={draft.cron}
                t={t}
                onChange={cron => setDraft({ ...draft, cron })}
              />
            </div>
            <label className={css.field}>
              <span>{t('editor.model')}</span>
              <select
                value={draft.model}
                onChange={event => setDraft({ ...draft, model: event.target.value })}
              >
                <option value="">{t('editor.modelDefault')}</option>
                {modelOptions(modelGroups).map(option => (
                  <option key={`${option.provider}/${option.model}`} value={option.model}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={css.field}>
              <span>{t('editor.description')}</span>
              <textarea
                value={draft.description}
                onChange={event => setDraft({ ...draft, description: event.target.value })}
              />
            </label>
            <label className={css.field}>
              <span>{t('editor.prompt')}</span>
              <textarea
                className={css.prompt}
                value={draft.prompt}
                onChange={event => setDraft({ ...draft, prompt: event.target.value })}
              />
            </label>
            <label className={css.check}>
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={event => setDraft({ ...draft, enabled: event.target.checked })}
              />
              <span>{t('editor.enabled')}</span>
            </label>
            <div className={css.actions}>
              <button type="button" disabled={busy} onClick={save}>{t('editor.save')}</button>
              <button type="button" disabled={busy} onClick={() => setEditing(null)}>
                {t('editor.cancel')}
              </button>
            </div>
          </div>
        )
        : (
          <ul className={css.list}>
            {tasks.length === 0
              ? <li className={css.row}>{t('task.empty')}</li>
              : tasks.map(task => (
                <li key={task.id} className={css.row}>
                  <span className={`${css.dot} ${css[dotState(task)]}`} aria-hidden="true" />
                  <span className={css.name} title={task.name}>{task.name}</span>
                  <span className={css.meta}>{summarizeCron(task.cron, t)}</span>
                  {task.model !== undefined ? <span className={css.meta}>{task.model}</span> : null}
                  <span className={css.meta}>
                    {task.lastRunAt !== undefined
                      ? `${t('task.lastRun', { time: formatTime(task.lastRunAt) })}${task.lastRunOutcome === 'skipped' ? ` · ${t('task.status.skipped')}` : ''}`
                      : t('task.neverRun')}
                  </span>
                  {task.nextRunAt !== undefined
                    ? <span className={css.meta}>{t('task.nextRun', { time: formatTime(task.nextRunAt) })}</span>
                    : null}
                  <span className={css.actions}>
                    <button type="button" disabled={busy} onClick={() => void runNow(task)}>
                      {t('menu.trigger')}
                    </button>
                    <button type="button" disabled={busy} onClick={() => void toggleEnabled(task)}>
                      {task.enabled ? t('menu.toggle.disable') : t('menu.toggle.enable')}
                    </button>
                    <button type="button" disabled={busy} onClick={() => startEdit(task)}>
                      {t('menu.edit')}
                    </button>
                    <button type="button" className={css.danger} disabled={busy} onClick={() => void removeTask(task)}>
                      {t('menu.delete')}
                    </button>
                  </span>
                </li>
              ))}
          </ul>
        )}
            </div>
          </div>
        )
        : null}
    </li>
  )
}
