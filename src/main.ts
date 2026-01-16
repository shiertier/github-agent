/**
 * GitHub Agent Bootstrap - Main Entry Point
 *
 * 极简引导程序：配置环境 → 构建 Prompt → 调用 OpenCode/Codex
 */

import * as core from "@actions/core";
import * as github from "@actions/github";
import { execFileSync, execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as TOML from "@iarna/toml";

const ACTION_ROOT = path.resolve(__dirname, "..");
const DEFAULT_BASE_BRANCH = "main";
let currentPrCheckout: PullRequestCheckoutInfo | null = null;

function resolvePromptPath(relativePath: string): string {
  return path.join(ACTION_ROOT, relativePath);
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function tailFile(filePath: string, maxLines = 200, maxBytes = 128 * 1024): string {
  try {
    const stats = fs.statSync(filePath);
    const size = stats.size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      const text = buffer.toString("utf-8");
      const lines = text.split(/\r?\n/);
      const tail = lines.slice(-maxLines).join("\n");
      return tail.trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function writeExecutable(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o755 });
  try {
    fs.chmodSync(filePath, 0o755);
  } catch {
    // Best effort: chmod may fail on some filesystems.
  }
}

// Agent 模式
type AgentMode = "issue-chatter" | "issue-coder" | "pr-reviewer" | "pr-coder";

// 用户配置
interface UserConfig {
  model_name: string;
  max_tokens: number;
  fallback_models: string[];
  response_language: "en" | "zh-CN";
  max_rounds: number;
}

// Agent 配置
interface AgentConfig {
  mode: AgentMode;
  promptFile: string;
  contextFile: string;
  maxRounds: number;
  userConfig: UserConfig;
}

// 验证 response_language 枚举值
function validateResponseLanguage(value: string | undefined): "en" | "zh-CN" | undefined {
  if (!value) return undefined;
  const validValues = ["en", "zh-CN"];
  if (validValues.includes(value)) {
    return value as "en" | "zh-CN";
  }
  core.warning(`Invalid response_language "${value}", falling back to default. Valid values: ${validValues.join(", ")}`);
  return undefined;
}

// 加载配置（优先级：action inputs > env vars > toml file）
function loadUserConfig(): UserConfig {
  // 默认值
  const defaults: UserConfig = {
    model_name: "",
    max_tokens: 4096,
    fallback_models: [],
    response_language: "en",
    max_rounds: 8,
  };

  // 1. 尝试从 .github_agent.toml 加载
  const tomlPath = path.join(process.cwd(), ".github_agent.toml");
  let tomlConfig: Partial<UserConfig> = {};
  if (fs.existsSync(tomlPath)) {
    try {
      const content = fs.readFileSync(tomlPath, "utf-8");
      const parsed = TOML.parse(content) as Record<string, unknown>;
      tomlConfig = {
        model_name: parsed.model_name as string | undefined,
        max_tokens: parsed.max_tokens as number | undefined,
        fallback_models: parsed.fallback_models as string[] | undefined,
        response_language: parsed.response_language as "en" | "zh-CN" | undefined,
        max_rounds: parsed.max_rounds as number | undefined,
      };
      core.info(`Loaded config from ${tomlPath}`);
    } catch (e) {
      core.warning(`Failed to parse ${tomlPath}: ${e}`);
    }
  }

  // 2. 从环境变量加载
  const envConfig: Partial<UserConfig> = {};
  if (process.env.GITHUB_AGENT_MODEL_NAME) {
    envConfig.model_name = process.env.GITHUB_AGENT_MODEL_NAME;
  }
  if (process.env.GITHUB_AGENT_MAX_TOKENS) {
    const parsed = parseInt(process.env.GITHUB_AGENT_MAX_TOKENS, 10);
    if (Number.isFinite(parsed)) {
      envConfig.max_tokens = parsed;
    }
  }
  if (process.env.GITHUB_AGENT_FALLBACK_MODELS) {
    envConfig.fallback_models = process.env.GITHUB_AGENT_FALLBACK_MODELS.split(",").map((s) => s.trim());
  }
  if (process.env.GITHUB_AGENT_RESPONSE_LANGUAGE) {
    const parsed = validateResponseLanguage(process.env.GITHUB_AGENT_RESPONSE_LANGUAGE);
    if (parsed) {
      envConfig.response_language = parsed;
    }
  }
  if (process.env.GITHUB_AGENT_MAX_ROUNDS) {
    const parsed = parseInt(process.env.GITHUB_AGENT_MAX_ROUNDS, 10);
    if (Number.isFinite(parsed)) {
      envConfig.max_rounds = parsed;
    }
  }

  // 3. 从 action inputs 加载（最高优先级）
  const inputConfig: Partial<UserConfig> = {};
  const modelName = core.getInput("model_name");
  if (modelName) inputConfig.model_name = modelName;
  
  const maxTokens = core.getInput("max_tokens");
  if (maxTokens) {
    const parsed = parseInt(maxTokens, 10);
    if (Number.isFinite(parsed)) {
      inputConfig.max_tokens = parsed;
    }
  }
  
  const fallbackModels = core.getInput("fallback_models");
  if (fallbackModels) inputConfig.fallback_models = fallbackModels.split(",").map((s) => s.trim());
  
  const responseLang = core.getInput("response_language");
  if (responseLang) {
    const parsed = validateResponseLanguage(responseLang);
    if (parsed) {
      inputConfig.response_language = parsed;
    }
  }
  
  const maxRounds = core.getInput("max_rounds");
  if (maxRounds) {
    const parsed = parseInt(maxRounds, 10);
    if (Number.isFinite(parsed)) {
      inputConfig.max_rounds = parsed;
    }
  }

  // 合并配置（后面的覆盖前面的）
  return {
    ...defaults,
    ...tomlConfig,
    ...envConfig,
    ...inputConfig,
  };
}

// 根据事件类型确定 Agent 模式
function detectAgentMode(): AgentConfig {
  const eventName = github.context.eventName;
  const payload = github.context.payload;
  const userConfig = loadUserConfig();

  function isCoderCommand(text: string): boolean {
    if (!text) return false;
    return /(^|\n)\s*@coder\b/.test(text);
  }

  // Issue 事件
  if (eventName === "issues") {
    return {
      mode: "issue-chatter",
      promptFile: resolvePromptPath("prompts/issue-chatter.md"),
      contextFile: ".github-agent-data/issue-context.md",
      maxRounds: userConfig.max_rounds,
      userConfig,
    };
  }

  // Issue 评论
  if (eventName === "issue_comment") {
    const isPR = !!payload.issue?.pull_request;
    const body = payload.comment?.body || "";
    const hasCoder = isCoderCommand(body);

    if (isPR) {
      return {
        mode: hasCoder ? "pr-coder" : "pr-reviewer",
        promptFile: hasCoder
          ? resolvePromptPath("prompts/pr-coder.md")
          : resolvePromptPath("prompts/pr-reviewer.md"),
        contextFile: ".github-agent-data/pr-context.md",
        maxRounds: userConfig.max_rounds,
        userConfig,
      };
    } else {
      return {
        mode: hasCoder ? "issue-coder" : "issue-chatter",
        promptFile: hasCoder
          ? resolvePromptPath("prompts/issue-coder.md")
          : resolvePromptPath("prompts/issue-chatter.md"),
        contextFile: ".github-agent-data/issue-context.md",
        maxRounds: userConfig.max_rounds,
        userConfig,
      };
    }
  }

  // PR 事件
  if (eventName === "pull_request") {
    return {
      mode: "pr-reviewer",
      promptFile: resolvePromptPath("prompts/pr-reviewer.md"),
      contextFile: ".github-agent-data/pr-context.md",
      maxRounds: userConfig.max_rounds,
      userConfig,
    };
  }

  throw new Error(`Unsupported event: ${eventName}`);
}

// Bot 名称映射
const BOT_NAMES: Record<AgentMode, string> = {
  "issue-chatter": "issue-chatter-bot",
  "issue-coder": "issue-coder-bot",
  "pr-reviewer": "pr-reviewer-bot",
  "pr-coder": "pr-coder-bot",
};

// 配置 Git
function configureGit(mode: AgentMode): void {
  const botName = BOT_NAMES[mode];
  const commands = [
    `git config --global user.name "${botName}"`,
    `git config --global user.email "${botName}@users.noreply.github.com"`,
    "git config --global push.autoSetupRemote true",
  ];

  for (const cmd of commands) {
    execSync(cmd, { stdio: "inherit" });
  }
  core.info(`Git configured as ${botName}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function gitOutput(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf-8" }).trim();
}

function gitTryOutput(args: string[]): string | null {
  try {
    return gitOutput(args);
  } catch {
    return null;
  }
}

function git(args: string[]): void {
  execFileSync("git", args, { stdio: "inherit" });
}

function getDefaultBranch(): string {
  const payloadDefaultBranch = github.context.payload.repository?.default_branch;
  if (typeof payloadDefaultBranch === "string" && payloadDefaultBranch.trim()) {
    return payloadDefaultBranch.trim();
  }
  const localDefault = gitTryOutput(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (localDefault) {
    const match = localDefault.match(/^origin\/(.+)$/);
    if (match?.[1]) return match[1];
  }
  return DEFAULT_BASE_BRANCH;
}

type PullRequestCheckoutInfo = {
  baseRef: string;
  canPush: boolean;
  checkedOutBranch: string;
  headRef: string;
  prNumber: number;
};

async function checkoutPullRequestHead(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number
): Promise<PullRequestCheckoutInfo> {
  const { data: pr } = await withRetry("pulls.get", () =>
    octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    })
  );

  const headRef = pr.head?.ref;
  const baseRef = pr.base?.ref;
  if (!headRef || !baseRef) {
    throw new Error(`Failed to resolve PR refs for #${prNumber}`);
  }

  const headRepoFullName = (pr.head?.repo?.full_name || "").toLowerCase();
  const baseRepoFullName = (pr.base?.repo?.full_name || `${owner}/${repo}`).toLowerCase();
  const isSameRepo = headRepoFullName && headRepoFullName === baseRepoFullName;

  if (isSameRepo) {
    git(["fetch", "origin", `+refs/heads/${headRef}:refs/remotes/origin/${headRef}`]);
    git(["checkout", "-B", headRef, `refs/remotes/origin/${headRef}`]);
    core.info(`Checked out PR #${prNumber} head branch: ${headRef}`);
    return {
      prNumber,
      headRef,
      baseRef,
      checkedOutBranch: headRef,
      canPush: true,
    };
  }

  const localBranch = `pr-${prNumber}-head`;
  git([
    "fetch",
    "origin",
    `+refs/pull/${prNumber}/head:refs/remotes/origin/${localBranch}`,
  ]);
  git(["checkout", "-B", localBranch, `refs/remotes/origin/${localBranch}`]);
  core.info(`Checked out PR #${prNumber} head ref (fork): ${localBranch}`);
  return {
    prNumber,
    headRef,
    baseRef,
    checkedOutBranch: localBranch,
    canPush: false,
  };
}

function hasUncommittedChanges(): boolean {
  const output = gitTryOutput(["status", "--porcelain"]);
  return !!output;
}

function commitAllChanges(message: string): boolean {
  if (!hasUncommittedChanges()) return false;
  git(["add", "-A"]);
  // Never commit agent runtime artifacts.
  try {
    git(["reset", "-q", "--", ".github-agent-data"]);
  } catch {
    // Best effort: ignore if path doesn't exist.
  }
  const staged = gitTryOutput(["diff", "--cached", "--name-only"]);
  if (!staged) return false;
  try {
    git(["commit", "-m", message]);
    return true;
  } catch (e) {
    core.warning(`git commit failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function gitPushWithRetry(
  branch: string,
  options?: { forceWithLease?: boolean; maxAttempts?: number }
): Promise<void> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const forceWithLease = options?.forceWithLease ?? false;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const args = ["push"];
      if (forceWithLease) args.push("--force-with-lease");
      args.push("-u", "origin", `HEAD:${branch}`);
      git(args);
      return;
    } catch (e) {
      lastError = e;
      core.warning(
        `git push failed (attempt ${attempt}/${maxAttempts}): ${e instanceof Error ? e.message : String(e)}`
      );
      if (attempt < maxAttempts) {
        await sleep(500 * attempt);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function inferIssueBranchPrefix(fallbackIssueType?: string): string {
  const commentBody = github.context.payload.comment?.body || "";
  const normalized = commentBody.toLowerCase();

  if (normalized.includes("@coder fix")) return "ai-fix";
  if (normalized.includes("@coder refactor")) return "ai-refactor";
  if (normalized.includes("@coder schema")) return "ai-schema";
  if (normalized.includes("@coder feat")) return "ai-feat";

  const issueType = (fallbackIssueType || "").toLowerCase();
  if (issueType === "bug") return "ai-fix";
  return "ai-feat";
}

function currentBranchName(): string {
  return gitTryOutput(["rev-parse", "--abbrev-ref", "HEAD"]) || "HEAD";
}

function ensureNonDefaultBranch(baseBranch: string, desiredBranch: string): string {
  const branch = currentBranchName();
  if (branch !== "HEAD" && branch !== baseBranch) {
    return branch;
  }

  core.info(`Creating branch ${desiredBranch} for changes (base branch is ${baseBranch})`);
  git(["checkout", "-B", desiredBranch]);
  return desiredBranch;
}

function formatErrorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const err = error as { status?: unknown; code?: unknown };
  const status = typeof err?.status === "number" ? err.status : undefined;
  const code = typeof err?.code === "string" ? err.code : undefined;
  const parts = [];
  if (code) parts.push(code);
  if (status) parts.push(`HTTP ${status}`);
  parts.push(message);
  return parts.join(" ");
}

function isRetryableError(error: unknown): boolean {
  const err = error as { message?: unknown; status?: unknown; code?: unknown };
  const message = typeof err?.message === "string" ? err.message : "";
  const code = typeof err?.code === "string" ? err.code : "";
  const status = typeof err?.status === "number" ? err.status : undefined;

  const retryableCodes = new Set([
    "EPIPE",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "ERR_SOCKET_TIMEOUT",
  ]);
  if (code && retryableCodes.has(code)) return true;

  if (/write EPIPE/i.test(message)) return true;
  if (/socket hang up/i.test(message)) return true;
  if (/ECONNRESET/i.test(message)) return true;
  if (/ETIMEDOUT/i.test(message)) return true;

  if (status === 408 || status === 429) return true;
  if (status && status >= 500 && status < 600) return true;

  if (status === 403 && /rate limit/i.test(message)) return true;

  return false;
}

async function withRetry<T>(
  name: string,
  fn: () => Promise<T>,
  options?: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number }
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 5;
  const baseDelayMs = options?.baseDelayMs ?? 500;
  const maxDelayMs = options?.maxDelayMs ?? 8000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const retryable = isRetryableError(error);
      if (!retryable || attempt >= maxAttempts) {
        throw error;
      }

      const delayMs = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      const jitterMs = Math.floor(Math.random() * 250);
      core.warning(
        `${name} failed (attempt ${attempt}/${maxAttempts}): ${formatErrorSummary(error)}; retrying in ${
          delayMs + jitterMs
        }ms`
      );
      await sleep(delayMs + jitterMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// 检查轮数限制
async function checkRoundLimit(maxRounds: number): Promise<number> {
  const token = core.getInput("github_token") || process.env.GITHUB_TOKEN;
  if (!token) throw new Error("Missing GITHUB_TOKEN");

  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;

  let issueNumber: number | undefined;
  if (github.context.payload.issue) {
    issueNumber = github.context.payload.issue.number;
  } else if (github.context.payload.pull_request) {
    issueNumber = github.context.payload.pull_request.number;
  }

  if (!issueNumber) {
    return 1; // No issue context, start from round 1
  }

  const { data: comments } = await withRetry("issues.listComments", () =>
    octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    })
  );

  // Check for /reset command
  const lastResetIndex = comments
    .map((c, i) => (c.body?.includes("/reset") ? i : -1))
    .filter((i) => i >= 0)
    .pop();

  const relevantComments =
    lastResetIndex !== undefined
      ? comments.slice(lastResetIndex + 1)
      : comments;

  // Find max round
  const roundRegex = /<!-- agent-round:(\d+) -->/;
  const rounds = relevantComments
    .map((c) => {
      const match = c.body?.match(roundRegex);
      return match ? parseInt(match[1], 10) : 0;
    })
    .filter((r) => r > 0);

  const currentRound = rounds.length > 0 ? Math.max(...rounds) : 0;
  const nextRound = currentRound + 1;

  if (nextRound > maxRounds) {
    core.warning(`Max rounds (${maxRounds}) reached. Use /reset to continue.`);
    throw new Error("MAX_ROUNDS_REACHED");
  }

  core.info(`Round ${nextRound} of ${maxRounds}`);
  return nextRound;
}

// 期望输出文件映射
const EXPECTED_OUTPUTS: Record<AgentMode, string[]> = {
  "issue-chatter": [
    ".github-agent-data/issue-response.json",
    ".github-agent-data/issue-reply.md",
  ],
  "issue-coder": [".github-agent-data/issue-reply.md"],
  "pr-reviewer": [
    ".github-agent-data/review-response.json",
    ".github-agent-data/review-summary.md",
    ".github-agent-data/review-result.md",
    ".github-agent-data/review-suggestions.md",
  ],
  "pr-coder": [".github-agent-data/pr-update-summary.md"],
};

function installContextSkills(): void {
  const codexHome = (process.env.CODEX_HOME || path.join(os.homedir(), ".codex")).trim();
  const skillsRoot = path.join(codexHome, "skills");
  const issueSkillRoot = path.join(skillsRoot, "get-issue-context");
  const prSkillRoot = path.join(skillsRoot, "get-pr-context");
  const issueScriptsDir = path.join(issueSkillRoot, "scripts");
  const prScriptsDir = path.join(prSkillRoot, "scripts");

  ensureDir(issueScriptsDir);
  ensureDir(prScriptsDir);

  const issueSkillMd = `---
name: get-issue-context
description: Fetch and write GitHub Issue context into .github-agent-data/issue-context.md for the current repository.
---

Run:

get-issue-context "$ISSUE_NUMBER"
`;
  const prSkillMd = `---
name: get-pr-context
description: Fetch and write GitHub Pull Request context into .github-agent-data/pr-context.md for the current repository.
---

Run:

get-pr-context "$PR_NUMBER"
`;
  fs.writeFileSync(path.join(issueSkillRoot, "SKILL.md"), issueSkillMd, "utf-8");
  fs.writeFileSync(path.join(prSkillRoot, "SKILL.md"), prSkillMd, "utf-8");

  const issueScript = `#!/usr/bin/env python3
import json
import os
import subprocess
import sys
from datetime import datetime


def run_gh(args: list[str]) -> str:
  env = os.environ.copy()
  if not env.get("GH_TOKEN") and env.get("GITHUB_TOKEN"):
    env["GH_TOKEN"] = env["GITHUB_TOKEN"]
  return subprocess.check_output(["gh"] + args, env=env, text=True)


def main() -> int:
  issue_number = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("ISSUE_NUMBER")
  if not issue_number:
    print("Missing issue number (arg1 or ISSUE_NUMBER).", file=sys.stderr)
    return 2

  repo = os.environ.get("GITHUB_REPOSITORY")
  if not repo:
    try:
      repo = run_gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).strip()
    except Exception:
      repo = ""
  if not repo:
    print("Missing GITHUB_REPOSITORY and failed to resolve repo.", file=sys.stderr)
    return 2

  issue = {}
  comments = []
  try:
    issue = json.loads(run_gh(["api", f"repos/{repo}/issues/{issue_number}"]))
    comments = json.loads(run_gh(["api", f"repos/{repo}/issues/{issue_number}/comments", "--paginate"]))
  except Exception:
    event_path = os.environ.get("GITHUB_EVENT_PATH")
    if event_path and os.path.exists(event_path):
      try:
        with open(event_path, "r", encoding="utf-8") as f:
          event = json.load(f)
        issue = event.get("issue") or {}
        if event.get("comment"):
          comments = [event.get("comment")]
      except Exception:
        pass

  out_dir = os.path.join(os.getcwd(), ".github-agent-data")
  os.makedirs(out_dir, exist_ok=True)
  out_path = os.path.join(out_dir, "issue-context.md")

  def fmt_dt(s: str | None) -> str:
    if not s:
      return ""
    try:
      return datetime.fromisoformat(s.replace("Z", "+00:00")).isoformat()
    except Exception:
      return s

  trigger_event_name = os.environ.get("GITHUB_EVENT_NAME", "") or ""
  trigger_actor = os.environ.get("GITHUB_ACTOR", "") or ""
  repo_owner = repo.split("/")[0] if "/" in repo else repo
  trigger_comment = {}
  event_path = os.environ.get("GITHUB_EVENT_PATH")
  if event_path and os.path.exists(event_path):
    try:
      with open(event_path, "r", encoding="utf-8") as f:
        event = json.load(f)
      if isinstance(event, dict) and isinstance(event.get("comment"), dict):
        trigger_comment = event.get("comment") or {}
    except Exception:
      trigger_comment = {}

  labels = [l.get("name") for l in issue.get("labels", []) if isinstance(l, dict) and l.get("name")]

  with open(out_path, "w", encoding="utf-8") as f:
    f.write(f"# Issue #{issue_number}: {str(issue.get('title','')).strip()}\\n\\n")
    f.write("## Trigger\\n\\n")
    if trigger_event_name:
      f.write(f"- Event: {trigger_event_name}\\n")
    if trigger_actor:
      f.write(f"- Actor: {trigger_actor}\\n")
    f.write(f"- Repo Owner: {repo_owner}\\n\\n")
    if trigger_comment:
      tc_author = (trigger_comment.get("user") or {}).get("login", "")
      tc_assoc = trigger_comment.get("author_association", "")
      tc_created = fmt_dt(trigger_comment.get("created_at"))
      tc_body = (trigger_comment.get("body") or "").strip()
      if tc_author or tc_body:
        assoc_part = f" ({tc_assoc})" if tc_assoc else ""
        f.write(f"### {tc_author}{assoc_part} @ {tc_created}\\n\\n")
        f.write(tc_body + "\\n\\n" if tc_body else "(empty)\\n\\n")

    f.write("## Issue\\n\\n")
    f.write(f"- Repo: {repo}\\n")
    f.write(f"- State: {issue.get('state','')}\\n")
    f.write(f"- Author: {(issue.get('user') or {}).get('login','')}\\n")
    f.write(f"- Author Association: {issue.get('author_association','')}\\n")
    if labels:
      f.write(f"- Labels: {', '.join(labels)}\\n")
    f.write(f"- Created: {fmt_dt(issue.get('created_at'))}\\n")
    f.write(f"- Updated: {fmt_dt(issue.get('updated_at'))}\\n\\n")

    body = (issue.get("body") or "").strip()
    f.write("## Body\\n\\n")
    f.write(body + "\\n\\n" if body else "(empty)\\n\\n")

    f.write(f"## Comments ({len(comments)})\\n\\n")
    for c in comments:
      if not isinstance(c, dict):
        continue
      author = (c.get("user") or {}).get("login", "")
      author_assoc = c.get("author_association", "")
      created = fmt_dt(c.get("created_at"))
      assoc_part = f" ({author_assoc})" if author_assoc else ""
      f.write(f"### {author}{assoc_part} @ {created}\\n\\n")
      cb = (c.get("body") or "").strip()
      f.write(cb + "\\n\\n" if cb else "(empty)\\n\\n")

  print(out_path)
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
`;

  const prScript = `#!/usr/bin/env python3
import json
import os
import subprocess
import sys
from datetime import datetime


def run_gh(args: list[str]) -> str:
  env = os.environ.copy()
  if not env.get("GH_TOKEN") and env.get("GITHUB_TOKEN"):
    env["GH_TOKEN"] = env["GITHUB_TOKEN"]
  return subprocess.check_output(["gh"] + args, env=env, text=True)


def main() -> int:
  pr_number = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("PR_NUMBER")
  if not pr_number:
    print("Missing PR number (arg1 or PR_NUMBER).", file=sys.stderr)
    return 2

  repo = os.environ.get("GITHUB_REPOSITORY")
  if not repo:
    try:
      repo = run_gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).strip()
    except Exception:
      repo = ""
  if not repo:
    print("Missing GITHUB_REPOSITORY and failed to resolve repo.", file=sys.stderr)
    return 2

  pr = {}
  issue = {}
  comments = []
  try:
    pr = json.loads(run_gh(["api", f"repos/{repo}/pulls/{pr_number}"]))
    issue = json.loads(run_gh(["api", f"repos/{repo}/issues/{pr_number}"]))
    comments = json.loads(run_gh(["api", f"repos/{repo}/issues/{pr_number}/comments", "--paginate"]))
  except Exception:
    event_path = os.environ.get("GITHUB_EVENT_PATH")
    if event_path and os.path.exists(event_path):
      try:
        with open(event_path, "r", encoding="utf-8") as f:
          event = json.load(f)
        pr = event.get("pull_request") or {}
        issue = event.get("issue") or {}
        if event.get("comment"):
          comments = [event.get("comment")]
      except Exception:
        pass

  out_dir = os.path.join(os.getcwd(), ".github-agent-data")
  os.makedirs(out_dir, exist_ok=True)
  out_path = os.path.join(out_dir, "pr-context.md")

  def fmt_dt(s: str | None) -> str:
    if not s:
      return ""
    try:
      return datetime.fromisoformat(s.replace("Z", "+00:00")).isoformat()
    except Exception:
      return s

  labels = [l.get("name") for l in issue.get("labels", []) if isinstance(l, dict) and l.get("name")]

  with open(out_path, "w", encoding="utf-8") as f:
    f.write(f"# PR #{pr_number}: {str(pr.get('title','')).strip()}\\n\\n")
    f.write(f"- Repo: {repo}\\n")
    f.write(f"- State: {pr.get('state','')}\\n")
    f.write(f"- Author: {(pr.get('user') or {}).get('login','')}\\n")
    if labels:
      f.write(f"- Labels: {', '.join(labels)}\\n")
    f.write(f"- Base: {(pr.get('base') or {}).get('ref','')}\\n")
    f.write(f"- Head: {(pr.get('head') or {}).get('ref','')}\\n")
    f.write(f"- Created: {fmt_dt(pr.get('created_at'))}\\n")
    f.write(f"- Updated: {fmt_dt(pr.get('updated_at'))}\\n\\n")

    body = (pr.get("body") or "").strip()
    f.write("## Body\\n\\n")
    f.write(body + "\\n\\n" if body else "(empty)\\n\\n")

    f.write(f"## Comments ({len(comments)})\\n\\n")
    for c in comments:
      if not isinstance(c, dict):
        continue
      author = (c.get("user") or {}).get("login", "")
      created = fmt_dt(c.get("created_at"))
      f.write(f"### {author} @ {created}\\n\\n")
      cb = (c.get("body") or "").strip()
      f.write(cb + "\\n\\n" if cb else "(empty)\\n\\n")

  print(out_path)
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
`;
  const issueScriptPath = path.join(issueScriptsDir, "get-issue-context");
  const prScriptPath = path.join(prScriptsDir, "get-pr-context");
  writeExecutable(issueScriptPath, issueScript);
  writeExecutable(prScriptPath, prScript);

  addPath(issueScriptsDir);
  addPath(prScriptsDir);
}

// 检查文件是否存在且非空
function fileExists(filePath: string): boolean {
  try {
    const stats = fs.statSync(filePath);
    return stats.size > 0;
  } catch {
    return false;
  }
}

function isExecutable(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  if (process.platform === "win32") return true;
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveExecutable(binary: string): string | null {
  const hasPathSeparator = binary.includes("/") || binary.includes("\\") || binary.includes(path.sep);
  if (hasPathSeparator) {
    return isExecutable(binary) ? binary : null;
  }

  const pathEnv = process.env.PATH || "";
  if (!pathEnv) return null;

  const pathExts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];

  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of pathExts) {
      const candidate = path.join(dir, `${binary}${ext}`);
      if (isExecutable(candidate)) return candidate;
    }
  }

  return null;
}

function normalizeCliName(binary: string): string {
  return path.basename(binary).toLowerCase().replace(/\.exe$/, "");
}

function addPath(dir: string): void {
  if (!dir) return;
  core.addPath(dir);
  const currentPath = process.env.PATH || "";
  const pathEntries = currentPath.split(path.delimiter);
  if (!pathEntries.includes(dir)) {
    process.env.PATH = `${dir}${path.delimiter}${currentPath}`;
  }
}

function isMaintainerAssociation(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return value === "OWNER" || value === "MEMBER" || value === "COLLABORATOR";
}

function isMaintainerActor(): boolean {
  const repoOwner = github.context.repo.owner;
  const actor = github.context.actor;
  if (repoOwner && actor && repoOwner.toLowerCase() === actor.toLowerCase()) return true;

  const payload = github.context.payload as any;
  const assoc =
    payload?.comment?.author_association ||
    payload?.issue?.author_association ||
    payload?.pull_request?.author_association;
  return isMaintainerAssociation(assoc);
}

async function fetchJson(url: string, timeoutMs = 15000): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "shiertier/github-agent" },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    }
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

function extractHfTrendingIds(payload: unknown): string[] {
  const data = payload as any;
  const list = Array.isArray(data?.recentlyTrending) ? data.recentlyTrending : [];
  const ids = list
    .map((item: any) => item?.repoData?.id)
    .filter((id: any) => typeof id === "string" && id.trim());
  return ids;
}

async function prefetchHfTrendingIfNeeded(): Promise<void> {
  if (!isMaintainerActor()) return;

  const payload = github.context.payload as any;
  const text = [
    payload?.issue?.title,
    payload?.issue?.body,
    payload?.comment?.body,
  ]
    .filter((v) => typeof v === "string" && v.trim())
    .join("\n");

  const needsModel = /huggingface\.co\/api\/trending\?type=model/i.test(text);
  const needsDataset = /huggingface\.co\/api\/trending\?type=dataset/i.test(text);
  if (!needsModel && !needsDataset) return;

  const outDir = path.join(process.cwd(), ".github-agent-data", "external");
  ensureDir(outDir);

  const fetchedAtUtc = new Date().toISOString();
  const modelUrl = "https://huggingface.co/api/trending?type=model";
  const datasetUrl = "https://huggingface.co/api/trending?type=dataset";

  let modelIds: string[] = [];
  let datasetIds: string[] = [];
  const errors: Record<string, string> = {};

  if (needsModel) {
    try {
      const json = await fetchJson(modelUrl);
      fs.writeFileSync(path.join(outDir, "hf-trending-model.json"), JSON.stringify(json, null, 2), "utf-8");
      modelIds = extractHfTrendingIds(json).slice(0, 10);
    } catch (e) {
      errors.model = e instanceof Error ? e.message : String(e);
    }
  }

  if (needsDataset) {
    try {
      const json = await fetchJson(datasetUrl);
      fs.writeFileSync(path.join(outDir, "hf-trending-dataset.json"), JSON.stringify(json, null, 2), "utf-8");
      datasetIds = extractHfTrendingIds(json).slice(0, 10);
    } catch (e) {
      errors.dataset = e instanceof Error ? e.message : String(e);
    }
  }

  const lines: string[] = [];
  lines.push(`UTC: ${fetchedAtUtc}`);
  lines.push("");
  lines.push("Models Top10:");
  if (modelIds.length > 0) {
    lines.push(...modelIds);
  } else if (needsModel) {
    lines.push(`(fetch failed: ${errors.model || "unknown error"})`);
  } else {
    lines.push("(not requested)");
  }
  lines.push("");
  lines.push("Datasets Top10:");
  if (datasetIds.length > 0) {
    lines.push(...datasetIds);
  } else if (needsDataset) {
    lines.push(`(fetch failed: ${errors.dataset || "unknown error"})`);
  } else {
    lines.push("(not requested)");
  }
  lines.push("");

  fs.writeFileSync(path.join(outDir, "hf-trending-top10.txt"), lines.join("\n"), "utf-8");
  core.info(`Prefetched HF trending into ${path.join(outDir, "hf-trending-top10.txt")}`);
}

function installCodexCli(): void {
  core.info("codex not found, installing @openai/codex...");
  execSync("npm install -g @openai/codex", { stdio: "inherit" });

  try {
    let npmBin = "";
    try {
      npmBin = execSync("npm bin -g", { encoding: "utf-8" }).trim();
    } catch {
      // npm 10+ may not support `npm bin -g`
      const npmPrefix = execSync("npm prefix -g", { encoding: "utf-8" }).trim();
      if (npmPrefix) {
        npmBin = path.join(npmPrefix, "bin");
      }
    }
    if (npmBin) {
      addPath(npmBin);
      return;
    }
    core.warning("npm global bin path is empty; codex may not be on PATH.");
  } catch (error) {
    core.warning(
      `Failed to determine npm global bin path: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function installOpenCodeCli(): void {
  if (process.platform === "win32") {
    throw new Error("OpenCode install script requires bash; use a Linux/macOS runner or preinstall opencode.");
  }

  core.info("opencode not found, installing via official script...");
  execSync(
    "curl -fsSL https://raw.githubusercontent.com/opencode-ai/opencode/refs/heads/main/install | bash",
    { stdio: "inherit" }
  );

  const installDir = path.join(os.homedir(), ".opencode", "bin");
  if (fs.existsSync(installDir)) {
    addPath(installDir);
  } else {
    core.warning(`OpenCode install directory not found at ${installDir}; opencode may not be on PATH.`);
  }
}

function ensureCliAvailable(opencodeBin: string): void {
  if (resolveExecutable(opencodeBin)) return;

  const binaryName = normalizeCliName(opencodeBin);
  if (resolveExecutable(binaryName)) return;

  if (binaryName === "codex") {
    installCodexCli();
  } else if (binaryName === "opencode") {
    installOpenCodeCli();
  } else {
    throw new Error(
      `CLI binary not found: ${opencodeBin}. Set opencode_bin to "codex" or "opencode", or provide a valid path.`
    );
  }

  if (!resolveExecutable(opencodeBin) && !resolveExecutable(binaryName)) {
    throw new Error(`CLI binary "${opencodeBin}" not found after install.`);
  }
}

// 构建 OpenCode/Codex 环境变量
function buildOpenCodeEnv(userConfig: UserConfig): NodeJS.ProcessEnv {
  const coder: Record<string, unknown> = {};
  if (userConfig.model_name) {
    coder.model = userConfig.model_name;
  }
  if (Number.isFinite(userConfig.max_tokens) && userConfig.max_tokens > 0) {
    coder.maxTokens = userConfig.max_tokens;
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      permission: "allow",
      agents: {
        coder,
      },
    }),
  };

  // OpenAI 配置
  const openaiKey = core.getInput("openai_api_key") || process.env.OPENAI_API_KEY;
  const openaiBase = core.getInput("openai_api_base") || process.env.OPENAI_API_BASE;
  if (openaiKey) {
    env.OPENAI_API_KEY = openaiKey;
  }
  const codexKey = process.env.CODEX_API_KEY || openaiKey;
  if (codexKey) {
    env.CODEX_API_KEY = codexKey;
  }
  const githubToken = core.getInput("github_token") || process.env.GITHUB_TOKEN;
  if (githubToken) {
    env.GITHUB_TOKEN = githubToken;
    env.GH_TOKEN = githubToken;
  }
  if (openaiBase) {
    env.OPENAI_API_BASE = openaiBase;
    env.OPENAI_BASE_URL = openaiBase; // 某些库使用这个变量名
  }

  const subjectNumber =
    github.context.payload.pull_request?.number ||
    github.context.payload.issue?.number;
  const isPullRequestContext =
    !!github.context.payload.pull_request ||
    !!github.context.payload.issue?.pull_request;
  if (subjectNumber) {
    if (isPullRequestContext) {
      env.PR_NUMBER = String(subjectNumber);
    } else {
      env.ISSUE_NUMBER = String(subjectNumber);
    }
  }

  // Anthropic (Claude) 配置
  const anthropicKey = core.getInput("anthropic_api_key") || process.env.ANTHROPIC_API_KEY;
  const anthropicBase = core.getInput("anthropic_api_base") || process.env.ANTHROPIC_API_BASE;
  if (anthropicKey) {
    env.ANTHROPIC_API_KEY = anthropicKey;
  }
  if (anthropicBase) {
    env.ANTHROPIC_API_BASE = anthropicBase;
    env.ANTHROPIC_BASE_URL = anthropicBase;
  }

  // Google (Gemini) 配置
  const geminiKey = core.getInput("gemini_api_key") || process.env.GEMINI_API_KEY;
  const geminiBase = core.getInput("gemini_api_base") || process.env.GEMINI_API_BASE;
  if (geminiKey) {
    env.GEMINI_API_KEY = geminiKey;
  }
  if (geminiBase) {
    env.GEMINI_API_BASE = geminiBase;
  }

  return env;
}

// 运行 OpenCode/Codex
function runOpenCode(
  promptFile: string,
  userConfig: UserConfig,
  continueMode = false,
  overridePrompt?: string
): void {
  const opencodeBin = (core.getInput("opencode_bin") || "codex").trim();
  ensureCliAvailable(opencodeBin);
  const prompt = overridePrompt ?? fs.readFileSync(promptFile, "utf-8");
  const cliName = normalizeCliName(opencodeBin);
  ensureDir(path.join(process.cwd(), ".github-agent-data", "logs"));
  const cliLog = path.join(
    process.cwd(),
    ".github-agent-data",
    "logs",
    `${cliName}-${path.basename(promptFile).replace(/[^a-zA-Z0-9_.-]/g, "_")}-${Date.now()}.log`
  );
  const logFd = fs.openSync(cliLog, "w");

  try {
    if (cliName === "codex") {
      if (continueMode) {
        core.warning("codex exec does not support --continue; running a fresh session.");
      }
      const args = [
        "exec",
        "--full-auto",
        "--sandbox",
        "workspace-write",
      ];
      if (userConfig.model_name) {
        args.push("--model", userConfig.model_name);
      }
      const reasoningEffort = (core.getInput("model_reasoning_effort") || "").trim();
      if (reasoningEffort) {
        args.push("--config", `model_reasoning_effort=${reasoningEffort}`);
      }
      const disableResponseStorage = (core.getInput("disable_response_storage") || "").trim();
      if (disableResponseStorage) {
        args.push("--config", `disable_response_storage=${disableResponseStorage}`);
      }
      const openaiBase = (core.getInput("openai_api_base") || process.env.OPENAI_API_BASE || "").trim();
      if (openaiBase) {
        args.push("--config", "model_provider=codex-for-me");
        args.push("--config", "model_providers.codex-for-me.name=codex-for-me");
        args.push("--config", `model_providers.codex-for-me.base_url=${openaiBase}`);
        args.push("--config", "model_providers.codex-for-me.wire_api=responses");
        args.push("--config", "model_providers.codex-for-me.env_key=OPENAI_API_KEY");
      }
      args.push(prompt);
      core.info(`Running ${opencodeBin} exec (${path.basename(promptFile)})`.trim());
      execFileSync(opencodeBin, args, {
        stdio: ["ignore", logFd, logFd],
        env: buildOpenCodeEnv(userConfig),
      });
      return;
    }

    const args = ["run"];
    if (continueMode) {
      args.push("--continue");
    }
    args.push(prompt);

    core.info(`Running ${opencodeBin} (${path.basename(promptFile)})`.trim());
    execFileSync(opencodeBin, args, {
      stdio: ["ignore", logFd, logFd],
      env: buildOpenCodeEnv(userConfig),
    });
  } catch (e) {
    const tail = tailFile(cliLog);
    if (tail) {
      core.warning(`CLI log tail (${path.basename(cliLog)}):\n${tail}`);
    }
    throw e;
  } finally {
    try {
      fs.closeSync(logFd);
    } catch {
      // ignore
    }
    core.info(`CLI output saved to ${cliLog}`);
  }
}

// 验证输出并重试
function verifyAndResume(config: AgentConfig, maxRetries = 5, basePromptOverride?: string): void {
  const expectedFiles = EXPECTED_OUTPUTS[config.mode];

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const missingFiles = expectedFiles.filter((f) => !fileExists(f));

    if (missingFiles.length === 0) {
      core.info("All required output files present");
      return;
    }

    core.warning(
      `Missing files (attempt ${attempt}/${maxRetries}): ${missingFiles.join(", ")}`
    );

    if (attempt < maxRetries) {
      // 添加额外提示要求输出文件
      const extraPrompt = `\n\n# REQUIRED OUTPUTS\n${expectedFiles.map((f) => `- ${f}`).join("\n")}`;
      const basePrompt = basePromptOverride ?? fs.readFileSync(config.promptFile, "utf-8");
      const combinedPrompt = `${basePrompt}${extraPrompt}`;
      runOpenCode(config.promptFile, config.userConfig, true, combinedPrompt);
    }
  }

  // 最终检查
  const stillMissing = expectedFiles.filter((f) => !fileExists(f));
  if (stillMissing.length > 0) {
    core.warning(`Files still missing after ${maxRetries} attempts: ${stillMissing.join(", ")}`);
  }
}

