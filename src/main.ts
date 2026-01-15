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

function resolvePromptPath(relativePath: string): string {
  return path.join(ACTION_ROOT, relativePath);
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
    model_name: "gpt-4o",
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
    envConfig.max_tokens = parseInt(process.env.GITHUB_AGENT_MAX_TOKENS, 10);
  }
  if (process.env.GITHUB_AGENT_FALLBACK_MODELS) {
    envConfig.fallback_models = process.env.GITHUB_AGENT_FALLBACK_MODELS.split(",").map((s) => s.trim());
  }
  if (process.env.GITHUB_AGENT_RESPONSE_LANGUAGE) {
    envConfig.response_language = validateResponseLanguage(process.env.GITHUB_AGENT_RESPONSE_LANGUAGE);
  }
  if (process.env.GITHUB_AGENT_MAX_ROUNDS) {
    envConfig.max_rounds = parseInt(process.env.GITHUB_AGENT_MAX_ROUNDS, 10);
  }

  // 3. 从 action inputs 加载（最高优先级）
  const inputConfig: Partial<UserConfig> = {};
  const modelName = core.getInput("model_name");
  if (modelName) inputConfig.model_name = modelName;
  
  const maxTokens = core.getInput("max_tokens");
  if (maxTokens) inputConfig.max_tokens = parseInt(maxTokens, 10);
  
  const fallbackModels = core.getInput("fallback_models");
  if (fallbackModels) inputConfig.fallback_models = fallbackModels.split(",").map((s) => s.trim());
  
  const responseLang = core.getInput("response_language");
  if (responseLang) inputConfig.response_language = validateResponseLanguage(responseLang);
  
  const maxRounds = core.getInput("max_rounds");
  if (maxRounds) inputConfig.max_rounds = parseInt(maxRounds, 10);

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

  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });

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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      permission: "allow",
      agents: {
        coder: {
          model: userConfig.model_name,
          maxTokens: userConfig.max_tokens,
        },
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
  if (openaiBase) {
    env.OPENAI_API_BASE = openaiBase;
    env.OPENAI_BASE_URL = openaiBase; // 某些库使用这个变量名
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
function verifyAndResume(config: AgentConfig, maxRetries = 5): void {
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
      const basePrompt = fs.readFileSync(config.promptFile, "utf-8");
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

    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
    core.info("Posted issue reply");
  }

  // 处理 JSON 响应
  const jsonFile = ".github-agent-data/issue-response.json";
  if (fileExists(jsonFile)) {
    const response = JSON.parse(fs.readFileSync(jsonFile, "utf-8"));

    // 添加标签
    if (response.labels?.add?.length > 0) {
      await octokit.rest.issues.addLabels({
        owner,
        repo,
        issue_number: issueNumber,
        labels: response.labels.add,
      });
    }

    // 移除标签
    for (const label of response.labels?.remove || []) {
      try {
        await octokit.rest.issues.removeLabel({
          owner,
          repo,
          issue_number: issueNumber,
          name: label,
        });
      } catch (e) {
        core.debug(`Failed to remove label "${label}": ${e instanceof Error ? e.message : e}`);
      }
    }

    // 关闭 Issue
    if (response.suggested_action === "close") {
      await octokit.rest.issues.update({
        owner,
        repo,
        issue_number: issueNumber,
        state: "closed",
      });
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

    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      body,
      event,
    });
    core.info(`Posted PR review: ${event}`);

    core.setOutput("requires_coding_agent", response.requires_coding_agent);
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
    const body = `${content}\n\n<!-- agent:${agentName} -->\n<!-- agent-round:${round} -->`;

    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
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

// 主函数
async function main(): Promise<void> {
  try {
    const config = detectAgentMode();
    core.info(`Agent mode: ${config.mode}`);

    configureGit(config.mode);

    const round = await checkRoundLimit(config.maxRounds);
    core.setOutput("current_round", round);

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
