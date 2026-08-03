# claude-release-radar

盯着 Claude Code CLI 与 Agent SDK 的发版，出新版就开一个 issue —— GitHub 会把它发成邮件。

## 它监控什么

| 包 | 是什么 | 盯的 dist-tag |
| --- | --- | --- |
| [`@anthropic-ai/claude-code`](https://www.npmjs.com/package/@anthropic-ai/claude-code) | Claude Code CLI | `latest` · `stable` · `next` |
| [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) | Agent SDK | `latest` · `next` |

CLI 单独有一条 `stable` 线，通常落后 `latest` 若干个版本（建库时实测 `latest`=2.1.220、
`stable`=2.1.212），所以单独盯。

**只报上游发布事件**。radar 不知道、也不去读任何项目钉了哪个版本，因此没有"落后/追平"状态 ——
要不要升级、什么时候升级，看到邮件自己判断。

## 一个有用的观察

CLI 的 `2.1.N` 与 SDK 的 `0.3.N` 是同一条发版流水线产出的：建库时采样 201/205/210/215/220
五个点、跨度 3 周，**SDK 每次都比 CLI 早 2 秒发布，patch 号严格配对**。

所以 issue 里会附一行配对检查。看到 `⚠️ patch 号不配对`，说明上游这次没同步发版 ——
混用两边时值得先确认兼容性。

## 怎么跑

```bash
node scripts/radar.js          # 查一次，更新 state.json，有变化则写 issue-body.md
node --test 'tests/*.test.mjs' # 单测（不打网络）
```

首次运行只会把当前版本记进 `state.json` 并静默退出 —— 不会把"当前所有版本"报成一堆新发布。

## 工作方式

`.github/workflows/radar.yml` 每天 01:17 UTC 跑一次（也可手动 `workflow_dispatch`）：

```
查 npm registry → 与 state.json 比对 → 有变化就开 issue → 把新版本提交回 state.json
```

`state.json` 的 git history 因此就是一份可查的发布时间线。

零依赖：Node 内置 `fetch`，runner 自带 `gh`，仓库不装任何 npm 包，也没有 lockfile。

## 收不到邮件？

issue 由 `github-actions[bot]` 开出，要收到邮件需要你 watch 本仓库且开启了邮件通知：
**Settings → Notifications → Subscriptions → Watching** 勾上 email。

先手动触发一次 workflow 验证整条链路，别等到真有新版时才发现没收到。