// 后处理：Issue Chatter
async function postProcessIssueChatter(round: number): Promise<void> {
  const token = core.getInput("github_token") || process.env.GITHUB_TOKEN;
  if (!token) throw new Error("Missing GITHUB_TOKEN");

  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  const issueNumber = github.context.payload.issue?.number;
  if (!issueNumber) return;

  const jsonFile = ".github-agent-data/issue-response.json";
  const response = fileExists(jsonFile) ? JSON.parse(fs.readFileSync(jsonFile, "utf-8")) : null;
  const requiresCoder = !!response?.requires_coding_agent;
  const issueType = typeof response?.issue_type === "string" ? response.issue_type.toLowerCase() : "";
  const coderCommand = issueType === "bug" ? "fix" : "feat";
  const issueTitle = (github.context.payload.issue?.title || "").trim();

  // 发布回复
  const replyFile = ".github-agent-data/issue-reply.md";
  if (fileExists(replyFile)) {
    const replyContent = fs.readFileSync(replyFile, "utf-8");
    const coderBlock = requiresCoder
      ? `\n\n@coder ${coderCommand} #${issueNumber}\n\n> 目标：处理 Issue #${issueNumber}${issueTitle ? `: ${issueTitle}` : ""}\n> 交付：创建 PR，描述包含 \`Closes #${issueNumber}\`。\n`
      : "";
    const triggerMarker = requiresCoder ? "\n<!-- agent-trigger:coder -->" : "";
    const body = `${replyContent}${coderBlock}\n\n<!-- agent:issue-chatter-agent -->\n<!-- agent-round:${round} -->${triggerMarker}`;

    await withRetry("issues.createComment", () =>
      octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body,
      })
    );
    core.info("Posted issue reply");
  }

  // 处理 JSON 响应
  if (response) {
    // 添加标签
    if (response.labels?.add?.length > 0) {
      await withRetry("issues.addLabels", () =>
        octokit.rest.issues.addLabels({
          owner,
          repo,
          issue_number: issueNumber,
          labels: response.labels.add,
        })
      );
    }

    // 移除标签
    for (const label of response.labels?.remove || []) {
      try {
        await withRetry(
          "issues.removeLabel",
          () =>
            octokit.rest.issues.removeLabel({
              owner,
              repo,
              issue_number: issueNumber,
              name: label,
            }),
          { maxAttempts: 3 }
        );
      } catch (e) {
        core.debug(`Failed to remove label "${label}": ${e instanceof Error ? e.message : e}`);
      }
    }

    // 关闭 Issue
    if (response.suggested_action === "close") {
      await withRetry("issues.update", () =>
        octokit.rest.issues.update({
          owner,
          repo,
          issue_number: issueNumber,
          state: "closed",
        })
      );
    }

    // 设置输出
    core.setOutput("requires_coding_agent", response.requires_coding_agent);
  }
}

