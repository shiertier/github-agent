# Repository Guidelines

## 项目结构与模块组织

- `src/` 为 TypeScript 源码，`src/main.ts` 是 Action 入口。
- `dist/` 为 `tsc` 编译产物（自动生成，勿手改）。
- `prompts/` 存放提示词模板，使用角色 + kebab-case 命名（如 `pr-reviewer.md`）。
- `docs/` 提供架构、实现、部署与命令参考文档。
- `examples/` 含示例工作流配置。
- `action.yml` 为 Action 元数据定义。

## 构建、测试与本地开发命令

- `bun run build`：使用 `tsc` 编译到 `dist/`（同时完成类型检查）。
- `bun run dev`：直接运行 `src/main.ts` 进行本地调试。
- `bun run start`：运行编译后的 `dist/main.js`。

## 编码风格与命名约定

- 使用 TypeScript 且开启 `strict`（见 `tsconfig.json`）。
- 缩进 2 空格、字符串双引号、行末分号，保持与 `src/main.ts` 一致。
- 提示词文件使用角色命名与短横线风格（如 `issue-coder.md`）。
- 当前未配置格式化/ lint 工具，提交前手动保持风格一致。

## 测试指南

- 当前仓库未配置自动化测试框架。
- 变更后至少运行 `bun run build`，并在 fork 或沙盒仓库中通过测试工作流验证 Action 行为。
- 若新增测试，请在此文档补充测试位置与运行方式（如 `tests/`、`__tests__/`）。

## 提交与 PR 指南

- 仓库尚无提交历史，暂无既定规范；请使用清晰的祈使式提交信息（如 “Add PR reviewer prompt”）。
- PR 需包含简要说明、关联 Issue（如有），以及涉及的 workflow/config 变更说明。
- 若修改提示词或行为逻辑，请在 PR 描述中说明，并同步更新 `docs/` 中相关文档。

## 安全与配置提示

- 通过 GitHub Actions Secret 配置 `OPENAI_API_KEY`。
- 用户配置可通过 `.github_agent.toml` 或环境变量提供，避免提交敏感信息。
- 运行时产物（如 `.github-agent-data/`）为临时目录，不应提交。
