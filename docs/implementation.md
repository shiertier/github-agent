# 实现规范

## 项目结构

```
github-agent/
├── src/
│   └── main.ts                      # TypeScript 引导程序
├── prompts/                         # Prompt 模板目录
│   ├── issue-chatter.md             # Issue 分析 Prompt
│   ├── issue-coder.md               # Issue 开发 Prompt
│   ├── pr-reviewer.md               # PR 审查 Prompt
│   └── pr-coder.md                  # PR 修复 Prompt
├── docs/                            # 文档目录
├── examples/                        # 示例 workflow 和配置
├── dist/                            # 编译产物（自动生成，勿手改）
├── action.yml                       # GitHub Action 定义
├── package.json
├── tsconfig.json
└── README.md
```

## 事件处理

我们只关心三类事件，其他一概忽略：

| 事件类型  | 触发条件                           | 意图 (Intent)   | 预期行为                     |
| :-------- | :--------------------------------- | :-------------- | :--------------------------- |
| **Issue** | `opened`                           | **Fix/Feature** | 阅读 Issue → 写代码 → 提 PR  |
| **PR**    | `opened`, `synchronize`            | **Review**      | 阅读 Diff → 提交 Review 意见 |
| **评论**  | `issue_comment.created` + `@coder` | **Coder 触发**  | 切分支 → 改代码 → Push 更新  |

> **注意**：当前实现通过 `@coder` 关键词触发 Coder 模式。`/reset` 命令用于重置循环轮数。

## Reviewer/Coder 交接规则

为支持 AI 创建 PR 的审查闭环，约定以下标签：

- `ai-pr`: PR 由 Agent 创建
- `ai-review-needed`: 需要 Reviewer Agent 审查
- `ai-review-done`: Reviewer 已完成审查，交接给 Coder

行为约定：

1. PR 带 `ai-pr` 且 `ai-review-needed` 时，触发 Reviewer Agent。
2. Reviewer 必须在评论中写明问题/建议，并附带 `/review_done`（或设置 `ai-review-done`）。
3. Coder 在处理时读取最新 Reviewer 评论，按建议修改代码后再次请求 Review。

## PR Reviewer 输出格式

Reviewer 的 Review 评论必须在开头包含 PR Change Description 区块，标题与结构固定，顺序不可变：

- `### **PR Type**`
- `### **Description**`
- `### Diagram Walkthrough`（必须使用 Mermaid 代码块，空内容写 `N/A`）
- `### File Walkthrough`（无关键文件写 `N/A`，否则使用固定的 `details + table` 模板）

## 分支命名规则

分支名统一以 `ai-<type>/` 开头，包含对象与描述：

- Bug 修复: `ai-fix/issue-<id>-<short-description>`
- 新功能: `ai-feat/issue-<id>-<short-description>`
- 重构: `ai-refactor/issue-<id>-<short-description>`
- PR 修复: `ai-fix/<pr-branch-name>` (基于用户 PR 分支创建)
- Reviewer：不创建分支（只读审查）

示例：

- `ai-fix/issue-42-race-condition`
- `ai-feat/issue-123-add-logging`
- `ai-fix/feat-user-login` (修复用户 PR `feat/user-login`)

## System Prompt 规范

建议使用统一的 System Prompt，并根据模式切换约束：

```
You are GitHub Agent.
Follow the repository rules and event intent strictly.

Mode:
- reviewer: only review and comment, do not modify code.
- coder: modify code, create/update PRs, and comment with results.
- chatter: read-only, triage issue/PR questions, reply once, may @coder to trigger development.
- chat: read-only, no code changes, single comment reply.

Output:
- reviewer outputs three artifacts: review-summary.md, review-findings.md, review-tests.md.
- coder outputs one completion comment.
- chatter outputs one reply comment.
- chat outputs one reply comment.
```

## Context 构建逻辑

按照事件类型构建上下文，确保 Chat 只读但具备必要信息：

1. Issue 事件：

   - Issue 标题/正文/标签
   - 仓库目录结构（只读）
   - 相关文件内容（只读）

2. PR 事件：

   - PR 标题/正文
   - Diff/变更文件列表
   - 最近的 Review 评论

3. PR 评论事件：

   - 评论内容（命令或普通聊天）
   - 相关 PR/Issue 的标题与正文
   - 最近 N 条评论（热 view）
   - 如为 Chat，仅允许读取，不执行写操作

4. Issue 评论事件（Chatter）：
   - Issue 标题/正文/标签
   - 评论内容（最新一条）
   - 仓库目录结构（只读）
   - 相关文件内容（只读）

