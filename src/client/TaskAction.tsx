/**
 * Session-header polling task action: rendered only for sessions that belong
 * to a polling task. Opens a menu with task management (edit elements, run
 * now, enable/disable, delete) and an inline element editor.
 * @module dsh-polling/client
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ClientConnectionRpc, IApiClient, RpcResult } from '@deepseek-ai/dsh-client-connection/client'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-client-connection/client'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import { ScheduleBuilder, summarizeCron } from './ScheduleBuilder.tsx'
import { loadModelGroups, modelOptions, selectedProviderOf } from './model-catalog.ts'
import { NS } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './TaskAction.module.css'

/** Wire task view (subset the client needs). */
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

/** Wire task input for create/update. */
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
export interface TaskActionInjected {
  readonly rpc: ClientConnectionRpc
  /** Full connection API client (for the model catalog). */
  readonly api: IApiClient
}

/** Full props for the session-header polling action. */
export type TaskActionProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<typeof NS>
  & TaskActionInjected

/** Dot semantics for the task row. */
function dotState(task: ClientTaskView): StateDotState {
  if (!task.enabled) return 'done'
  if (task.lastRunOutcome === 'failed') return 'error'
  return 'ongoing'
}

/** Status line for the task row. */
function statusLine(task: ClientTaskView, t: TranslateNS<typeof NS>): string {
  if (!task.enabled) return t('task.status.disabled')
  if (task.lastRunOutcome === 'failed') return t('task.status.failed')
  return t('task.status.enabled')
}

/** Format an RFC 3339 instant for display (local time, compact). */
function formatTime(iso: string | undefined): string {
  if (iso === undefined) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString()
}

/**
 * Session-header entry point for the polling task of the current session.
 * Renders nothing at all for ordinary sessions.
 * @param props - runtime slot currency, the translator, and the RPC client.
 * @returns the trigger and its menu, or null when the session is not a task.
 */
