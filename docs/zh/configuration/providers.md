# 平台与模型

Kimi Code CLI 支持同时接入多家 LLM 平台——用 Kimi Code 托管服务一键登录、用 Anthropic API key 接 Claude、用 OpenAI 兼容协议连接第三方推理服务。每个供应商对应一种 API 协议，模型在供应商之上声明自己的名称、上下文长度和能力。本页介绍如何在 `config.toml` 里配置各种供应商。

## 支持的供应商类型

`providers` 表里的 `type` 字段决定使用哪种协议实现：

| 类型 | 协议 | 典型用途 |
| --- | --- | --- |
| `kimi` | OpenAI 兼容 | Kimi Code 托管服务、Kimi Platform API 密钥 |
| `anthropic` | Anthropic Messages | Claude 系列模型 |
| `openai` | OpenAI Chat Completions | OpenAI 及兼容服务、DeepSeek、Qwen 等 |
| `openai_responses` | OpenAI Responses API | OpenAI 较新的 Responses 接口 |
| `google-genai` | Google GenAI | Gemini API |
| `vertexai` | Google GenAI on Vertex | Google Cloud Vertex AI |

所有供应商默认以流式方式与模型交互。thinking、视觉、工具调用等能力按模型名前缀自动匹配，通常不需要手动声明。