Chat 触发条件：

- `issue_comment.created` 且内容不包含命令前缀（如 `/update_pr`）。

Chatter 行为约束：

- 仅允许读取上下文与仓库文件
- 判断是使用问题、程序缺陷或其他情况
- 仅输出一条回复，必要时 @coder 触发开发

Chat 行为约束：

- 仅允许读取上下文与仓库文件
- 不创建/修改分支、不写文件、不提交
- 只输出一条评论

## 范围与非目标

以下能力由 OpenCode/Codex 负责，我们不在胶水层重复实现：

- 代码搜索、语义检索与上下文扩展
- Patch 压缩与 token 预算管理
- 复杂的文件相关性排序或语言优先级策略

## 任务流程与数据目录

所有事件处理遵循统一流程：先将上下文写入 `.github-agent-data/`，再把身份/能力/上下文交给 Agent（OpenCode/Codex），让其自行读取文件并完成任务。

### Issue 处理流程

1. Clone 仓库到 Action 容器
2. 写入 `.github-agent-data/`：
   - `issue-context.md`：Issue 完整上下文（正文、标签、关键元信息、评论）
3. 调用 Agent（只提供目录位置，不手动拼接 prompt）
4. Agent 生成：
   - `issue-reply.md`：Issue 回复内容
5. 若需要开发：
   - Agent 新建分支、开发、commit、push、创建 PR
   - Agent 更新 `issue-reply.md`（包含 PR 链接与变更说明）
6. 任务完成后，将 `issue-reply.md` 内容发到 Issue

> Issue 上下文应由 workflow 负责抓取并写入 `issue-context.md`，Agent 只读。

### Issue Chatter 流程

1. 写入 `.github-agent-data/`：
   - `issue-context.md`：Issue 完整上下文（正文、标签、关键元信息、评论）
2. 调用 Agent（仅只读）
3. Agent 生成：
   - `issue-response.json`：完整结构化输出
   - `issue-reply.md`：最终回复内容
4. 任务完成后，将 `issue-reply.md` 内容发到 Issue

> Issue 上下文应由 workflow 负责抓取并写入 `issue-context.md`，Agent 只读。

### PR Review 流程

1. 写入 `.github-agent-data/`：
   - `pr-context.md`：PR 标题、描述、完整对话记录
   - `review-summary.md`：对变更的综合描述
   - `review-result.md`：Review 结论（approve/request changes 等）
   - `review-suggestions.md`：代码修改建议（可含条目化清单）
2. 调用 Agent（只提供目录位置，Agent 自行读取 repo 与 diff）
3. Agent 产出更新上述 review 文件，并在 PR 中发布 Review（对应三文件内容）

### PR Update 流程

与 Issue 处理一致，但分支基于现有 PR 分支：

1. 写入 `.github-agent-data/`：
   - `pr-context.md`：PR 标题、描述、完整对话记录
   - `update-request.md`：更新需求（评论内容/审查要点）
2. Agent 拉取 PR 分支、修改代码、commit、push
3. Agent 更新 `issue-reply.md` 或 `pr-update-summary.md` 并发表评论

## 引导程序实现

### main.ts

```typescript
import * as core from "@actions/core";
import * as github from "@actions/github";
import * as exec from "@actions/exec";
import { buildPrompt } from "./prompts";
import { configureGit } from "./utils/git-config";

async function run() {
  const token = core.getInput("github_token", { required: true });
  const opencodeBin = core.getInput("opencode_bin") || "opencode/codex";
  const workDir = core.getInput("working_directory") || ".";

  try {
    // 1. 配置 Git 环境
    await configureGit(token);

    // 2. 构建 Prompt
    const prompt = buildPrompt(github.context);
    if (!prompt) {
      core.info("No actionable event detected. Skipping.");
      return;
    }

    core.info("Generated prompt for agent:");
    core.info(prompt);

    // 3. 准备环境变量
    const agentRound = process.env.AGENT_ROUND || "1";
    const env = {
      ...process.env,
      GH_TOKEN: token,
      GITHUB_TOKEN: token,
      AGENT_ROUND: agentRound,
    };

    // 4. 释放 Agent
    // 将轮数信息添加到 prompt
    const promptWithRound = `${prompt}\n\n# ROUND MARKER\nThis is round ${agentRound}. When posting comments, always append the following hidden marker at the end:\n\`\`\`\n<!-- agent-round:${agentRound} -->\n\`\`\`\nThis is critical for loop control.`;

    await exec.exec(
      opencodeBin,
      ["--prompt", promptWithRound, "--dir", workDir],
      {
        env,
      }
    );

    core.info("Agent completed successfully.");
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(`Agent failed: ${error.message}`);
    }
  }
}

