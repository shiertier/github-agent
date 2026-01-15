# GitHub Autonomous Agent (GAA)

> 一个无状态、极简、自包含的 GitHub 智能体

## 核心愿景

**拒绝过度封装。拒绝中间人。**

传统方案（如 qodo-ai/pr-agent）采用企业级思维：建立中间服务，通过 API 接收 Webhook，处理逻辑，再回调 GitHub。这引入了服务器维护成本、延迟和复杂配置。

我们的方案遵循 **Linux 哲学**：

- **Small tools**: 使用 `git`, `gh-cli`, `opencode/codex` 这些现成的小工具
- **Pipe**: 使用 GitHub Actions 将它们串联
- **Stateless**: 每次运行都是一个新的沙盒，用完即焚

**Agent 不仅仅是文本生成器，它是拥有 Shell 权限的虚拟开发者。**

## 核心能力

| 触发场景          | 触发条件                           | Agent 行为                                          |
| :---------------- | :--------------------------------- | :-------------------------------------------------- |
| **Issue 处理**    | Issue 创建                         | 阅读 Issue → 分析问题 → 写代码 → 提 PR → 回复 Issue |
| **PR Review**     | PR 创建/更新（含 Agent 创建的 PR） | 阅读 Diff → 生成 Review → 更新 PR 描述 → 发表评论   |
| **PR 更新**       | `/update_pr` 评论                  | 基于反馈修改代码 → Push 更新                        |
| **PR 新分支更新** | `/update_pr_new` 评论              | 创建新分支 → 修复代码 → 提新 PR                     |
| **重新 Review**   | `/rereview` 评论                   | 重新执行 Review 流程                                |
| **Review 交接**   | `/request_review` / `/review_done` | Reviewer 审查 → 交接给 Coder 继续迭代               |

## 快速开始

### 前置要求

- 安装 [opencode/codex](https://github.com/opencode-ai/opencode) CLI
- 配置 GitHub Token（需要 repo 完整权限）

### 安装

1. Action 版本在开发中（计划发布为 `shiertier/github-agent@main`）
2. 当前请按部署指南使用自托管方式
3. 配置必要的 Secrets 后开始使用

详细步骤请参考 [部署指南](./deployment.md)。

## 文档目录

- [架构设计](./architecture.md) - 系统架构和设计哲学
- [实现规范](./implementation.md) - 详细的实现细节
- [部署指南](./deployment.md) - 如何部署和配置
- [命令参考](./commands.md) - 支持的命令和用法

## 与 pr-agent 对比

| 特性         | qodo pr-agent               | GAA                    |
| :----------- | :-------------------------- | :--------------------- |
| **运行模式** | Docker / 独立服务           | GitHub Action 原生     |
| **Git 操作** | 通过 API 模拟               | 直接执行 Git 命令      |
| **交互方式** | 评论区聊天                  | 全能力（可直接改代码） |
| **复杂度**   | 高（Web Server, DB, Queue） | 低（TS 脚本 + CLI）    |
| **维护成本** | 需维护服务器                | 无，Actions 自动运行   |

## 许可证

MIT License