export function TaskAction({ sessionId, rpc, api, t }: TaskActionProps) {
  const [task, setTask] = useState<ClientTaskView | undefined | null>(null)
  const [loadError, setLoadError] = useState<string | undefined>()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [modelGroups, setModelGroups] = useState<readonly ModelProviderGroup[]>([])
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // Draft fields for the editor (initialized when editing opens).
  const [draftName, setDraftName] = useState('')
  const [draftCron, setDraftCron] = useState('')
  const [draftDescription, setDraftDescription] = useState('')
  const [draftPrompt, setDraftPrompt] = useState('')
  const [draftModel, setDraftModel] = useState('')
  const [draftEnabled, setDraftEnabled] = useState(true)

  /** Load the provider-grouped model catalog once for the editor dropdown. */
  useEffect(() => {
    let cancelled = false
    void loadModelGroups(api).then(groups => {
      if (!cancelled) setModelGroups(groups)
    })
    return () => { cancelled = true }
  }, [api])

  /** Resolve the task that owns `sessionId`, caching the lookup per session. */
  const loadTask = useCallback(async (target: string): Promise<void> => {
    try {
      const result = await rpc.call('/polling', 'tasks/list', null)
      if (!result.ok) {
        setTask(null)
        setLoadError(t('error.rpc'))
        return
      }
      const tasks = (result.value as unknown as ClientTaskView[] | { code?: string }) ?? []
      if (Array.isArray(tasks)) {
        setTask(tasks.find(candidate => candidate.sessionId === target) ?? null)
        setLoadError(undefined)
      } else {
        setTask(null)
        setLoadError(String((tasks as { code?: string }).code ?? 'unexpected response'))
      }
    } catch (error: unknown) {
      // Never fail silently: a transient RPC failure must not hide the entry.
      console.error('dsh-polling: task lookup failed', error)
      setTask(null)
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [rpc, t])

  useEffect(() => {
    let cancelled = false
    void loadTask(sessionId).then(() => {
      if (cancelled) return
      // fallthrough: state already set inside loadTask
    })
    return () => { cancelled = true }
  }, [sessionId, loadTask])

  const call = useCallback(
    async <T,>(endpoint: string, payload: unknown): Promise<T | undefined> => {
      const result: RpcResult<unknown> = await rpc.call('/polling', endpoint, payload)
      if (!result.ok) {
        setError(t('error.rpc'))
        return undefined
      }
      return result.value as T
    },
    [rpc, t],
  )

  const close = useCallback(() => {
    setOpen(false)
    setEditing(false)
    setNotice(undefined)
    setError(undefined)
    triggerRef.current?.focus()
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    await loadTask(sessionId)
  }, [sessionId, loadTask])

  const runNow = async (): Promise<void> => {
    if (task === undefined || task === null) return
    setBusy(true)
    try {
      const value = await call<{ outcome?: string; code?: string }>('tasks/trigger', { id: task.id })
      setNotice(value?.code === undefined ? t('trigger.started') : t('trigger.failed'))
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const toggleEnabled = async (): Promise<void> => {
    if (task === undefined || task === null) return
    setBusy(true)
    try {
      await call('tasks/update', { id: task.id, patch: { enabled: !task.enabled } })
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const removeTask = async (): Promise<void> => {
    if (task === undefined || task === null) return
    if (!window.confirm(t('delete.confirm', { name: task.name }))) return
    setBusy(true)
    try {
      const value = await call<{ deleted?: boolean; code?: string }>('tasks/delete', { id: task.id })
      if (value?.deleted === true) setNotice(t('delete.done'))
      close()
    } finally {
      setBusy(false)
    }
  }

  const startEditing = (): void => {
    if (task === undefined || task === null) return
    setDraftName(task.name)
    setDraftCron(task.cron)
    setDraftDescription(task.description)
    setDraftPrompt(task.prompt)
    setDraftModel(task.model ?? '')
    setDraftEnabled(task.enabled)
    setError(undefined)
    setEditing(true)
  }

  const save = async (): Promise<void> => {
    if (task === undefined || task === null) return
    setBusy(true)
    try {
      const model = draftModel.trim()
      const provider = model === '' ? undefined : selectedProviderOf(model, modelGroups)
      const patch: ClientTaskPatch = {
        name: draftName.trim(),
        cron: draftCron.trim(),
        description: draftDescription.trim(),
        prompt: draftPrompt.trim(),
        ...(provider === undefined ? {} : { provider }),
        ...(model === '' ? {} : { model }),
        enabled: draftEnabled,
      }
      const value = await call<{ code?: string; message?: string }>('tasks/update', { id: task.id, patch })
      if (value !== undefined && 'code' in (value as object)) {
        setError(t('editor.error', { message: (value as { message?: string }).message ?? '' }))
        return
      }
      setNotice(t('editor.saved'))
      setEditing(false)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    close()
  }

  // Render the entry while loading, with an error state when the lookup
  // failed, and for task sessions. Ordinary sessions (no task, no error)
  // never grow this control.
  if (task === undefined) return null
  if (task === null && loadError === undefined) return null
  const taskMissing = task === null

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-expanded={open}
        aria-label={t('action.aria')}
        title={loadError}
        onClick={() => { setOpen(current => !current) }}
      >
        <StateDot state={taskMissing ? 'warning' : dotState(task)} className={css.triggerDot} />
        <span className={css.triggerLabel}>{t('action.label')}</span>
      </button>
      {open
        ? (
          <div className={css.menu} role="menu" aria-label={t('action.label')}>
            {loadError !== undefined
              ? (
                <ul className={css.list}>
                  <li className={css.row}>
                    <span className={css.status}>{t('error.rpc')}</span>
                  </li>
                  <li className={css.row}>
                    <span className={css.meta}>{loadError}</span>
                  </li>
                  <li className={css.row}>
                    <button type="button" onClick={() => { setOpen(false); void loadTask(sessionId) }}>
                      {t('editor.cancel')}
                    </button>
                  </li>
                </ul>
              )
              : taskMissing
                ? (
                  <ul className={css.list}>
                    <li className={css.row}>
                      <span className={css.status}>{t('error.load')}</span>
                    </li>
                  </ul>
                )
                : editing
                  ? (
                <div className={css.editor}>
                  <div className={css.editorTitle}>{t('editor.title')}</div>
                  <label className={css.field}>
                    <span>{t('editor.name')}</span>
                    <input value={draftName} onChange={event => setDraftName(event.target.value)} />
                  </label>
                  <label className={css.field}>
                    <span>{t('editor.schedule')}</span>
                    <ScheduleBuilder
                      value={draftCron}
                      t={t}
                      onChange={cron => setDraftCron(cron)}
                    />
                  </label>
                  <label className={css.field}>
                    <span>{t('editor.description')}</span>
                    <textarea
                      value={draftDescription}
                      onChange={event => setDraftDescription(event.target.value)}
                    />
                  </label>
                  <label className={css.field}>
                    <span>{t('editor.model')}</span>
                    <select
                      value={draftModel}
                      onChange={event => setDraftModel(event.target.value)}
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
                    <span>{t('editor.prompt')}</span>
                    <textarea
                      className={css.prompt}
                      value={draftPrompt}
                      onChange={event => setDraftPrompt(event.target.value)}
                    />
                  </label>
                  <label className={css.check}>
                    <input
                      type="checkbox"
                      checked={draftEnabled}
                      onChange={event => setDraftEnabled(event.target.checked)}
                    />
                    <span>{t('editor.enabled')}</span>
                  </label>
                  {error !== undefined ? <div className={css.error}>{error}</div> : null}
                  <div className={css.actions}>
                    <button type="button" disabled={busy} onClick={() => void save()}>
                      {t('editor.save')}
                    </button>
                    <button type="button" disabled={busy} onClick={() => setEditing(false)}>
                      {t('editor.cancel')}
                    </button>
                  </div>
                </div>
              )
              : (
                <ul className={css.list}>
                  <li className={css.row}>
                    <span className={css.name} title={task.name}>{task.name}</span>
                    <span className={css.status}>{statusLine(task, t)}</span>
                  </li>
                  <li className={css.row}>
                    <span className={css.meta}>{summarizeCron(task.cron, t)}</span>
                  </li>
                  {task.nextRunAt !== undefined
                    ? (
                      <li className={css.row}>
                        <span className={css.meta}>{t('task.nextRun', { time: formatTime(task.nextRunAt) })}</span>
                      </li>
                    )
                    : null}
                  <li className={css.row}>
                    <span className={css.meta}>
                      {task.lastRunAt !== undefined
                        ? t('task.lastRun', { time: formatTime(task.lastRunAt) })
                        : t('task.neverRun')}
                    </span>
                  </li>
                  {notice !== undefined ? <li className={css.notice}>{notice}</li> : null}
                  <li className={css.row}>
                    <button type="button" disabled={busy} onClick={() => void runNow()}>
                      {t('menu.trigger')}
                    </button>
                    <button type="button" disabled={busy} onClick={() => void toggleEnabled()}>
                      {task.enabled ? t('menu.toggle.disable') : t('menu.toggle.enable')}
                    </button>
                  </li>
                  <li className={css.row}>
                    <button type="button" disabled={busy} onClick={startEditing}>
                      {t('menu.edit')}
                    </button>
                    <button type="button" className={css.danger} disabled={busy} onClick={() => void removeTask()}>
                      {t('menu.delete')}
                    </button>
                  </li>
                </ul>
              )}
          </div>
        )
        : null}
    </div>
  )
}
