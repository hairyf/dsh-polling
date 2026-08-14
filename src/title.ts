/**
 * Session-title pinning for polling task sessions: the sidebar and the
 * conversation header display the session's durable title (a `session/title`
 * event in the log), falling back to the cwd basename or the id when absent —
 * and the deployment's automatic title providers may overwrite it after the
 * first turn. Pinning via the session-title service appends the event with
 * the `user` source, which makes the task name authoritative and stops
 * automatic generation from scheduling.
 * @module dsh-polling/title
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionTitleService } from '@deepseek-ai/dsh-session-title'

/**
 * Pin a live session's display title to the task name. No-op when the
 * deployment mounts no session-title service; never throws (a title failure
 * must not fail the task operation that triggered it).
 * @param ctx - host context.
 * @param session - the exact live session to rename.
 * @param name - the task name (the authoritative title).
 */
export function pinSessionTitle(ctx: Context, session: Session, name: string): void {
  const titles = ctx.get('sessionTitle') as SessionTitleService | undefined
  if (titles === undefined) return
  try {
    titles.rename(session, name)
  } catch (error: unknown) {
    ctx.logger.warn(`polling: could not pin session title "${name}": ${String(error)}`)
  }
}
