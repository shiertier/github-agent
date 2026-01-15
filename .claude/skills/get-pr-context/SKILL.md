---
name: get-pr-context
description: 获取 GitHub PR 完整上下文。当需要审查、修复或讨论 PR 时使用。
allowed-tools: Bash(gh:*), Bash(curl:*), Bash(jq:*), Bash(git:*)
---

# Get PR Context

获取当前仓库指定 Pull Request 的完整上下文信息。

## 使用方法

当需要获取 PR 上下文时，执行以下命令：

```bash
# 获取 PR 基本信息
gh api repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}

# 获取 PR Diff
gh api repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER} -H "Accept: application/vnd.github.v3.diff"

# 获取 Issue 评论（普通评论）
gh api repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments

# 获取 Review 评论（代码行评论）
gh api repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/comments
```

其中 `GITHUB_REPOSITORY` 格式为 `owner/repo`，`PR_NUMBER` 为 PR 编号。

## 需要提取的信息

### PR 元信息

- `title` - 标题
- `user.login` - 作者
- `state` - 状态
- `base.ref` - 目标分支
- `head.ref` - 源分支
- `additions` - 添加行数
- `deletions` - 删除行数
- `changed_files` - 变更文件数
- `body` - 描述

### Diff 内容

完整的代码变更 diff。

### 评论信息

Issue 评论和 Review 评论，包含：

- `user.login` - 作者
- `body` - 内容
- `path` (Review 评论) - 文件路径
- `line` (Review 评论) - 行号

## 输出格式

整理为易于理解的 Markdown 格式：

````markdown
# PR Context

- Repository: owner/repo
- Number: #42
- Author: @username
- State: open
- Base: main
- Head: feat/new-feature
- Changes: 10 files, +200, -50

## Title

PR 标题

## Body

PR 描述

## Diff

```diff
变更内容
```
````

## Comments

评论列表...

```

```