// 后处理：PR Reviewer
async function postProcessPRReviewer(round: number): Promise<void> {
  const token = core.getInput("github_token") || process.env.GITHUB_TOKEN;
  if (!token) throw new Error("Missing GITHUB_TOKEN");

  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  const prNumber =
    github.context.payload.pull_request?.number ||
    github.context.payload.issue?.number;
  if (!prNumber) return;

  const jsonFile = ".github-agent-data/review-response.json";
  const summaryFile = ".github-agent-data/review-summary.md";
  const resultFile = ".github-agent-data/review-result.md";
  const suggestionsFile = ".github-agent-data/review-suggestions.md";
  const legacyReplyFile = ".github-agent-data/review-reply.md";

  const hasNewArtifacts =
    fileExists(jsonFile) &&
    fileExists(summaryFile) &&
    fileExists(resultFile) &&
    fileExists(suggestionsFile);

  if (!hasNewArtifacts) {
    if (!fileExists(jsonFile) || !fileExists(legacyReplyFile)) return;
    const replyContent = fs.readFileSync(legacyReplyFile, "utf-8");
    const response = JSON.parse(fs.readFileSync(jsonFile, "utf-8"));
    const body = `${replyContent}\n\n<!-- agent:pr-reviewer-agent -->\n<!-- agent-round:${round} -->`;

    const eventMap: Record<string, "APPROVE" | "REQUEST_CHANGES" | "COMMENT"> = {
      approve: "APPROVE",
      request_changes: "REQUEST_CHANGES",
      comment: "COMMENT",
    };
    const event = eventMap[response.verdict] || "COMMENT";

    try {
      await withRetry("pulls.createReview", () =>
        octokit.rest.pulls.createReview({
          owner,
          repo,
          pull_number: prNumber,
          body,
          event,
        })
      );
      core.info(`Posted PR review: ${event}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const isSelfReviewError = /own pull request/i.test(message);
      if (isSelfReviewError && (event === "APPROVE" || event === "REQUEST_CHANGES")) {
        core.warning(`Cannot submit ${event} on own PR; falling back to COMMENT`);
        await withRetry("pulls.createReview(comment)", () =>
          octokit.rest.pulls.createReview({
            owner,
            repo,
            pull_number: prNumber,
            body,
            event: "COMMENT",
          })
        );
        core.info("Posted PR review: COMMENT");
      } else {
        throw e;
      }
    }

    core.setOutput("requires_coding_agent", response.requires_coding_agent);
    return;
  }

  const response = JSON.parse(fs.readFileSync(jsonFile, "utf-8"));
  const summaryContent = fs.readFileSync(summaryFile, "utf-8").trim();
  const resultContent = fs.readFileSync(resultFile, "utf-8").trim();
  const suggestionsContent = fs.readFileSync(suggestionsFile, "utf-8").trim();

  const isZh = /[\u4e00-\u9fff]/.test(`${summaryContent}\n${resultContent}\n${suggestionsContent}`);

  // 1) Summary comment
  const summaryBody = `${summaryContent}\n\n<!-- agent:pr-reviewer-agent -->\n<!-- agent-round:${round} -->\n<!-- agent-part:summary -->`;
  await withRetry("issues.createComment(pr-review-summary)", () =>
    octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: summaryBody,
    })
  );
  core.info("Posted pr-reviewer summary comment");

  // 2) Review result (as PR review)
  const reviewBody = `${resultContent}\n\n<!-- agent:pr-reviewer-agent -->\n<!-- agent-round:${round} -->\n<!-- agent-part:result -->`;
  const eventMap: Record<string, "APPROVE" | "REQUEST_CHANGES" | "COMMENT"> = {
    approve: "APPROVE",
    request_changes: "REQUEST_CHANGES",
    comment: "COMMENT",
  };
  const event = eventMap[response.verdict] || "COMMENT";

  try {
    await withRetry("pulls.createReview", () =>
      octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        body: reviewBody,
        event,
      })
    );
    core.info(`Posted PR review: ${event}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const isSelfReviewError = /own pull request/i.test(message);
    if (isSelfReviewError && (event === "APPROVE" || event === "REQUEST_CHANGES")) {
      core.warning(`Cannot submit ${event} on own PR; falling back to COMMENT`);
      await withRetry("pulls.createReview(comment)", () =>
        octokit.rest.pulls.createReview({
          owner,
          repo,
          pull_number: prNumber,
          body: reviewBody,
          event: "COMMENT",
        })
      );
      core.info("Posted PR review: COMMENT");
    } else {
      throw e;
    }
  }

  core.setOutput("requires_coding_agent", response.requires_coding_agent);

  // 3) Suggestions comment (+ optional coder trigger)
  const keyIssues = Array.isArray(response.key_issues) ? response.key_issues : [];
  const issueLines = keyIssues.slice(0, 5).map((issue: any) => {
    const file = typeof issue?.file === "string" ? issue.file : "";
    const startLine = Number.isFinite(issue?.start_line) ? issue.start_line : undefined;
    const title = typeof issue?.title === "string" ? issue.title : "";
    const severity = typeof issue?.severity === "string" ? issue.severity : "";
    const location = file ? `${file}${startLine ? `:${startLine}` : ""}` : "(unknown)";
    const parts = [location, title].filter(Boolean).join(" ");
    const suffix = severity ? ` [${severity}]` : "";
    return `> - ${parts}${suffix}`.trim();
  });

  const suggestionsLines: string[] = [];
  suggestionsLines.push(suggestionsContent || "N/A");
  if (response.requires_coding_agent) {
    const instructionLine = isZh
      ? "> 按下面这些点修复并 push 到当前 PR 分支："
      : "> Fix the following issues and push to the current PR branch:";
    suggestionsLines.push("");
    suggestionsLines.push("@coder");
    suggestionsLines.push("");
    suggestionsLines.push(instructionLine);
    suggestionsLines.push(...(issueLines.length > 0 ? issueLines : ["> - N/A"]));
    suggestionsLines.push("");
    suggestionsLines.push("<!-- agent-trigger:coder -->");
  }
  suggestionsLines.push("");
  suggestionsLines.push("<!-- agent:pr-reviewer-agent -->");
  suggestionsLines.push(`<!-- agent-round:${round} -->`);
  suggestionsLines.push("<!-- agent-part:suggestions -->");

  await withRetry("issues.createComment(pr-review-suggestions)", () =>
    octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: suggestionsLines.join("\n"),
    })
  );
  core.info("Posted pr-reviewer suggestions comment");
}

