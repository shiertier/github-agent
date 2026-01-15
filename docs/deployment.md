# 部署指南

## 快速开始

在你的仓库中创建 `.github/workflows/github-agent.yml`：

```yaml
name: GitHub Agent

on:
  issues:
    types: [opened, edited, reopened]
  issue_comment:
    types: [created]
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: write
  issues: write
  pull-requests: write

jobs:
  agent:
    runs-on: ubuntu-latest
    if: github.actor != 'dependabot[bot]'
    steps:
      - uses: actions/checkout@v4

      - uses: your-org/github-agent@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
```

## 配置选项

| 输入参数         | 必填 | 默认值     | 说明                   |
| ---------------- | ---- | ---------- | ---------------------- |
| `github_token`   | ✅   | -          | GitHub API Token       |
| `openai_api_key` | ✅   | -          | OpenAI API Key（同时导出为 `CODEX_API_KEY`） |
| `opencode_bin`   | ❌   | `codex`    | OpenCode/Codex CLI 可执行文件（`opencode` 或 `codex`） |
| `max_rounds`     | ❌   | `3`        | 每个 Issue/PR 最大轮数 |

## 前置要求

### 1. OpenCode/Codex CLI

Action 运行时会根据 `opencode_bin`（`codex`/`opencode`）自动安装对应 CLI。
默认使用 `codex`，如需使用 `opencode`，请在 `opencode_bin` 中显式设置。
如需离线或自托管环境，可提前安装并确保在 PATH 中可用。

### 2. GitHub Token

使用默认的 `GITHUB_TOKEN` 即可，需要以下权限：

# 防止无限递归

concurrency:
group: agent-${{ github.event.issue.number || github.event.pull_request.number }}
cancel-in-progress: false

permissions:
contents: write
pull-requests: write
issues: write

