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

function resolvePromptPath(relativePath: string): string {
  return path.join(ACTION_ROOT, relativePath);
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
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

function parseBooleanInput(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
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
    max_rounds: 3,
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
    const hasCoder = body.includes("@coder");

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

function hasUncommittedChanges(): boolean {
  const output = gitTryOutput(["status", "--porcelain"]);
  return !!output;
}

function commitAllChanges(message: string): boolean {
  if (!hasUncommittedChanges()) return false;
  git(["add", "-A"]);
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
    ".github-agent-data/review-reply.md",
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

  labels = [l.get("name") for l in issue.get("labels", []) if isinstance(l, dict) and l.get("name")]

  with open(out_path, "w", encoding="utf-8") as f:
    f.write(f"# Issue #{issue_number}: {str(issue.get('title','')).strip()}\\n\\n")
    f.write(f"- Repo: {repo}\\n")
    f.write(f"- State: {issue.get('state','')}\\n")
    f.write(f"- Author: {(issue.get('user') or {}).get('login','')}\\n")
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
      created = fmt_dt(c.get("created_at"))
      f.write(f"### {author} @ {created}\\n\\n")
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
    core.info(`Running ${opencodeBin} exec with ${promptFile}`.trim());
    execFileSync(opencodeBin, args, {
      stdio: "inherit",
      env: buildOpenCodeEnv(userConfig),
    });
    return;
  }

  const args = ["run"];
  if (continueMode) {
    args.push("--continue");
  }
  args.push(prompt);

  core.info(`Running ${opencodeBin} ${continueMode ? "--continue" : ""} with ${promptFile}`.trim());
  execFileSync(opencodeBin, args, {
    stdio: "inherit",
    env: buildOpenCodeEnv(userConfig),
  });
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

  // 发布回复
  const replyFile = ".github-agent-data/issue-reply.md";
  if (fileExists(replyFile)) {
    const replyContent = fs.readFileSync(replyFile, "utf-8");
    const body = `${replyContent}\n\n<!-- agent:issue-chatter-agent -->\n<!-- agent-round:${round} -->`;

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
  const jsonFile = ".github-agent-data/issue-response.json";
  if (fileExists(jsonFile)) {
    const response = JSON.parse(fs.readFileSync(jsonFile, "utf-8"));

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

  // 发布 Review
  const replyFile = ".github-agent-data/review-reply.md";
  const jsonFile = ".github-agent-data/review-response.json";

  if (fileExists(replyFile) && fileExists(jsonFile)) {
    const replyContent = fs.readFileSync(replyFile, "utf-8");
    const response = JSON.parse(fs.readFileSync(jsonFile, "utf-8"));
    const body = `${replyContent}\n\n<!-- agent:pr-reviewer-agent -->\n<!-- agent-round:${round} -->`;

    // 映射 verdict 到 GitHub review event
    const eventMap: Record<string, "APPROVE" | "REQUEST_CHANGES" | "COMMENT"> =
      {
        approve: "APPROVE",
        request_changes: "REQUEST_CHANGES",
        comment: "COMMENT",
      };
    const event = eventMap[response.verdict] || "COMMENT";

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

    core.setOutput("requires_coding_agent", response.requires_coding_agent);
  }
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
): Promise<{ branch?: string; prUrl?: string }> {
  const baseBranch = getDefaultBranch();

  commitAllChanges(`chore(agent): update for #${issueNumber}`);

  const aheadCountText = gitTryOutput(["rev-list", "--count", `origin/${baseBranch}..HEAD`]);
  const aheadCount = aheadCountText ? parseInt(aheadCountText, 10) : 0;
  if (!Number.isFinite(aheadCount) || aheadCount <= 0) {
    core.info("No new commits to push");
    return {};
  }

  const chatterIssueType = readIssueChatterResponse()?.issue_type;
  const desiredBranch = `${inferIssueBranchPrefix(chatterIssueType)}/issue-${issueNumber}-auto`;
  const branch = ensureNonDefaultBranch(baseBranch, desiredBranch);

  await gitPushWithRetry(branch, { forceWithLease: branch.startsWith("ai-") });

  const pr = await ensureIssuePullRequest(octokit, owner, repo, issueNumber, branch, baseBranch);
  return { branch, prUrl: pr?.url };
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
          prefix = `已推送分支: ${result.branch}\n\n`;
        }
      } catch (e) {
        core.warning(`Failed to push/create PR: ${e instanceof Error ? e.message : String(e)}`);
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

type IssueChatterResponse = {
  issue_type?: string;
  suggested_action?: string;
  requires_coding_agent?: boolean;
};

function readIssueChatterResponse(): IssueChatterResponse | null {
  const jsonFile = ".github-agent-data/issue-response.json";
  if (!fileExists(jsonFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(jsonFile, "utf-8")) as IssueChatterResponse;
  } catch (e) {
    core.warning(`Failed to parse ${jsonFile}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

function isAutoIssueCoderEnabled(): boolean {
  const parsed = parseBooleanInput(core.getInput("auto_coder"));
  if (parsed === undefined) return true;
  return parsed;
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

async function runAutoIssueCoder(
  userConfig: UserConfig,
  round: number,
  chatterResponse: IssueChatterResponse
): Promise<void> {
  const issueNumber = github.context.payload.issue?.number;
  const issueTitle = (github.context.payload.issue?.title || "").trim();
  if (!issueNumber) return;

  core.info("Auto-running issue-coder based on issue-chatter decision");

  // Preserve chatter reply before coder overwrites issue-reply.md
  const chatterReplyFile = ".github-agent-data/issue-reply.md";
  if (fileExists(chatterReplyFile)) {
    try {
      const chatterReply = fs.readFileSync(chatterReplyFile, "utf-8");
      fs.writeFileSync(".github-agent-data/issue-chatter-reply.md", chatterReply, "utf-8");
    } catch (e) {
      core.warning(`Failed to preserve ${chatterReplyFile}: ${e instanceof Error ? e.message : String(e)}`);
    }
    removeFileIfExists(chatterReplyFile);
  }

  const coderMode: AgentMode = "issue-coder";
  const coderPromptFile = resolvePromptPath("prompts/issue-coder.md");
  const coderConfig: AgentConfig = {
    mode: coderMode,
    promptFile: coderPromptFile,
    contextFile: ".github-agent-data/issue-context.md",
    maxRounds: userConfig.max_rounds,
    userConfig,
  };

  configureGit(coderMode);

  // Ensure stale outputs don't trick verification.
  for (const outputFile of EXPECTED_OUTPUTS[coderMode]) {
    removeFileIfExists(outputFile);
  }

  const basePrompt = fs.readFileSync(coderPromptFile, "utf-8");
  const issueType = (chatterResponse.issue_type || "").toLowerCase();
  const coderCommand = issueType === "bug" ? "fix" : "feat";
  const instruction = [
    "# Manager Instruction (auto-run)",
    "Issue Chatter 判定需要写代码，自动触发 Issue Coder。",
    "",
    `@coder ${coderCommand} #${issueNumber}`,
    "",
    "> 目标：",
    `> 解决 Issue #${issueNumber}${issueTitle ? `: ${issueTitle}` : ""}。`,
    "> 交付：",
    `> - 创建一个 PR，并在 PR 描述里包含 \`Closes #${issueNumber}\`。`,
    "> - 变更尽量小，保持生产可用。",
    "",
  ].join("\n");
  const combinedPrompt = `${basePrompt}\n\n${instruction}`;

  runOpenCode(coderPromptFile, userConfig, false, combinedPrompt);
  verifyAndResume(coderConfig, 5, combinedPrompt);
  await postProcessCoder(coderMode, round);
}

// 主函数
async function main(): Promise<void> {
  try {
    const config = detectAgentMode();
    core.info(`Agent mode: ${config.mode}`);

    configureGit(config.mode);
    installContextSkills();

    const round = await checkRoundLimit(config.maxRounds);
    core.setOutput("current_round", round);

    // 运行 Agent
    runOpenCode(config.promptFile, config.userConfig);

    // 验证输出 + 重试
    verifyAndResume(config);

    // 后处理
    await postProcess(config, round);

    if (
      config.mode === "issue-chatter" &&
      isAutoIssueCoderEnabled()
    ) {
      const response = readIssueChatterResponse();
      if (response?.requires_coding_agent) {
        await runAutoIssueCoder(config.userConfig, round, response);
      }
    }

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