**凭证优先级**：`api_key` 直接字段 > `[providers.<name>.env]` 子表键 > 两者都缺时启动报错。CLI 不会从 shell 环境变量自动取凭证——详见[配置覆盖：供应商凭证](./overrides.md#供应商凭证)。

## `/login` 与 `/logout` — 交互式供应商管理

运行 `/login`，通过以下两种认证方式之一连接供应商：

- **Sign in with an account (OAuth)**：支持 Kimi Code、xAI、使用 ChatGPT Plus 或 Pro 账号的 OpenAI Codex、Anthropic Claude Pro/Max，以及 GitHub Copilot。
- **Connect with an API key**：选择 Kimi Platform 区域、[models.dev](https://models.dev/) 目录中的已知供应商，或自定义 `api.json` registry。

OAuth token 与 `config.toml` 分开存储；供应商引用和模型元数据仍使用 Kimi 现有配置格式。`/logout` 会逐一列出凭据，账号会标记为 **(OAuth)**，静态凭据会标记为 **(API key)**；即使两者使用相同的供应商 ID，也会作为两个独立选项显示。也可清除 **All OAuth accounts**、**All API-key providers** 或 **All credentials**。每个组合都会显示所包含的凭据。普通登出只清除凭据，并保留供应商、模型配置和已保存会话。活动 OAuth 会话保持打开；活动 API key 会话会关闭，以免在内存中继续保留已清除的 key。

登录 OAuth 账号会为该供应商选择账号认证，并清除同一供应商条目中保存的 API key。独立的登出选项仍可安全处理手动组合或遗留的两种凭据。

如需完整删除，请在 `/logout` 中选择 **Remove saved provider configuration…**。该操作会再次确认删除所选供应商、模型、关联凭据及托管服务。手动写入 `config.toml` 的供应商会自动显示；`config.toml` 是存储格式，而不是登录方式。

Kimi Code 目前为每个供应商保存一个 OAuth 账号。对已连接的供应商再次运行 `/login` 时，可以继续使用当前账号，或选择 **Switch account**。只有新登录成功后才会替换原凭证；取消或登录失败时，当前账号仍可继续使用。

连接已知第三方供应商时，Kimi Code 会从 [models.dev](https://models.dev/) 拉取模型目录，然后依次选择供应商、输入 API 密钥并选择默认模型。目录未声明协议类型的供应商会按 OpenAI 兼容协议导入，并显示 "guessed" 提示；目录没有可用端点时，Kimi Code 会先要求输入 base URL。Amazon Bedrock、Cohere 等专有协议和无法识别的显式协议会被拒绝导入。已下线（deprecated）和 alpha 状态的模型不会出现在导入列表中。

使用自定义 registry 时，粘贴其地址和 Bearer token。CLI 会创建 `providers` / `models` 条目。后续启动时，同一个 registry 地址下的供应商会一起刷新，因此上游新增、删除供应商以及模型元数据变化都会同步。

非交互环境下也可以用 shell 命令完成同样操作：[`kimi provider`](../reference/kimi-command.md#kimi-provider)。

## `kimi`

用于对接 Moonshot AI 的 OpenAI 兼容接口，包括 Kimi Code 托管服务和 Kimi Platform API 密钥。

- 默认 `base_url`：`https://api.moonshot.ai/v1`
- 凭证键名：`KIMI_API_KEY`、`KIMI_BASE_URL`
- 额外能力：支持视频上传

```toml
[providers.kimi]
type = "kimi"
base_url = "https://api.moonshot.ai/v1"
api_key = "sk-xxxxx"
```

> 使用 Kimi Code 托管服务时，`/login` 登录后会自动配置 `base_url` 和凭证，无需手动填写。

## `anthropic`

用于对接 Claude API。标准 Claude 模型自动启用视觉、工具调用及 Thinking（如支持）；自定义或未覆盖的模型需在 `[models.<alias>]` 里显式声明 `capabilities`。

- 默认 `base_url`：跟随 Anthropic SDK 默认值
- 凭证键名：`ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`
- 默认 `max_tokens`：按模型自动推断。如需覆盖，在模型别名上设 `max_output_size`

```toml
[providers.anthropic]
type = "anthropic"
api_key = "sk-ant-xxxxx"

[models."claude-opus-4-7"]
provider = "anthropic"
model = "claude-opus-4-7"
max_context_size = 200000
# max_output_size = 32000  # 可选，省略时使用模型推断的默认值
```

## `openai`

用于对接 OpenAI Chat Completions 协议，也可连接任何兼容该协议的第三方服务（覆盖 `base_url` 即可）。

第三方推理模型（DeepSeek、Qwen、One API 等）开箱即用：CLI 自动处理 `reasoning_content` 字段和 `reasoning_effort` 注入。如果你的网关用非标准字段名返回推理内容，在模型别名上设 `reasoning_key` 覆盖。

- 默认 `base_url`：`https://api.openai.com/v1`
- 凭证键名：`OPENAI_API_KEY`、`OPENAI_BASE_URL`

```toml
[providers.openai]
type = "openai"
base_url = "https://api.openai.com/v1"
api_key = "sk-xxxxx"
```

## `openai_responses`

对应 OpenAI 较新的 Responses API，始终以流式方式工作。配置方式与 `openai` 相同。

- 默认 `base_url`：`https://api.openai.com/v1`
- 凭证键名：`OPENAI_API_KEY`、`OPENAI_BASE_URL`

```toml
[providers.openai-responses]
type = "openai_responses"
base_url = "https://api.openai.com/v1"
api_key = "sk-xxxxx"
```

## `google-genai`

用于直连 Google Gemini API。thinking、视觉及多模态能力按模型名自动识别。

- 凭证键名：`GOOGLE_API_KEY`

```toml
[providers.gemini]
type = "google-genai"
api_key = "xxxxx"
```

如需经由兼容 Gemini 协议的代理/网关访问，可设置 `base_url`（或 `GOOGLE_GEMINI_BASE_URL` 环境变量）；不填时使用 SDK 默认地址 `https://generativelanguage.googleapis.com`。

> 只填**主机根地址**。Google GenAI SDK 会自行追加 API 版本与路径（如 `/v1beta/models/<model>:generateContent`），所以结尾带 `/v1beta` 会导致路径重复成 `/v1beta/v1beta/…`。

```toml
[providers.gemini]
type = "google-genai"
api_key = "xxxxx"
base_url = "https://your-gateway.example"
```

## `vertexai`

与 `google-genai` 共用实现，`type = "vertexai"` 时切换到 Vertex AI 访问路径。

认证走 Google Cloud 标准 ADC 流程（`gcloud auth application-default login` 或 `GOOGLE_APPLICATION_CREDENTIALS` 服务账号 JSON），这部分与 Kimi Code 无关。**项目 ID 和区域必须写在 `[providers.vertexai.env]` 子表里**——直接在 shell 里 `export GOOGLE_CLOUD_PROJECT` 不会被 CLI 读取。

```toml
[providers.vertexai]
type = "vertexai"

[providers.vertexai.env]
GOOGLE_CLOUD_PROJECT = "my-gcp-project"
GOOGLE_CLOUD_LOCATION = "us-central1"
```

```sh
gcloud auth application-default login   # 一次性完成认证
kimi
```

如需让 Vertex 请求走自定义（如代理）端点，可设置 `base_url`（或 `GOOGLE_VERTEX_BASE_URL` 环境变量）；不填时使用 SDK 默认的区域化 `*-aiplatform.googleapis.com` 地址。与 `google-genai` 一样，只填主机根地址——SDK 会自行追加 `/v1beta1/publishers/google/models/…`。

## OAuth 与凭证注入

Kimi Code、xAI、OpenAI Codex、Anthropic 与 GitHub Copilot 可以使用 OAuth 而非静态 API 密钥。运行 `/login` 并选择 **Sign in with an account (OAuth)** 后，内置认证工具链会存储并刷新凭证，同时自动写入供应商与模型配置。Anthropic 使用浏览器 PKCE，并通过本地回调服务器自动捕获重定向（手动粘贴作为回退）；OpenAI Codex 提供浏览器或设备码两种选择；GitHub Copilot 支持填写 GitHub Enterprise 域名；其余供应商使用各自支持的设备码流程。

xAI、Anthropic 与 GitHub Copilot 每次登录时都会重新获取 models.dev 元数据；Copilot 还会按当前账户实际启用的模型进行过滤。这是登录时刷新，而不是后台自动更新。Kimi Code 使用托管模型端点，OpenAI Codex 则使用下文说明的显式列表。

例如，xAI 与其他供应商一样使用现有的 `config.toml` 架构：

```toml
[providers.xai]
type = "openai"
base_url = "https://api.x.ai/v1"
oauth = { storage = "file", key = "oauth/xai" }

[models."xai/grok-4.5"]
provider = "xai"
model = "grok-4.5"
wire = "openai_responses"
```

供应商默认使用 Chat Completions；Grok 4.5 等需要 Responses API 的模型会设置逐模型 `wire` 覆盖。token 本身不会写入 `config.toml`。

OpenAI Codex 使用从 Pi 适配的一小组显式模型，而不是 models.dev，因为 Pi 同样不会从 models.dev 获取这些订阅模型。更新 Pi reference 不会自动更新 Kimi；Pi 修改该列表后仍需人工检查同步。

Radius 不作为内置 OAuth 选项：它是可配置的网关生态，而不是一个固定、可移植的订阅 OAuth 协议。请通过 API key 或自定义 registry，使用实际部署的端点与模型 registry 接入。

## 下一步

- [配置文件](./config-files.md) — `providers` 和 `models` 表的完整字段参考
- [配置覆盖](./overrides.md) — 供应商凭证的解析优先级规则
- [环境变量](./env-vars.md) — 各供应商对应的凭证键名列表
