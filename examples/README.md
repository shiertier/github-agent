# Examples

此目录包含可直接复制使用的 workflow 示例。

## 使用方法

将 `github-agent.yml` 复制到你的仓库 `.github/workflows/` 目录即可：

```bash
mkdir -p .github/workflows
cp github-agent.yml .github/workflows/
```

然后在 GitHub 仓库设置中添加以下 Secrets：

- `OPENAI_API_KEY` - OpenAI API Key
- （可选）`OPENAI_API_BASE` - OpenAI 兼容 API Base URL（自建/代理端点）

并在仓库 **Settings → Actions → General → Workflow permissions**：
- 选择 **Read and write permissions**
- 勾选 **Allow GitHub Actions to create and approve pull requests**（否则无法自动创建 PR）

## 配置选项

| 参数             | 必填 | 默认值     | 说明           |
| ---------------- | ---- | ---------- | -------------- |
| `github_token`   | ✅   | -          | GitHub Token   |
| `openai_api_key` | ✅   | -          | OpenAI API Key |
| `openai_api_base` | ❌  | -          | OpenAI 兼容 API Base URL |
| `opencode_bin`   | ❌   | `codex`    | 选择 `codex` 或 `opencode`（运行时自动安装） |
| `max_rounds`     | ❌   | `8`        | 最大循环轮数   |
