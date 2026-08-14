/**
 * Task-session creation shared by the service (initial creation) and the
 * scheduler (recreation after the task session was archived): one live agent
 * on a fresh session, cwd in the polling directory, mounted with the
 * deployment's default agent preset and the task's model overrides.
 * @module dsh-polling/session-factory
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Model route overrides for one task's runs (absent = deployment default). */
export interface TaskModelOptions {
  readonly provider?: string
  readonly model?: string
}

/**
 * Create the task session's live agent: fresh session under the polling
 * directory, deployment default preset mounted, task model overrides applied.
 * The agent stays live (the web surface reuses it when the user opens the
 * session).
 * @param ctx - host context (needs `agents`; optionally `agentPresets` /
 *   `agentDefaultModel`).
 * @param sessionId - the fresh session id.
 * @param pollingDir - absolute polling directory (the session cwd).
 * @param model - task model overrides.
 * @returns the live agent.
 */
export async function createTaskSessionAgent(
  ctx: Context,
  sessionId: SessionId,
  pollingDir: string,
  model: TaskModelOptions,
): Promise<Agent> {
  const presets = ctx.get('agentPresets')
  let agentPreset: string | undefined
  if (presets !== undefined) {
    agentPreset = (await presets.resolve(undefined)).id
  }
  const setup = async (agentCtx: Context): Promise<void> => {
    if (presets === undefined) return
    const resolved = await presets.resolve(agentPreset)
    await presets.mount(agentCtx, resolved.id)
  }
  const defaults = ctx.get('agentDefaultModel')
  const selection = defaults?.currentSelection()
  const handle = await ctx.agents.create({
    sessionId,
    agentOptions: {
      ...selection === undefined ? {} : { provider: selection.provider, model: selection.model },
      ...model.provider === undefined ? {} : { provider: model.provider },
      ...model.model === undefined ? {} : { model: model.model },
    },
    meta: {
      cwd: pollingDir,
      ...agentPreset === undefined ? {} : { agentPreset },
    },
    setup,
  })
  return handle.agent
}