run();
```

### utils/git-config.ts

```typescript
import * as exec from "@actions/exec";

export async function configureGit(token: string): Promise<void> {
  // 配置 Git 认证
  // 这是个 hack，将 token 嵌入 URL 避免交互式认证
  await exec.exec("git", [
    "config",
    "--global",
    `url."https://x-access-token:${token}@github.com/".insteadOf`,
    "https://github.com/",
  ]);

  // 配置 Git 用户身份
  await exec.exec("git", [
    "config",
    "--global",
    "user.name",
    "github-agent[bot]",
  ]);
  await exec.exec("git", [
    "config",
    "--global",
    "user.email",
    "github-agent[bot]@users.noreply.github.com",
  ]);

  // 配置默认分支行为
  await exec.exec("git", [
    "config",
    "--global",
    "push.autoSetupRemote",
    "true",
  ]);
}
```

## Prompt 模板

### prompts/index.ts

```typescript
import { Context } from "@actions/github/lib/context";
import { buildIssuePrompt } from "./issue-handler";
import { buildPRReviewPrompt } from "./pr-reviewer";
import {
  buildPRUpdatePrompt,
  buildPRUpdateNewPrompt,
  buildReReviewPrompt,
} from "./pr-updater";

export function buildPrompt(context: Context): string | null {
  const { eventName, payload } = context;

  // Issue 创建事件
  if (eventName === "issues" && payload.action === "opened") {
    return buildIssuePrompt(payload);
  }

  // PR 创建或更新事件
  if (
    eventName === "pull_request" &&
    ["opened", "synchronize"].includes(payload.action!)
  ) {
    return buildPRReviewPrompt(payload);
  }

  // PR 评论事件 - 检查命令
  if (eventName === "issue_comment" && payload.issue?.pull_request) {
    const comment = payload.comment?.body || "";

    if (comment.includes("/update_pr_new")) {
      return buildPRUpdateNewPrompt(payload, comment);
    }
    if (comment.includes("/update_pr")) {
      return buildPRUpdatePrompt(payload, comment);
    }
    if (comment.includes("/rereview")) {
      return buildReReviewPrompt(payload);
    }
  }

  return null;
}
```

### 模式路由（Reviewer / Coder）

在实际实现中，建议根据 `AGENT_MODE` 和 PR 标签决定 prompt 角色：

- `AGENT_MODE=reviewer`：只做代码审查与反馈，不直接改代码。
- `AGENT_MODE=coder`：根据 Reviewer 评论继续修复并更新 PR。

Coder 需要读取最近的 Reviewer 评论（`/review_done` 或含审查要点的评论），将其作为修改依据。

### prompts/issue-handler.ts

```typescript
import { WebhookPayload } from "@actions/github/lib/interfaces";

export function buildIssuePrompt(payload: WebhookPayload): string {
  const issue = payload.issue!;
  const repo = payload.repository!;

  return `
# ROLE
You are an autonomous developer with full shell access.

# TASK
Resolve Issue #${issue.number} in repository ${repo.full_name}.

## Issue Details
- **Title**: ${issue.title}
- **Author**: @${issue.user?.login}
- **Labels**: ${issue.labels?.map((l: any) => l.name).join(", ") || "none"}

## Issue Content
${issue.body || "No description provided."}

# INSTRUCTIONS

1. **Explore**: Understand the codebase structure and locate relevant files.

2. **Plan**: Before coding, explain your approach in a comment.

3. **Branch**: Create a new branch:
   \`\`\`bash
   git checkout -b fix/issue-${issue.number}
   \`\`\`

4. **Implement**: Write clean, well-documented code to solve the issue.

5. **Test**: If applicable, run existing tests to ensure nothing is broken.

6. **Commit**: Make atomic commits with clear messages:
   \`\`\`bash
   git add -A
   git commit -m "fix: resolve issue #${issue.number} - [brief description]"
   \`\`\`

7. **Push**: Push the branch to origin:
   \`\`\`bash
   git push origin fix/issue-${issue.number}
   \`\`\`

8. **Create PR**: Create a Pull Request linking to this issue:
   \`\`\`bash
   gh pr create --title "Fix: ${issue.title}" --body "Closes #${issue.number}

   ## Changes
   [Describe your changes here]

   ## Testing
   [Describe how you tested the changes]"
   \`\`\`

9. **Report**: Comment on the issue with your progress:
   \`\`\`bash
   gh issue comment ${
     issue.number
   } --body "I've created PR #[PR_NUMBER] to address this issue.
   
   **Summary of changes:**
   [Brief summary]
   
   Please review and let me know if you need any adjustments."
   \`\`\`

# CONSTRAINTS
- Do NOT push directly to main/master branch
- Do NOT make destructive changes without explicit confirmation
- Keep commits atomic and well-documented
- Follow existing code style and conventions
`.trim();
}
```

### prompts/pr-reviewer.ts

```typescript
import { WebhookPayload } from "@actions/github/lib/interfaces";

