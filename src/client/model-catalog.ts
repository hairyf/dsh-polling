/**
 * Shared model-catalog helpers for the task editors: enumerate the
 * provider-grouped model list from the connection API and resolve the
 * provider that advertises a selected model id.
 * @module dsh-polling/client/model-catalog
 */

import type { IApiClient, ModelProviderGroup } from '@deepseek-ai/dsh-client-connection/client'

/**
 * Load the provider-grouped model catalog (uses the most recent session as
 * the model-list anchor). Best-effort: any failure yields an empty list.
 * @param api - the connection API client.
 * @returns the catalog groups.
 */
export async function loadModelGroups(api: IApiClient): Promise<readonly ModelProviderGroup[]> {
  try {
    const list = await api.sessions.list({})
    const items = list.result.ok ? list.result.value.items : []
    if (items.length === 0) return []
    const target = items[0]!.sessionId
    const { result } = await api.sessions.models({ sessionId: target })
    return result.ok ? result.value.groups : []
  } catch (error: unknown) {
    console.error('dsh-polling: model catalog failed', error)
    return []
  }
}

/** Flatten the provider-grouped model catalog into one option list. */
export function modelOptions(groups: readonly ModelProviderGroup[]): readonly { provider: string; model: string; label: string }[] {
  const out: { provider: string; model: string; label: string }[] = []
  for (const group of groups) {
    for (const model of group.models) {
      out.push({
        provider: group.id,
        model: model.id,
        label: model.name !== '' ? model.name : model.id,
      })
    }
  }
  return out
}

/** Resolve the provider that advertises one model id (first match wins). */
export function selectedProviderOf(model: string, groups: readonly ModelProviderGroup[]): string | undefined {
  for (const group of groups) {
    if (group.models.some(candidate => candidate.id === model)) return group.id
  }
  return undefined
}
