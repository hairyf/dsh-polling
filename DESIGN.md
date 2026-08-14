# dsh-polling 设计文档

> 轮询任务插件：零上游改动、即插即用、双半部分（Host 调度 + Web UI）。
> 独立项目，与 DSH 仓库分离。

## 1. 产品形态（已与用户确认）

- **轮询 = 一个真实 Workspace**：插件在用户 `$DSH_HOME` 下创建 `polling/` 目录并注册为工作区（标题"轮询"），新工作区自动置顶（`workspaceRegistry.create` 语义），之后跟随用户排序。
- **轮询任务 = 工作区里的会话**：每个任务一个真实 Session（`cwd` = 轮询目录），侧边栏展开/收起、状态点、搜索全部由现有 ui-workspace 免费提供。
- **任务要素**：名称、cron 表达式（5/6 段，支持每月/每周几）、时区、目标/要素描述、任务步骤描述（自然语言，模型自执行）、启停开关。
- **静默执行**：到点后台执行，不打扰其他会话；执行过程与结果留在任务会话自己的对话记录里。
- **主动指挥**：任务会话是正常对话界面，用户可打开发消息指挥。
- **三点菜单**：任务会话的 header actions 显示"编辑任务/启停/立即执行"等轮询专属项。
- **双入口**：Web 前端（工作区 + 三点菜单 + 编辑面板）+ 对话自然语言（`polling_*` 模型工具）。

## 2. 零上游改动的依据（已逐项核实）

| 需求 | 现成机制 | 证据 |
|---|---|---|
| 创建工作区并置顶 | `ctx.workspaceRegistry.create(path, title?)`（新记录自动 prepend 到注册顺序首位）；拉回第一位用 `insertBefore(id, list()[0].id)` | packages/workspace/workspace/src/index.ts:158, 330, 210 |
| 任务会话标记（可选） | **`origin` 无法扩展**（类型 `'subagent'` 字面量，运行时显式拒绝其他值）；改用自定义 SessionEventMap 事件 `polling/task` 写入会话日志，或直接依赖注册表映射（sessionId→task，推荐，零 header 改动） | packages/core/agent/src/index.ts:98, 125-127 |
| 工作区内会话归属 | 会话 `SessionHeader.cwd` 匹配工作区路径 + `workspace.attachSession(sessionId)` | packages/workspace/workspace/src/entity.ts:109 |
| 创建/恢复任务会话 agent | `ctx.agents.create({sessionId, meta:{cwd}, setup})` / `ctx.agents.resume({resumeSessionId, setup})` | packages/core/agent/src/index.ts:80-156 |
| 任务会话获得完整工具 | setup 里 `ctx.agentPresets.mount(agentCtx, presetId)`（默认 preset） | packages/preset/agent-presets/README.md |
| 定时触发 + followup | cookbook 官方模式：timer → 空闲 `followup()` / 忙碌 `inject()`，`source: {kind:'cron'}` | docs/cookbook/extension-cookbook.md:124 |
| 调度器（host 平面，不依赖会话存活） | 自实现 timer owner（照 schedule runtime 的 bounded-timer 模式），任务注册表持久化在插件自己的 JSON 文件 | packages/schedule/schedule/src/runtime.ts |
| 模型工具（任意会话可见） | `ctx.tools.register()` 在普通插件上下文注册即进 global 层，preset agent 的 scope 链 `agent → preset → global` 可见且无同名冲突 | packages/core/tools/README.md:20 |
| 前端入口 | 无需新 slot：轮询工作区是真实 workspace，ui-workspace 自动渲染；三点菜单注册 `conversation.session.header.actions`（list slot） | packages/client/ui-jobs/src/client/index.ts:30 |
| client→host 数据通路 | **`ctx.connection.rpc.handle(channel, handler, {authority})` + `ctx.connection.rpc.call(channel, endpoint, payload)`** 通用 RPC 通道：第三方可注册自己的逻辑通道（如 `/polling`），信任只有统一栅栏（loopback/trusted-host），无 allowlist，默认可达。不用 Typert Remote（生成器构建期静态装配）也不用 api-proxy 方法表（封闭） | packages/client/connection/src/rpc.ts:33-76, docs/api-gateway.md:76 |
| 独立构建（仓库外） | 自建 tsdown 配置，复制 client bundle 的 banner/footer/external 规则 | packages/client/tsdown.client.ts, packages/client/web/src/platform.ts |
| 安装分发 | bundle 格式（`dsh.bundle` + cordis.patch.yml），`dsh plugin add` | docs/user/develop/basic/publish.md |