export function buildPRReviewPrompt(payload: WebhookPayload): string {
  const pr = payload.pull_request!;
  const repo = payload.repository!;

  return `
# ROLE
You are a senior code reviewer with expertise in code quality, security, and best practices.

# TASK
Review Pull Request #${pr.number} in repository ${repo.full_name}.

## PR Details
- **Title**: ${pr.title}
- **Author**: @${pr.user?.login}
- **Branch**: ${pr.head?.ref} → ${pr.base?.ref}
- **Changed Files**: ${pr.changed_files || "unknown"}
- **Additions**: +${pr.additions || 0}
- **Deletions**: -${pr.deletions || 0}

## PR Description
${pr.body || "No description provided."}

# INSTRUCTIONS

## Step 1: Analyze Changes
\`\`\`bash
gh pr diff ${pr.number}
\`\`\`

Review the diff carefully for:
- Code correctness and logic errors
- Security vulnerabilities
- Performance issues
- Code style and best practices
- Test coverage

## Step 2: Create Review Files

Create three local files to document your review:

### File 1: review-summary.md
A comprehensive summary of the PR including:
- Overall assessment
- Key changes identified
- Impact analysis

### File 2: review-comments.md
Detailed line-by-line comments for issues found.

### File 3: review-verdict.md
Final verdict: APPROVE, REQUEST_CHANGES, or COMMENT.

## Step 3: Update PR Description
Add a review summary section at the end of PR description:

\`\`\`bash
gh pr edit ${pr.number} --body "$(gh pr view ${pr.number} --json body -q .body)

---
## 🤖 Agent Review Summary

[Your comprehensive summary here]

**Review Status**: [APPROVED/CHANGES_REQUESTED/COMMENTED]
**Reviewed at**: $(date -u +"%Y-%m-%d %H:%M:%S UTC")
"
\`\`\`

## Step 4: Submit Review

Based on your analysis:

### If issues found:
\`\`\`bash
gh pr review ${pr.number} --request-changes --body "## Review Summary

[Brief summary of issues]

Please address the comments below before merging."
\`\`\`

### If code is good:
\`\`\`bash
gh pr review ${pr.number} --approve --body "## ✅ Approved

[Positive feedback and any minor suggestions]"
\`\`\`

## Step 5: Post Detailed Comments

\`\`\`bash
gh pr comment ${pr.number} --body "## 📝 Detailed Review

[Detailed analysis from review-comments.md]"
\`\`\`

# REVIEW CRITERIA

## Must Check
- [ ] No hardcoded credentials or secrets
- [ ] No SQL injection or XSS vulnerabilities  
- [ ] Error handling is appropriate
- [ ] No infinite loops or resource leaks

## Should Check
- [ ] Code is readable and well-documented
- [ ] Functions are not too long
- [ ] DRY principle is followed
- [ ] Tests cover new functionality

## Nice to Have
- [ ] Performance optimizations
- [ ] Accessibility improvements
- [ ] Documentation updates
`.trim();
}
```

### prompts/pr-updater.ts

```typescript
import { WebhookPayload } from "@actions/github/lib/interfaces";

export function buildPRUpdatePrompt(
  payload: WebhookPayload,
  feedback: string
): string {
  const issue = payload.issue!;
  const repo = payload.repository!;

  // 从 feedback 中提取 /update_pr 后的内容
  const feedbackContent = feedback.replace(/\/update_pr\s*/i, "").trim();

  return `
# ROLE
You are an autonomous developer responding to code review feedback.

# TASK
Update PR #${issue.number} based on the feedback provided.

## Feedback
${feedbackContent || "No specific feedback provided. Review previous comments."}

# INSTRUCTIONS

1. **Fetch Latest**: Get the latest changes
   \`\`\`bash
   git fetch origin
   \`\`\`

2. **Checkout PR Branch**: 
   \`\`\`bash
   gh pr checkout ${issue.number}
   \`\`\`

3. **Analyze Feedback**: Read the feedback carefully and understand what changes are needed.

4. **Implement Fixes**: Make the necessary code changes.

5. **Commit Changes**:
   \`\`\`bash
   git add -A
   git commit -m "fix: address review feedback for PR #${issue.number}"
   \`\`\`

6. **Push Updates**:
   \`\`\`bash
   git push
   \`\`\`

7. **Confirm Fix**:
   \`\`\`bash
   gh pr comment ${issue.number} --body "✅ I've addressed the feedback:

   **Changes made:**
   [List changes here]

   Please re-review when you have a chance."
   \`\`\`

# CONSTRAINTS
- Stay on the existing PR branch
- Make minimal, focused changes
- Don't introduce new features unless requested
`.trim();
}

