# dsh-polling

轮询任务插件 —— DeepSeek Harness 的即插即用插件：**零上游改动**，一条命令安装。

> 轮询 = 一个真实工作区。轮询任务 = 工作区里的会话。到点时插件在任务自己的会话里唤醒模型，让模型自主执行你写好的任务步骤——一切模型能做的事都可以轮询：检查/处理文件、抓取网页、发送消息、邮件……

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

## 环境要求

- 已安装 `dsh` CLI（[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，Node.js `^22.19.0 || >=24.0.0`）
- 使用 Web 配置（`dsh web`）以获得完整体验；headless 下模型工具（`polling_*`）仍可用，Web 管理界面不可用

## 安装（任意 DeepSeek Harness 用户）

```bash
# 方式一：从 npm（推荐）
dsh plugin --profile web add dsh-polling

# 方式二：从 GitHub（需按提示允许一次构建）
dsh plugin --profile web add github:cnyac/dsh-polling

# 方式三：tarball
dsh plugin --profile web add ./dsh-polling-0.1.0.tgz
```

重启 `dsh web` 即可。卸载：`dsh plugin --profile web remove dsh-polling`。

> **关于方式二（GitHub 安装）**：git 安装拉取的是源码，`prepare` 脚本会自动完成构建；pnpm ≥10 默认拒绝执行 git 依赖的构建脚本，首次 `add` 会失败，`dsh` 会提示你把包键加进该 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 后重试。请只为源码可信的包授权，并建议锁定 commit（`github:cnyac/dsh-polling#<sha>`）。

## 使用

### 对话内自然语言创建

直接说，例如：

> 帮我建一个轮询任务：每天上午 9 点检查 `D:\稿件\待处理` 文件夹，有新的新闻稿件就用常规流程润色修改并归档。

插件会通过 `polling_create` 工具自动创建任务，任务作为一个新会话出现在侧边栏 **轮询** 工作区（自动置顶）。

### Web 前端管理

- 侧边栏 **轮询** 工作区：展开/收起、查看任务会话、点击进入对话（可主动发消息指挥任务）
- 任务会话头部右侧 **三点菜单 → 轮询任务**：编辑任务要素（名称 / 执行时间 / 目标描述 / 任务步骤）、立即执行、启停、删除
- 设置 → 插件 → 插件配置 → **轮询任务** 卡片：完整的任务管理页（新建 / 列表 / 编辑 / 立即执行 / 启停 / 删除）

## 任务要素

| 要素 | 说明 |
|---|---|
| 执行时间 | **执行日期**（每天 / 工作日 / 周末 / 自定义周几）× **频率**（每 N 分钟 / 每小时）× **时间段**（HH:MM–HH:MM 或全天），另附"下次执行"实时预览 |
| 模型 | 可选模型（从已配置的 API 枚举）；缺省为部署默认 |
| 目标描述 | 给模型的背景上下文（可选） |
| 任务步骤 | 自然语言指令；到点时模型在任务会话里自主执行 |
| 启用 | 开关；停用后不再触发 |

> 内部以标准 5 段 cron 持久化（如 `*/30 9-18 * * 1-5` = 工作日 09:00–18:00 每 30 分钟），UI 从不显示原始表达式。任务执行中再次到点会**跳过并记录**（防重入，不堆积）。重启后自动补最近一次到期。

## 费用与安全提醒

- **每次触发都会发起一次模型调用**（在任务自己的会话里），轮询频率越高消耗越大；请按需设置频率和时间段。
- 任务步骤由模型**自主执行**（可调用 shell、文件、网络等一切已授权工具），与手动对话使用相同的权限体系——只给任务写它该做的事。
- 任务注册表（`tasks.json`）与任务会话历史均保存在你的本机 `$DSH_HOME` 下，插件不向任何外部服务上报数据。

## 工作方式（简要）

- **调度**：host 平面 timer owner（不依赖任何会话存活）。到点 → 恢复任务会话的 agent → `followup(任务指令)` 在任务会话里执行。到期判断锚定上次执行时刻：错过多次只补最近一次，重启后同样只补一次。
- **防重入**：任务会话的 agent 仍在执行时到点 → 跳过本次并记录 `skipped`（等价于任务计划程序的"不启动新实例"），避免指令堆积。
- **归档恢复**：任务会话被归档（隐藏）后，下次触发（到点或"立即执行"）会自动为任务**新建一个会话**继续跑，旧会话保留为归档历史。
- **静默执行**：执行发生在任务自己的会话里，不打扰其他会话；过程与结果就是该会话的对话记录。
- **存储**：任务注册表在 `<dshHome>/polling/tasks.json`（原子写）；执行历史在任务会话日志里（DSH 自带持久化）。
- **模型工具**：`polling_create / polling_list / polling_edit / polling_delete / polling_trigger` 注册在全局工具层，任何 preset 的会话都可见。
- **Web 数据通路**：`ctx.connection.rpc` 的 `/polling` 通道（第三方通道是 DSH 的一等扩展点）。
- **分发**：标准 bundle 格式（`dsh.bundle` + `cordis.patch.yml`），双面（host 调度 + client UI）单包。

## 配置（`cordis.patch.yml` 可覆盖）

```yaml
- id: polling
  name: dsh-polling
  config:
    dir: 'D:\MyPolling'   # 轮询目录（缺省 <dshHome>/polling；示例为覆盖场景）
    keepPinned: true      # 是否强制置顶（缺省 false，创建时置顶一次）
```

## 开发

```bash
npm install --legacy-peer-deps   # 仅构建工具；运行时依赖由 DSH 宿主提供
npm run typecheck
npm test                         # cron 解析器单测
npm run build                    # lib/index.js + lib/client.js + lib/types/（含 client bundle 冒烟验证）
npm pack                         # 产出可分发的 tarball
```

设计文档见 [DESIGN.md](DESIGN.md)。

## 许可证

[MIT](LICENSE)