## 3. 架构总览

```
dsh-polling（一个 npm 包，双面）
├── Host 半部分（Node，patch 行的主入口）
│   ├── src/index.ts         插件 apply：组装服务/调度器/工具/路由/工作区
│   ├── src/domain.ts        PollingTask 模型 + 校验（封闭错误码）
│   ├── src/cron.ts          纯函数 cron 解析器（5/6 段，next-after 计算）
│   ├── src/store.ts         任务注册表持久化（$DSH_HOME/polling/tasks.json，原子写）
│   ├── src/workspace.ts     轮询工作区 ensure/置顶/attachSession
│   ├── src/scheduler.ts     host 平面 timer owner（bounded timer + catch-up）
│   ├── src/tools.ts         polling_create/list/edit/delete/trigger 模型工具
│   └── src/routes.ts        ctx.connection.rpc 的 /polling 通道（client→host）
├── Client 半部分（浏览器，exports ./client + dsh.client 声明）
│   └── src/client/
│       ├── index.ts         注册 header actions 入口 + locale
│       ├── TaskAction.tsx   三点菜单项（仅任务会话显示）
│       ├── TaskEditor.tsx   任务要素编辑面板（modal/面板）
│       └── locales.ts       zh/en
├── cordis.patch.yml         插入 host 行 + client 行（dsh.client roster）
├── package.json             dsh.bundle + dsh.client + exports 映射
├── tsconfig.json
└── tsdown.config.ts         独立构建（node 半部分 + client bundle）
```

## 4. 任务模型（v1）

> **执行时间的用户模型 = 区间 + 频率 + 日期**（参照 Windows 任务计划程序的
> "每隔 N 分钟重复，持续到 Y"、n8n Schedule Trigger 的 interval 模式、
> GitHub Actions 惯例 `*/30 9-18 * * 1-5`）。UI 永远不显示原始 cron；
> `src/schedule.ts` 是纯函数双向映射（draft ↔ cron），可表达的 cron 子集：
> 分钟字段 `*` / `star/N`（60%N==0）/ 相位列表（如 `15,45`），小时字段 `*` /
> `star/N` / 连续区间 / 等差数列（小时步长），日字段 `*`，月字段 `*`，周字段任意
> 列表。落回子集之外的表达式 → `undefined` → UI 显示"自定义频率"并提示保存后重排。
>
> 已知固有近似：cron 小时字段是小时粒度的，`*/30 9-18` 会包含 18:30（所有基于
> cron 的调度器一致行为）；"下次执行"预览与摘要如实反映，不掩盖。

```ts
interface PollingTask {
  id: string                    // 任务 id（Branded<'PollingTaskId'>，创建时分配）
  sessionId: SessionId          // 任务会话 id（创建会话时分配）
  name: string                  // 任务名（也是会话标题）
  cron: string                  // 5/6 段 cron 表达式（调度模型的持久化形态）
  timeZone?: string             // IANA 时区（缺省 = 服务器本地时区）
  description: string           // 目标/要素描述（给模型看的背景）
  prompt: string                // 任务步骤描述（到点投递给模型的指令）
  provider?: string             // 模型供应商路由（缺省 = 部署默认）
  model?: string                // 模型 id（缺省 = 部署默认）
  enabled: boolean
  createdAt: string             // RFC 3339 UTC
  updatedAt: string
  lastRunAt?: string            // 最近一次触发
  lastRunOutcome?: 'ok' | 'failed' | 'aborted' | 'skipped'
  nextRunAt?: string            // 派生，随调度刷新
}

interface PollingTaskStore {
  version: 1
  tasks: PollingTask[]
}
```

持久化：`$DSH_HOME/polling/tasks.json`（原子写：写临时文件 + rename）。不依赖 storageDomain，任何组合（web/headless）都能跑。执行历史不在此文件——任务会话日志负责。

## 5. 调度器（host 平面）