export function buildPRUpdateNewPrompt(
  payload: WebhookPayload,
  feedback: string
): string {
  const issue = payload.issue!;
  const repo = payload.repository!;

  const feedbackContent = feedback.replace(/\/update_pr_new\s*/i, "").trim();

  return `
# ROLE
You are an autonomous developer creating a new PR to address feedback.

# TASK
Create a new branch and PR to fix issues in PR #${issue.number}.

## Feedback
${feedbackContent || "No specific feedback provided. Review previous comments."}

# INSTRUCTIONS

1. **Checkout Base**: Start from the PR's base branch
   \`\`\`bash
   gh pr checkout ${issue.number}
   git checkout -b fix/pr-${issue.number}-v2
   \`\`\`

2. **Implement Fixes**: Make the necessary code changes.

3. **Commit Changes**:
   \`\`\`bash
   git add -A
   git commit -m "fix: alternative approach for PR #${issue.number}"
   \`\`\`

4. **Push New Branch**:
   \`\`\`bash
   git push origin fix/pr-${issue.number}-v2
   \`\`\`

5. **Create New PR**:
   \`\`\`bash
   gh pr create --title "Fix: Alternative approach for #${
     issue.number
   }" --body "This PR provides an alternative solution to the issues identified in #${
    issue.number
  }.

   ## Relationship
   - Related to: #${issue.number}

   ## Changes
   [Describe changes]

   ## Feedback Addressed
   ${feedbackContent}"
   \`\`\`

6. **Comment on Original**:
   \`\`\`bash
   gh pr comment ${
     issue.number
   } --body "I've created a new PR with an alternative approach. Please review: [NEW_PR_LINK]"
   \`\`\`
`.trim();
}

export function buildReReviewPrompt(payload: WebhookPayload): string {
  const issue = payload.issue!;
  const repo = payload.repository!;

  return `
# ROLE
You are a senior code reviewer performing a re-review.

# TASK
Re-review PR #${issue.number} after updates have been made.

# INSTRUCTIONS

1. **Get Latest Diff**:
   \`\`\`bash
   gh pr diff ${issue.number}
   \`\`\`

2. **Check Previous Comments**: Review what was previously requested.

3. **Verify Fixes**: Ensure all previous issues have been addressed.

4. **New Issues**: Check if new issues were introduced.

5. **Submit Re-Review**:

   ### If all issues fixed:
   \`\`\`bash
   gh pr review ${issue.number} --approve --body "## ✅ Re-Review: Approved

   All previous issues have been addressed. LGTM!"
   \`\`\`

   ### If issues remain:
   \`\`\`bash
   gh pr review ${issue.number} --request-changes --body "## 🔄 Re-Review: Changes Still Needed

   [List remaining issues]"
   \`\`\`

6. **Update PR Description**: Add re-review timestamp
   \`\`\`bash
   gh pr edit ${issue.number} --body "$(gh pr view ${issue.number} --json body -q .body)

   ---
   **🔄 Re-reviewed at**: $(date -u +"%Y-%m-%d %H:%M:%S UTC")
   "
   \`\`\`
`.trim();
}
```

## package.json

```json
{
  "name": "github-agent",
  "version": "1.0.0",
  "description": "GitHub Autonomous Code Agent",
  "main": "dist/main.js",
  "scripts": {
    "build": "tsc",
    "test": "jest",
    "lint": "eslint src/**/*.ts"
  },
  "dependencies": {
    "@actions/core": "^1.10.0",
    "@actions/exec": "^1.1.1",
    "@actions/github": "^6.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0",
    "eslint": "^8.0.0",
    "@typescript-eslint/parser": "^6.0.0",
    "@typescript-eslint/eslint-plugin": "^6.0.0",
    "jest": "^29.0.0",
    "@types/jest": "^29.0.0",
    "ts-jest": "^29.0.0"
  }
}
```

## tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```