jobs:
agent: # 关键：忽略 bot 触发的事件
if: |
github.actor != 'github-actions[bot]' &&
github.actor != 'dependabot[bot]' &&
(github.event_name != 'issue_comment' || !endsWith(github.actor, '[bot]'))

    runs-on: ubuntu-latest

    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0 # 完整历史，支持 rebase 等操作
          token: ${{ secrets.GITHUB_TOKEN }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Install Codex CLI
        run: npm install -g @openai/codex
      # If you prefer OpenCode:
      # - name: Install OpenCode CLI
      #   run: curl -fsSL https://raw.githubusercontent.com/opencode-ai/opencode/refs/heads/main/install | bash

      - name: Install Agent Dependencies
        run: |
          cd .github/agent
          npm ci
          npm run build

      - name: Run Agent
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        run: |
          node .github/agent/dist/main.js

```

### Step 2: 添加 Agent 代码

在你的仓库中创建 `.github/agent/` 目录，包含以下文件：

```

.github/
└── agent/
├── package.json
├── tsconfig.json
└── src/
├── main.ts
├── prompts/
└── utils/

````

参考 [实现规范](./implementation.md) 中的代码。

### Step 3: 配置 Secrets

在仓库的 Settings → Secrets and variables → Actions 中添加：

| Secret 名称      | 描述                   | 必需 |
| :--------------- | :--------------------- | :--- |
| `OPENAI_API_KEY` | OpenAI API 密钥        | 是   |
| `GITHUB_TOKEN`   | 自动提供，无需手动配置 | 自动 |

### Step 4: 配置分支保护（重要！）

为了防止 Agent 意外破坏主分支，请在 Settings → Branches 中配置：

1. 添加分支保护规则 for `main` / `master`
2. 勾选 "Require a pull request before merging"
3. 勾选 "Require approvals" (至少 1 个)
4. 勾选 "Require review from Code Owners" (可选)

## 高级配置

### Reviewer/Coder 分工

如果需要 Reviewer 与 Coder 的交接闭环，可添加如下约定：

1. PR 打上 `ai-pr` 与 `ai-review-needed` 时触发 Reviewer。
2. Reviewer 在评论中使用 `/review_done` 交接给 Coder。

在 workflow 中设置 `AGENT_MODE` 供 prompt 构建使用：

```yaml
  pull_request:
    types: [opened, synchronize, labeled]

  issue_comment:
    types: [created]

jobs:
  agent:
    steps:
      - name: Decide Agent Mode
        id: decide-mode
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          EVENT="${{ github.event_name }}"
          MODE="reviewer"

          if [[ "$EVENT" == "issue_comment" ]]; then
            MODE="coder"
            COMMENT_BODY="${{ github.event.comment.body }}"
            if [[ "$COMMENT_BODY" == *"/request_review"* ]]; then
              MODE="reviewer"
            elif [[ "$COMMENT_BODY" == *"/review_done"* ]]; then
              MODE="coder"
            fi
          fi

          if [[ "$EVENT" == "pull_request" ]]; then
            PR_NUMBER="${{ github.event.pull_request.number }}"
            LABELS=$(gh api "repos/${{ github.repository }}/issues/${PR_NUMBER}/labels" --jq '.[].name' 2>/dev/null || true)
            if echo "$LABELS" | grep -q "^ai-pr$" && echo "$LABELS" | grep -q "^ai-review-needed$"; then
              MODE="reviewer"
            fi
          fi

          echo "mode=$MODE" >> $GITHUB_OUTPUT

      - name: Run Agent
        env:
          AGENT_MODE: ${{ steps.decide-mode.outputs.mode }}
        run: |
          node .github/agent/dist/main.js
````

### 使用自定义 Token

如果默认的 `GITHUB_TOKEN` 权限不足，可以使用 Personal Access Token (PAT)：

1. 创建一个 Fine-grained PAT，勾选：

   - Contents: Read and write
   - Issues: Read and write
   - Pull requests: Read and write

2. 将 PAT 添加为 Secret（例如 `AGENT_PAT`）

3. 修改 workflow：

```yaml
- name: Checkout Repository
  uses: actions/checkout@v4
  with:
    token: ${{ secrets.AGENT_PAT }}

- name: Run Agent
  env:
    GITHUB_TOKEN: ${{ secrets.AGENT_PAT }}
    GH_TOKEN: ${{ secrets.AGENT_PAT }}
```

### 限制触发条件

只在特定标签的 Issue 上运行：

```yaml
jobs:
  agent:
    if: |
      github.event_name == 'issues' &&
      contains(github.event.issue.labels.*.name, 'agent-task')
```

只处理特定用户的请求：

```yaml
jobs:
  agent:
    if: |
      github.actor == 'your-username' ||
      contains(github.event.issue.body, '/agent')
```

### 多环境配置

开发环境使用不同的 API：

```yaml
env:
  OPENAI_API_KEY: ${{ github.ref == 'refs/heads/main' && secrets.OPENAI_API_KEY_PROD || secrets.OPENAI_API_KEY_DEV }}
```

### 超时和重试配置

```yaml
jobs:
  agent:
    timeout-minutes: 30 # Agent 最多运行 30 分钟

    steps:
      - name: Run Agent
        timeout-minutes: 25
        continue-on-error: false
        run: node .github/agent/dist/main.js
```

## 调试和故障排除

### 查看 Agent 日志

在 GitHub Actions 的运行记录中查看详细日志。

### 本地测试

```bash
# 设置环境变量
export GITHUB_TOKEN="your-token"
export GH_TOKEN="your-token"
export OPENAI_API_KEY="your-key"

# 模拟运行
cd your-repo
node .github/agent/dist/main.js
```

### 常见问题

#### Q: Agent 创建的 PR 无法触发其他 Actions

**A**: 这是 GitHub 的安全限制。使用 PAT 替代 `GITHUB_TOKEN` 可以解决。

#### Q: Agent 无法推送到受保护分支

**A**: 这是预期行为！Agent 应该只创建 PR，不应该直接推送到主分支。

#### Q: Agent 无限循环

**A**: 检查 workflow 的 `if` 条件是否正确过滤了 bot 触发的事件。

#### Q: OpenCode/Codex 命令失败

**A**: 检查 API 密钥是否正确配置，以及网络是否可以访问 OpenAI API。

## 监控和告警

### 添加失败通知

```yaml
- name: Notify on Failure
  if: failure()
  uses: actions/github-script@v7
  with:
    script: |
      github.rest.issues.createComment({
        issue_number: context.issue.number,
        owner: context.repo.owner,
        repo: context.repo.repo,
        body: '❌ Agent encountered an error. Please check the [workflow logs](${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}).'
      })
```

### 使用 Slack 通知

```yaml
- name: Slack Notification
  if: always()
  uses: 8398a7/action-slack@v3
  with:
    status: ${{ job.status }}
    fields: repo,message,commit,author
  env:
    SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK }}
```
