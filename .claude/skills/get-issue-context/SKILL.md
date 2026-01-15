---
name: get-issue-context
description: 获取 GitHub Issue 完整上下文。当需要分析、回复或处理 Issue 时使用。
allowed-tools: Bash(gh:*), Bash(curl:*), Bash(jq:*)
---

# Get Issue Context

获取当前仓库指定 Issue 的完整上下文信息。

## 使用方法

当需要获取 Issue 上下文时，执行以下命令：

```bash
# 获取 Issue 基本信息
gh api repos/${GITHUB_REPOSITORY}/issues/${ISSUE_NUMBER}

# 获取 Issue 评论
gh api repos/${GITHUB_REPOSITORY}/issues/${ISSUE_NUMBER}/comments
```

其中 `GITHUB_REPOSITORY` 格式为 `owner/repo`，`ISSUE_NUMBER` 为 Issue 编号。

## 需要提取的信息

从 API 响应中提取以下关键信息：

### Issue 元信息

- `title` - 标题
- `user.login` - 作者
- `state` - 状态 (open/closed)
- `labels[].name` - 标签列表
- `created_at` - 创建时间
- `body` - 正文内容

### 评论信息

对于每条评论：

- `user.login` - 评论作者
- `created_at` - 评论时间
- `body` - 评论内容

## 输出格式

整理为易于理解的 Markdown 格式：

```markdown
# Issue Context

- Repository: owner/repo
- Number: #123
- Author: @username
- State: open
- Labels: bug, enhancement

## Title

Issue 标题

## Body

Issue 正文内容

## Comments

### Comment 1

- Author: @commenter
- Created: 2024-01-01

评论内容...
```