```
startup: 读 store → 为每个 enabled 任务计算 nextRunAt → 取最早目标 arm bounded timer
timer 到点（或 catch-up 扫描）:
  → 对每个已到期任务（到期 = nextRunFor(lastRunAt ?? createdAt) <= now）:
      1. 若任务 agent 正在执行（live agent.status === 'running'）→ 跳过并记录
         outcome='skipped'（"不启动新实例"防重入，等价于 CronJob Forbid）
      2. 否则 ensureAgent(task):
           ctx.agents.get(sessionId) 存在 → 用之
           否则 ctx.agents.resume({ resumeSessionId, agentOptions, setup: mount preset })
           （resume 前用 persistence.inspect 确认存在；不存在则重建）
      3. 构造 UserMessage:
           content: 轮询执行框（当前时间/时区 + description + prompt）
           source: { kind: 'plugin', plugin: 'polling' }
      4. agent.followup(message)   // 空闲时开一轮
  → 重新 arm 下一个目标
守护:
  - timer delay 上限 MAX_TIMER_DELAY_MS（2^31-1），到点重读墙钟（照 schedule）
  - 到期判断锚定 lastRunAt ?? createdAt（nextCronMatch 严格返回 from 之后，
    不能用 now 作锚——那是历史 bug：自动触发永远不会到期）；
    错过多个目标时只补最近一次（照 schedule catch-up 语义）
  - 进程重启后从 store 恢复，直接补最近一次到期
  - 任务 agent 执行完不 dispose（与 web 会话行为一致，保持 idle 待命）；
    用户打开任务会话时经 api-proxy 的 ensureSession 复用同一 live agent
```

注意：**不**用 schedule 的 `agent.runMaintenance`（那是 session-local 的，要求 agent 活着并占 idle 相位）。轮询调度器在 host 平面独立跑 timer；到点通过 `followup()` 唤醒任务 agent 即可，无需抢 maintenance 相位（任务 agent 空闲时 followup 直接开一轮）。

## 6. 模型工具（注册在 global 层，任意会话可用）

- `polling_create(name, cron, prompt, description?, time_zone?, enabled?)` → 创建任务（含任务会话）
- `polling_list()` → 任务列表（含状态）
- `polling_edit(task_id, ...)` → 修改要素（cron/prompt/description/enabled/name）
- `polling_delete(task_id)` → 删除任务注册（会话保留为历史）
- `polling_trigger(task_id)` → 立即手动执行一次

创建流程（polling_create）：
1. `ensurePollingWorkspace()`：`$DSH_HOME/polling` 目录 + `workspaceRegistry.resolveByPath || create('轮询')`
2. 分配 `sessionId`（`randomUUID` branded）
3. `ctx.agents.create({ sessionId, agentOptions, meta: { cwd: pollingDir, agentPreset }, setup: (agentCtx) => agentPresets.mount(agentCtx, presetId) })`
   - presetId = 默认 preset（`agentPresets.resolve(undefined).id`），缺 roster 时只装 selection
4. `workspace.attachSession(sessionId)`
5. 写 store（task 记录）
6. 返回任务视图

删除流程：删 store 记录；会话保留（历史）。UI/工具均返回删除结果。

## 7. RPC 通道（client→host 通路）

`ctx.connection.rpc.handle('/polling', handler, { authority: 'loopback' })` 注册独立逻辑通道；client 侧 `ctx.connection.rpc.call('/polling', endpoint, payload)` 调用。handler 返回 `RpcResult<T>`（`{ok:true,value}` | `{ok:false,error}`）。Endpoint 约定：

- `tasks/list` → 任务列表
- `tasks/create` → 创建（payload = PollingTaskInput）
- `tasks/update` → 编辑（payload = { id, patch }）
- `tasks/delete` → 删除（payload = { id }）
- `tasks/trigger` → 立即执行（payload = { id }）
- `tasks/get` → 单任务详情（payload = { id }）

**任务会话识别（client 侧）**：不依赖 origin 标记。client 从 `tasks/list` 拿到 `sessionId → 任务` 映射并缓存，header action 组件按当前 `sessionId` 查映射决定是否渲染轮询入口。任务创建/删除后刷新缓存。

> 注：早期方案考虑过同源的 REST 路由（`GET /api/polling/tasks` 等），最终实现只采用上面的 RPC 通道——RPC 是 DSH 面向第三方插件的一等扩展点（`connection.rpc.handle`，loopback 权限），无需改动 host 的 any allowlist；本插件的 webServer 命名路由未实现。

## 8. Client 半部分

- 注册 `conversation.session.header.actions` 入口（order 在 subagent 之后），仅当 `sessionId ∈ 任务集合` 时渲染；任务集合来自 RPC `tasks/list`（缓存 + 变更后失效）。
- 菜单项：任务名 + 状态点 + "编辑任务/启用停用/立即执行/删除任务"。
- 编辑面板：ScheduleBuilder（执行日期 chips + 频率下拉 + 时间段/全天 + "下次执行"实时预览）+ 模型下拉 + description/prompt 文本域 + 启停开关 + 保存。
- 工作区本身不渲染新 UI（真实 workspace 由 ui-workspace 呈现）。
- 语言：zh/en locale namespace `polling`。

## 9. 分发（安装即用）

### 包结构