async function ensureIssuePullRequest(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  issueNumber: number,
  headBranch: string,
  baseBranch: string
): Promise<{ number: number; url: string } | null> {
  const existing = await withRetry("pulls.list", () =>
    octokit.rest.pulls.list({
      owner,
      repo,
      state: "open",
      head: `${owner}:${headBranch}`,
      per_page: 5,
    })
  );
  if (existing.data.length > 0) {
    const pr = existing.data[0];
    return pr.html_url ? { number: pr.number, url: pr.html_url } : null;
  }

  const issueTitle =
    (github.context.payload.issue?.title || "").trim() ||
    `Issue #${issueNumber}`;
  const prefix = headBranch.startsWith("ai-fix/") ? "fix" : "feat";
  const title = `${prefix}: ${issueTitle}`.slice(0, 120);
  const body = `Closes #${issueNumber}`;

  const created = await withRetry("pulls.create", () =>
    octokit.rest.pulls.create({
      owner,
      repo,
      title,
      head: headBranch,
      base: baseBranch,
      body,
    })
  );

  return created.data.html_url
    ? { number: created.data.number, url: created.data.html_url }
    : null;
}

async function pushIssueCoderChangesAndCreatePr(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<{ branch?: string; prUrl?: string; compareUrl?: string }> {
  const baseBranch = getDefaultBranch();

  commitAllChanges(`chore(agent): update for #${issueNumber}`);

  const aheadCountText = gitTryOutput(["rev-list", "--count", `origin/${baseBranch}..HEAD`]);
  const aheadCount = aheadCountText ? parseInt(aheadCountText, 10) : 0;
  if (!Number.isFinite(aheadCount) || aheadCount <= 0) {
    core.info("No new commits to push");
    return {};
  }

  const desiredBranch = `${inferIssueBranchPrefix()}/issue-${issueNumber}-auto`;
  const branch = ensureNonDefaultBranch(baseBranch, desiredBranch);

  await gitPushWithRetry(branch, { forceWithLease: branch.startsWith("ai-") });

  const compareUrl = `https://github.com/${owner}/${repo}/compare/${baseBranch}...${branch}?expand=1`;
  try {
    const pr = await ensureIssuePullRequest(octokit, owner, repo, issueNumber, branch, baseBranch);
    return { branch, prUrl: pr?.url, compareUrl };
  } catch (e) {
    core.warning(`Failed to create PR via API: ${e instanceof Error ? e.message : String(e)}`);
    return { branch, compareUrl };
  }
}

// 后处理：Coder (Issue/PR)
async function postProcessCoder(
  mode: AgentMode,
  round: number
): Promise<void> {
  const token = core.getInput("github_token") || process.env.GITHUB_TOKEN;
  if (!token) throw new Error("Missing GITHUB_TOKEN");

  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  const issueNumber =
    github.context.payload.issue?.number ||
    github.context.payload.pull_request?.number;
  if (!issueNumber) return;

  const summaryFile =
    mode === "pr-coder"
      ? ".github-agent-data/pr-update-summary.md"
      : ".github-agent-data/issue-reply.md";

  if (fileExists(summaryFile)) {
    const content = fs.readFileSync(summaryFile, "utf-8");
    const agentName = mode === "pr-coder" ? "pr-coder-agent" : "issue-coder-agent";
    let prefix = "";
    if (mode === "issue-coder") {
      try {
        const result = await pushIssueCoderChangesAndCreatePr(octokit, owner, repo, issueNumber);
        if (result.prUrl) {
          prefix = `已创建 PR: ${result.prUrl}\n\n`;
        } else if (result.branch) {
          prefix = `已推送分支: ${result.branch}\n创建 PR: ${result.compareUrl || "(not available)"}\n\n`;
        }
      } catch (e) {
        core.warning(`Failed to push/create PR: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (mode === "pr-coder") {
      const prCheckout = currentPrCheckout && currentPrCheckout.prNumber === issueNumber ? currentPrCheckout : null;
      if (!prCheckout) {
        core.warning("Missing PR checkout info; cannot push pr-coder changes automatically");
      } else if (!prCheckout.canPush) {
        prefix = `无法推送到 fork PR 分支（${prCheckout.headRef}），仅输出修改摘要。\n\n`;
      } else {
        commitAllChanges(`chore(agent): update PR #${issueNumber}`);
        const aheadCountText = gitTryOutput(["rev-list", "--count", `origin/${prCheckout.headRef}..HEAD`]);
        const aheadCount = aheadCountText ? parseInt(aheadCountText, 10) : 0;
        if (!Number.isFinite(aheadCount) || aheadCount <= 0) {
          core.info("No new commits to push");
        } else {
          try {
            await gitPushWithRetry(prCheckout.headRef, { forceWithLease: false });
            prefix = `已更新 PR 分支: ${prCheckout.headRef}\n\n`;
          } catch (e) {
            core.warning(`Failed to push PR branch: ${e instanceof Error ? e.message : String(e)}`);
            const current = currentBranchName();
            if (current && current !== "HEAD") {
              try {
                await gitPushWithRetry(current, { forceWithLease: false });
                const compareUrl = `https://github.com/${owner}/${repo}/compare/${prCheckout.baseRef}...${current}?expand=1`;
                prefix = `推送到 PR 分支失败，已推送到分支: ${current}\n创建 PR: ${compareUrl}\n\n`;
              } catch (e2) {
                core.warning(`Failed to push fallback branch: ${e2 instanceof Error ? e2.message : String(e2)}`);
              }
            }
          }
        }
      }
    }

    const body = `${prefix}${content}\n\n<!-- agent:${agentName} -->\n<!-- agent-round:${round} -->`;

    await withRetry("issues.createComment", () =>
      octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body,
      })
    );
    core.info(`Posted ${mode} summary`);
  }
}

