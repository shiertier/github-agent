# 命令参考

## 概述

GitHub Agent 通过事件自动触发，无需手动命令。唯一的例外是 `/reset` 命令用于重置循环轮数。

## 自动触发

| 事件         | 触发条件                           | Agent 行为                                |
| ------------ | ---------------------------------- | ----------------------------------------- |
| Issue 创建   | `issues.opened`                    | Issue Chatter 分析 → 可能触发 Issue Coder |
| Issue 评论   | `issue_comment.created` + `@coder` | Issue Coder 开发                          |
| PR 创建/更新 | `pull_request.opened/synchronize`  | PR Reviewer 审查 → 可能触发 PR Coder      |
| PR 评论      | `issue_comment.created` + `@coder` | PR Coder 修复                             |

## 手动命令

| 命令     | 描述                                  | 示例     |
| -------- | ------------------------------------- | -------- |
| `/reset` | 重置循环轮数，允许 Agent 继续自动处理 | `/reset` |

当 Agent 达到最大自动循环轮数（默认 3 轮）时会停止。使用 `/reset` 可以重置计数，让 Agent 继续工作。

## PR 标签约定

| 标签    | 作用                  |
| ------- | --------------------- |
| `ai-pr` | 标记 PR 为 Agent 创建 |

---

## 完整工作流示例

```
1. 用户创建 Issue
   → Issue Chatter 分析问题
   → 判断需要开发，触发 Issue Coder

2. Issue Coder 创建 PR
   → 自动标记 ai-pr
   → 触发 PR Reviewer

3. PR Reviewer 审查
   → 发现问题，触发 PR Coder

4. PR Coder 修复问题
   → Push 更新
   → 再次触发 PR Reviewer（第 2 轮）

5. PR Reviewer 通过
   → Approve PR
   → 等待人工合并
```

---

## 注意事项

### 权限要求

- Agent 使用配置的 `GITHUB_TOKEN` 执行操作
- 需要 `contents:write`, `issues:write`, `pull-requests:write` 权限

### 循环控制

- Agent 最多自动循环 3 轮
- 达到上限后会停止并提示使用 `/reset`
- 每个 Agent 评论都包含隐藏的轮数标记

### 最佳实践

1. **保持分支保护**：始终要求人工 Review Agent 的 PR
2. **监控日志**：检查 Actions 日志确保正常运行
3. **明确需求**：Issue 描述越清晰，Agent 执行越准确
