/**
 * Model-facing polling tools, registered on the global tool layer so every
 * agent (whatever preset it runs) can create and manage polling tasks by
 * natural language.
 * @module dsh-polling/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PollingService } from './service.ts'

/** Deterministic model content for every canonical value. */
function renderValue(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** Closed error output schema shared by the management tools. */
const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: {
      type: 'string',
      required: true,
      enum: [
        'invalid_name', 'invalid_cron', 'invalid_time_zone', 'empty_prompt',
        'task_not_found', 'internal_error', 'persistence_uncertain',
      ],
    },
    message: { type: 'string', required: true },
  },
} as const

/** Canonical view schema for one task. */
const TASK_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    sessionId: { type: 'string', required: true },
    name: { type: 'string', required: true },
    cron: { type: 'string', required: true },
    timeZone: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    description: { type: 'string', required: true },
    prompt: { type: 'string', required: true },
    enabled: { type: 'boolean', required: true },
    createdAt: { type: 'string', required: true },
    updatedAt: { type: 'string', required: true },
    lastRunAt: { type: 'string' },
    lastRunOutcome: { type: 'string', enum: ['ok', 'failed', 'aborted', 'skipped'] },
    nextRunAt: { type: 'string' },
  },
} as const

/** Parameter properties shared by create and edit. */
const TASK_PARAMETER_PROPERTIES = {
  name: {
    type: 'string',
    required: true,
    description: '任务名称（也将作为任务会话标题）',
  },
  cron: {
    type: 'string',
    required: true,
    description:
      'cron 表达式：5 段(分 时 日 月 周)或 6 段(秒 分 时 日 月 周)。'
      + '支持 */,- 步长与列表、JAN-DEC 月名、SUN-SAT 周名；日字段与周字段为 OR 语义。'
      + '示例："0 9 * * *" 每天 9 点；"0 9 * * 1-5" 工作日 9 点；"0 9 1 * *" 每月 1 号 9 点',
  },
  prompt: {
    type: 'string',
    required: true,
    description: '任务步骤描述：每次到点由模型自主执行的自然语言指令（模型可调用一切可用工具完成）',
  },
  description: {
    type: 'string',
    description: '任务目标/背景描述（给模型的上下文）',
  },
  timeZone: {
    type: 'string',
    description: 'IANA 时区，如 Asia/Shanghai；缺省为服务器本地时区',
  },
  provider: {
    type: 'string',
    description: '模型供应商路由（如 deepseek）；缺省为部署默认',
  },
  model: {
    type: 'string',
    description: '模型 id（如 deepseek-chat）；缺省为部署默认',
  },
  enabled: {
    type: 'boolean',
    description: '是否启用；缺省 true',
  },
} as const

const CREATE_OUTPUT_SCHEMA = { oneOf: [TASK_VIEW_SCHEMA, ERROR_SCHEMA] } as const
const LIST_OUTPUT_SCHEMA = {
  oneOf: [
    { type: 'array', items: TASK_VIEW_SCHEMA },
    ERROR_SCHEMA,
  ],
} as const
const DELETE_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        deleted: { type: 'boolean', required: true, const: true },
      },
    },
    ERROR_SCHEMA,
  ],
} as const
const TRIGGER_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        outcome: { type: 'string', required: true, enum: ['ok', 'failed', 'aborted', 'skipped'] },
      },
    },
    ERROR_SCHEMA,
  ],
} as const

const CREATE_DESCRIPTION =
  '创建/注册一个轮询任务：按 cron 表达式定时，在任务自己的会话里让模型执行 prompt 描述的任务步骤。'
  + '任务会作为一个新会话出现在侧边栏"轮询"工作区里。支持任意模型可执行的任务'
  + '（检查/处理文件、抓取网页、发送消息等一切能力）。'

const LIST_DESCRIPTION =
  '列出所有轮询任务及其状态（cron、启停、最近/下次执行时间）。'

const UPDATE_DESCRIPTION =
  '编辑一个轮询任务的部分要素：名称、cron、描述、任务步骤、时区、启停。只传要修改的字段。'

const DELETE_DESCRIPTION =
  '删除一个轮询任务（任务定义移除，任务会话与执行历史保留）。'

const TRIGGER_DESCRIPTION =
  '立即手动执行一次轮询任务，不等下一次 cron 触发。'

/**
 * Register the five polling tools on the global tool layer.
 * @param ctx - plugin context (plain context = global registration layer).
 * @param service - the polling business service.
 * @returns the aggregate disposer.
 */
export function registerPollingTools(ctx: Context, service: PollingService): () => void {
  const disposers: Array<() => void> = []

  disposers.push(ctx.tools.register(defineTool({
    name: 'polling_create',
    description: CREATE_DESCRIPTION,
    parameters: TASK_PARAMETER_PROPERTIES,
    output: { schema: CREATE_OUTPUT_SCHEMA, render: renderValue },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      return service.create(args)
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'polling_list',
    description: LIST_DESCRIPTION,
    parameters: {},
    output: { schema: LIST_OUTPUT_SCHEMA, render: renderValue },
    async execute(_args, exec) {
      exec.signal.throwIfAborted()
      return service.list()
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'polling_edit',
    description: UPDATE_DESCRIPTION,
    parameters: {
      id: { type: 'string', required: true, description: 'polling_create / polling_list 返回的任务 id' },
      name: TASK_PARAMETER_PROPERTIES.name,
      cron: TASK_PARAMETER_PROPERTIES.cron,
      prompt: TASK_PARAMETER_PROPERTIES.prompt,
      description: TASK_PARAMETER_PROPERTIES.description,
      timeZone: TASK_PARAMETER_PROPERTIES.timeZone,
      provider: TASK_PARAMETER_PROPERTIES.provider,
      model: TASK_PARAMETER_PROPERTIES.model,
      enabled: TASK_PARAMETER_PROPERTIES.enabled,
    },
    output: { schema: CREATE_OUTPUT_SCHEMA, render: renderValue },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const { id, ...patch } = args as { id: string } & Record<string, unknown>
      return service.update(id, patch as never)
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'polling_delete',
    description: DELETE_DESCRIPTION,
    parameters: {
      id: { type: 'string', required: true, description: '要删除的任务 id' },
    },
    output: { schema: DELETE_OUTPUT_SCHEMA, render: renderValue },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const { id } = args as { id: string }
      const result = await service.delete(id)
      if (result === true) return { id, deleted: true } as const
      // Unknown task → the stable task_not_found error (the output union has
      // no deleted:false branch).
      if (result === false) {
        return { code: 'task_not_found', message: `no polling task with id "${id}".` } as const
      }
      return result as never
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'polling_trigger',
    description: TRIGGER_DESCRIPTION,
    parameters: {
      id: { type: 'string', required: true, description: '要立即执行的任务 id' },
    },
    output: { schema: TRIGGER_OUTPUT_SCHEMA, render: renderValue },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const { id } = args as { id: string }
      const result = await service.trigger(id)
      if (typeof result === 'string') return { id, outcome: result }
      return result
    },
  })))

  return () => {
    for (const disposer of disposers.reverse()) disposer()
  }
}
