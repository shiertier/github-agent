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

## 配置选项

| 参数             | 必填 | 默认值     | 说明           |
| ---------------- | ---- | ---------- | -------------- |
| `github_token`   | ✅   | -          | GitHub Token   |
| `openai_api_key` | ✅   | -          | OpenAI API Key |
| `opencode_bin`   | ❌   | `opencode` | OpenCode 路径  |
| `max_rounds`     | ❌   | `3`        | 最大循环轮数   |
