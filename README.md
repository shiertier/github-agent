# GitHub Autonomous Agent (GAA)

<p align="center">
  <strong>🤖 无状态 · 极简 · 自包含的 GitHub 智能代码助手</strong>
</p>

<p align="center">
  基于 GitHub Actions + OpenCode/Codex 构建的自主开发者 Agent
</p>

---

## ✨ 特性

- **🚀 Issue 自动处理** - 阅读 Issue → 分析问题 → 写代码 → 提 PR
- **👀 智能 PR Review** - 自动分析代码变更，给出专业审查意见
- **🔄 交互式修改** - 通过 `/update_pr` 命令让 Agent 修改代码
- **🔧 零服务器** - 完全运行在 GitHub Actions，无需维护基础设施

## 📖 文档

完整文档请参阅 [docs/](./docs/) 目录：

- [📋 项目概述](./docs/README.md)
- [🏗️ 架构设计](./docs/architecture.md)
- [💻 实现规范](./docs/implementation.md)
- [🚀 部署指南](./docs/deployment.md)
- [⌨️ 命令参考](./docs/commands.md)

## 🚀 快速开始

### 1. 添加 Workflow

创建 `.github/workflows/agent.yml`：

```yaml
name: GitHub Agent

on:
  issues:
    types: [opened]
  pull_request:
    types: [opened, synchronize]
  issue_comment:
    types: [created]

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  agent:
    if: |
      github.actor != 'github-actions[bot]' &&
      github.actor != 'dependabot[bot]' &&
      (github.event_name != 'issue_comment' || !endsWith(github.actor, '[bot]'))
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: shiertier/github-agent@main
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          # openai_api_base: ${{ secrets.OPENAI_API_BASE }}
          # model_name: gpt-5.2
          # model_reasoning_effort: xhigh
          # disable_response_storage: "true"
          # opencode_bin: opencode
```

> 默认使用 `codex` 并在运行时自动安装；如需 `opencode`，在 `with` 中设置 `opencode_bin: opencode`。

### 2. 配置 Secrets

在仓库设置中添加：
- `OPENAI_API_KEY`
- （可选）`OPENAI_API_BASE`（自建/代理 endpoint 时使用）

> 注：Action 版本仍在开发中。如需立即使用，请参考部署指南的自托管方式。

### 3. 开始使用

- 创建一个 Issue 描述 bug 或功能需求
- Agent 会自动分析并（可选）创建 PR 来解决问题
- 在 Issue/PR 评论中使用 `@coder ...` 可手动触发 Coder
- 使用 `/reset` 重置循环轮数

## 💬 命令列表

| 命令     | 描述                              |
| :------- | :-------------------------------- |
| _(自动)_ | Issue/PR 事件触发 Agent           |
| `@coder` | 在评论中触发 Coder（Issue/PR 通用） |
| `/reset` | 重置循环轮数                      |

## 🏷️ PR 标签约定

| 标签               | 作用                               |
| :----------------- | :--------------------------------- |
| `ai-pr`            | 标记 PR 为 Agent 创建              |
| `ai-review-needed` | 需要 Reviewer Agent 进行审查       |
| `ai-review-done`   | Reviewer 已完成审查，待 Coder 处理 |

## 🔒 安全性

- **分支保护**: Agent 无法直接推送到受保护分支
- **人工审核**: 所有 PR 都需要人工 Review
- **Actor 过滤**: 自动忽略 bot 触发的事件，防止无限循环

## 📄 License

MIT License
