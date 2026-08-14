# dsh-polling

**给你的 DeepSeek Harness 装一个"到点自己干活"的定时助手。** 对它说一句"每天上午 9 点检查稿件文件夹"，剩下的交给模型按时完成。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

## 它能干什么

- **定时检查**：盯文件夹、盯网页，有新东西就处理、汇报
- **定时产出**：抓数据、写日报/周报、整理归档
- **定时跑腿**：发消息、跑脚本……一切你愿意交代给模型的重复活儿

任务执行很安静：在它自己的会话里进行，不会打断你正在聊的天；过程和结果就是那段对话记录，随时打开看看，还能插句话指挥它。

## 安装

需要先装好 `dsh` CLI 并运行过 `dsh web`。然后一条命令：

```bash
dsh plugin --profile web add dsh-polling
```

重启 `dsh web`，侧边栏就会出现「轮询」工作区。

> 也可以从 GitHub 安装（`dsh plugin --profile web add github:cnyac/dsh-polling`）或本地 tarball 安装。GitHub 方式第一次会提示你"允许构建"，按提示确认一次即可。

## 开始用

最简单的开始——直接对它说：

> 帮我建个轮询任务：每个工作日早上 9 点检查 `D:\稿件\待处理`，有新稿件就按常规流程润色归档。

它会在「轮询」工作区建一个任务会话，到点自动开跑。想改时间、暂停、删除？两个入口都行：

- **侧边栏「轮询」工作区** → 点进任务会话 → 右上角三点菜单 → **轮询任务**
- **设置 → 插件 → 插件配置 →「轮询任务」卡片**：完整管理页，新建 / 列表 / 编辑 / 立即执行 / 启停 / 删除

## 一个任务由什么组成

| 要素 | 说明 |
|---|---|
| **执行时间** | 哪几天（每天 / 工作日 / 周末 / 自定义）+ 多频繁（每 N 分钟 / 每小时）+ 几点到几点；选的时候有"下次执行"实时预览 |
| **模型** | 用哪个模型跑这个任务；不选就用你的默认配置 |
| **目标描述** | 给任务一个大背景（可选，比如"这是给客户看的日报"） |
| **任务步骤** | 到点后要它做什么，用大白话写清楚 |
| **启用** | 关掉就不触发，随时可以再开 |

## 你会注意到的几个贴心行为

- 上一个任务还在跑、又到点了 → 这次**跳过**，不会堆一堆指令排队执行
- 电脑关机错过时间 → 下次启动**补跑最近一次**
- 任务会话被你归档了 → 下次触发自动开个**新会话**继续，旧会话留在归档里当历史
- 任务名会固定成会话标题，不会被模型自动改名

## 费用与安全

- **每次触发 = 一次模型调用**，任务越频繁花得越多——按需设置频率就好
- 任务由模型**自主执行**，权限和手动对话一致——只给它写它该做的事
- 任务数据全在你本机（`$DSH_HOME` 下），插件不向任何外部服务上报

## 常见问题

**装完没看到「轮询」工作区？**
重启 `dsh web` 试试；新建第一个任务时工作区也会自动创建。

**任务没按点跑？**
先看三处：任务是否处于"启用"、时间段是否覆盖当前时刻、编辑面板里"下次执行"显示什么。还有问题就来 [Issues](https://github.com/cnyac/dsh-polling/issues) 找我。

**删了任务，历史会没吗？**
不会。任务会话和对话记录都会保留，只是不再触发。

**想折腾配置？**
进阶配置（自定义数据目录、强制置顶）见下方折叠内容。

<details>
<summary>进阶：自定义配置</summary>

在 profile 的 `cordis.patch.yml` 里覆盖插件行即可（一般用不上）：

```yaml
- id: polling
  name: dsh-polling
  config:
    dir: 'D:\MyPolling'   # 轮询数据目录（默认 <dshHome>/polling）
    keepPinned: true      # 是否一直把「轮询」工作区钉在侧边栏顶部（默认 false）
```
</details>

## 开发

```bash
npm install --legacy-peer-deps   # 只需构建工具；运行时代码由 dsh 宿主提供
npm run typecheck
npm test                         # cron 解析与调度模型单测
npm run build
npm pack                         # 产出可分发的 tarball
```

设计文档见 [DESIGN.md](DESIGN.md)。有问题或想法，欢迎在 [Issues](https://github.com/cnyac/dsh-polling/issues) 或[官方社区帖子](https://github.com/deepseek-ai/deepseek-harness/discussions/1006)里聊。

## 许可证

[MIT](LICENSE)