```
dsh-polling/
  package.json:
    name: "dsh-polling"
    dsh.bundle: { patch: "./cordis.patch.yml" }
    dsh.client: { inject: [...], platform: "web" }
    exports: { ".": host 入口, "./client": 浏览器 bundle, "./package.json" }
    files: [lib/index.js, lib/client.js, lib/types/**/*.d.ts, cordis.patch.yml]
  cordis.patch.yml:
    - insert:
        - id: polling
          name: dsh-polling            # host 半部分（node）
        - id: ui-polling
          name: dsh-polling            # 同一包；modules 扫描 dsh.client → 加载 ./client
```

### 用户安装（三选一）

```bash
dsh plugin --profile web add dsh-polling                 # npm 发布后
dsh plugin --profile web add github:cnyac/dsh-polling    # GitHub（prepare 自动构建 + 一次 allowBuilds 授权）
dsh plugin --profile web add ./dsh-polling-0.1.0.tgz     # pnpm pack 的 tarball
```

### 构建（发布侧）

- `tsdown` 双配置：node 半部分（esm, node platform）+ client 半部分（cjs, browser platform，复制 clientBundle 的 banner/footer/intro/external 规则）。
- 类型声明由 `tsc --emitDeclarationOnly` 生成到 `lib/types/`（tsdown 自身 dts 输出为压缩格式，不可用）。
- client externals = 平台模块表（react、@deepseek-ai/cordis、ui-slots、ui-primitives 等）+ `@deepseek-ai/dsh-client-runtime/client` 豁免；其余依赖 inline。
- `prepare` 脚本（`npm run build`）：npm publish 前与 GitHub 安装时自动构建（turtle-ui 模式）。

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| `connection.rpc` 通道名冲突 | 通道 `/polling` 是插件私有的逻辑通道；冲突时改挂其他名字，handler 由 disposer 管理 |
| `connection` 未组合（headless 无 web） | host 半部分对 connection 用 `ctx.get` 探测，无则跳过 RPC 注册（headless 仍可用模型工具） |
| `storageDomain` 不在组合里 | 任务存储用文件，不依赖 |
| 任务 agent 的 preset 解析 | create 时记录 agentPreset 到 header；resume 时用 `resolveSessionPreset(session)`（从 log 读） |
| followup 后任务 agent 忙碌（用户正在指挥） | followup 自动排队，不会打断当前轮 |
| 时区/DST | cron 按显式时区计算（缺省服务器本地）；DST gap 保守拒绝（照 schedule 模式） |

## 11. 里程碑与验证记录

1. ✅ cron 解析器（纯函数，16 项单测通过：解析/匹配/next-after/时区/DST gap）
2. ✅ host：store/workspace/scheduler/tools/routes 全部实现并通过 typecheck
3. ✅ client：header action + 编辑面板实现并通过 typecheck
4. ✅ cordis.patch.yml + tsdown 独立构建（lib/index.js + lib/client.js）
5. ✅ **真实环境端到端验证**（独立 DSH_HOME + 3099 端口 + `dsh plugin add` tarball 安装）：

| 验证项 | 结果 |
|---|---|
| `dsh plugin add dsh-polling-0.1.0.tgz` 安装 | ✅ bundle 追加到 profile |
| 服务启动、插件加载 | ✅ 无错误 |
| "轮询"工作区自动创建并置顶 | ✅ workspace.json 首条 |
| client bundle 被发现并注入 boot graph | ✅ index.html 含 dsh-polling，/plugins/dsh-polling/client.js 200 |
| RPC `/polling` 通道 | ✅ tasks/list 返回 `{ok:true,value:[]}` |
| 创建任务（含 agent 会话 + workspace attach） | ✅ sessionId 生成、workspace.sessionIds 更新、nextRunAt 正确（09:00 +8 → 01:00Z） |
| tasks.json 原子持久化 | ✅ |
| 编辑（cron/启停） | ✅ 更新生效、disabled 后 nextRunAt 消失 |
| 非法 cron / 未知 id | ✅ 稳定错误码 `invalid_cron` / `task_not_found` |
| 手动触发 | ✅ agent 恢复 + followup 投递，outcome ok |
| 删除任务 | ✅ 注册表清空、任务会话历史保留 |
| 重启恢复 | ✅ store 重读（测试实例多次重启无异常） |

**已知限制**：npm 上 `@deepseek-ai/*` 版本与当前仓库不同步，开发期用 tsconfig paths 指向仓库类型产物 + 宿主运行时提供依赖（peerDependencies 声明）；发布 npm 前需核对 peer 版本。