// 后处理路由
async function postProcess(config: AgentConfig, round: number): Promise<void> {
  switch (config.mode) {
    case "issue-chatter":
      await postProcessIssueChatter(round);
      break;
    case "pr-reviewer":
      await postProcessPRReviewer(round);
      break;
    case "issue-coder":
    case "pr-coder":
      await postProcessCoder(config.mode, round);
      break;
  }
}

function removeFileIfExists(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (e) {
    core.debug(`Failed to remove ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// 主函数
async function main(): Promise<void> {
  try {
    if (github.context.eventName === "issue_comment") {
      const body = github.context.payload.comment?.body || "";
      const isAgentComment = body.includes("<!-- agent:") && body.includes("<!-- agent-round:");
      const isCoderTrigger = body.includes("<!-- agent-trigger:coder -->");
      if (isAgentComment && !isCoderTrigger) {
        core.info("Skipping agent-generated issue_comment event");
        return;
      }
    }

    const config = detectAgentMode();
    core.info(`Agent mode: ${config.mode}`);

    configureGit(config.mode);
    installContextSkills();

    if (github.context.eventName === "issue_comment" && github.context.payload.issue?.pull_request) {
      const token = core.getInput("github_token") || process.env.GITHUB_TOKEN;
      if (!token) throw new Error("Missing GITHUB_TOKEN");
      const prNumber = github.context.payload.issue.number;
      const { owner, repo } = github.context.repo;
      const octokit = github.getOctokit(token);
      currentPrCheckout = await checkoutPullRequestHead(octokit, owner, repo, prNumber);
    }

    const round = await checkRoundLimit(config.maxRounds);
    core.setOutput("current_round", round);

    if (config.mode === "issue-chatter") {
      await prefetchHfTrendingIfNeeded();
    }

    // 运行 Agent
    runOpenCode(config.promptFile, config.userConfig);

    // 验证输出 + 重试
    verifyAndResume(config);

    // 后处理
    await postProcess(config, round);

    core.info("Agent completed successfully");
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "MAX_ROUNDS_REACHED") {
        core.warning("Agent stopped due to max rounds limit");
        return;
      }
      core.setFailed(error.message);
    } else {
      core.setFailed("Unknown error occurred");
    }
  }
}

main();
