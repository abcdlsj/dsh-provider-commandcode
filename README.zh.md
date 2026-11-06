# dsh-commandcode

**DeepSeek Harness**（`dsh`）的 Command Code（[commandcode.ai](https://commandcode.ai)）provider 插件。

一个路由（`commandcode`），两条 Provider API 线：**Claude 走 Anthropic Messages**，**其余模型走 Chat Completions**。带实时模型发现、零配置复用 `command-code` CLI 的登录、reasoning effort、工具调用、图片、缓存 token 统计，以及 `/commandcode` 诊断命令。

非官方社区插件，与 Command Code / DeepSeek 无从属关系。

## 前置条件

- `dsh` 0.2.x（`engines.dsh: >=0.2.0 <0.3.0`）。
- 具备 **Provider API** 权限的 Command Code 账号（Pro、GOAT、Max、Ultra、Team、Provider）。**Go** 套餐没有 Provider API，请求会返回 `403 upgrade_required`。

## 安装

```sh
# npm（发布后）
dsh plugin --profile web add dsh-commandcode

# 本地 checkout
dsh plugin --profile web add /path/to/dsh-commandcode

# git（pnpm 会先要求允许该包的构建脚本）
dsh plugin --profile web add github:abcdlsj/dsh-commandcode
```

随后 `dsh web`（或 `dsh tui`、`dsh headless "任务"`）。插件行为 `llm-commandcode`，可在 profile 的 `cordis.patch.yml` 里覆盖其 `config`。

## 认证

每个请求解析 API key，取第一个命中：

1. **credentials 服务**中 `apiKeyEnv`（默认 `COMMANDCODE_API_KEY`）的值 —— web Models 页写入的就是它。
2. 启动环境里的 `$COMMANDCODE_API_KEY`（或配置的 `apiKeyEnv` 名）。
3. `$COMMAND_CODE_API_KEY`。
4. 依次尝试 auth 文件：配置的 `authFile`、`$COMMANDCODE_AUTH_FILE`、`~/.commandcode/auth.json`（`command-code` CLI 自己的登录）、`$PI_CODING_AGENT_DIR/auth.json` 或 `~/.pi/agent/auth.json`、`~/.omp/agent/auth.json`。

所以已经在用 `command-code` CLI 的用户无需任何配置。headless profile 会禁用 credentials 服务，这正是 CLI 登录兜底存在的原因。

不可用的值（空白，或 HTTP header 无法承载的字符）会以 `INVALID_CREDENTIAL` 报出需要修改的设置项，绝不回显 key。

## 选择模型

在模型选择器里选 `Command Code`，或在 profile overlay 中固定：

```yaml
- id: agent-default-model
  config:
    provider: commandcode
    model: claude-opus-5
```

所有在线模型都可服务：Claude 走 `/messages`，其他走 `/chat/completions`（即使该模型同时声明了 `/responses`）。工具调用、流式 reasoning、图片、usage（含缓存与 reasoning token）、stop 序列和 `max_tokens` 均已映射。

## 配置

全部字段可选，默认值无需配置即可工作。

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `apiKeyEnv` | `COMMANDCODE_API_KEY` | 凭据引用，同时是环境变量名。 |
| `authFile` | — | 显式 command-code `auth.json` 路径，优先于默认文件。 |
| `baseURL` | `https://api.commandcode.ai/provider/v1` | Provider API 根地址。 |
| `modelsURL` | `<baseURL>/models` | 模型列表端点。 |
| `discovery` | `true` | 拉取实时模型表；`false` 只用内置快照。 |
| `modelsMaxAgeMs` | `300000` | 列表新鲜期。 |
| `modelsTimeoutMs` | `10000` | 单次发现请求超时。 |
| `models` | `[]` | 声明模型或覆盖单个模型（见下）。 |
| `cliVersion` | `1.88.3` | `x-command-code-version` 头，需对应已发布 CLI。 |
| `projectSlug` | `cwd` 末段 | `x-project-slug` 头。 |
| `sessionId` | 每进程一个 UUID | `x-session-id` 头。 |
| `zdr` | `false` | 发送 `x-cmd-zdr: 1`，只走零数据保留上游（通常更贵）。 |
| `thinking` | `effort` | Messages 线 thinking 方式：`effort`（`output_config.effort`）、`budget`（`budget_tokens`）、`disabled`。 |
| `reasoningBack` | `auto` | Chat 线回放历史 reasoning：`auto`（仅当模型要求）、`always`、`never`。 |
| `maxTokens` | `64000` | 默认输出上限；请求显式值优先。 |
| `maxRequestImageBytes` | `5242880` | 单请求解码后图片字节预算。 |
| `maxImagesPerRequest` | `10` | 单请求图片数量上限。 |
| `streamIdleTimeoutMs` | `180000` | 流读取空闲超时。 |
| `retryPolicy` | dsh 默认（`RATE_LIMIT`、`SERVER` 等） | 模型请求重试策略；`{ mode: always }` 全部重试。 |

单模型覆盖可补充列表未含的模型，或修正能力：

```yaml
- id: llm-commandcode
  name: dsh-commandcode
  config:
    models:
      - id: acme/next-model
        name: Acme Next
        wire: chat            # 或 messages
        contextWindow: 400000
        maxTokens: 64000
        inputModalities: [text, image]
        efforts: [low, high, max]
```

## 斜杠命令

挂载了命令注册表时可用 `/commandcode`：

- `/commandcode status` —— 端点、模型表来源、凭据来源（绝不显示 key）、thinking 与回放策略。
- `/commandcode models [过滤词]` —— 已服务模型及其线路、上下文大小。
- `/commandcode refresh` —— 强制刷新一次并报告来源与告警。

## 行为说明

- **降级只学一次。** 模型拒绝 `reasoning_effort`（Chat 线）或 `thinking`/`output_config`（Messages 线）时，插件去掉该字段重试同一请求，记一条告警，此后该模型不再发送；要求回传 `reasoning_content` 的模型同理。
- **Messages 线不回放 thinking。** 本适配器不保存签名，回放无签名 thinking 会被 Anthropic 拒绝，因此历史 thinking 一律不发送。
- **模型发现不会拖垮请求。** 刷新失败保留上一次好列表，再退到内置快照；告警在 `/commandcode status` 中可见。
- **错误码稳定。** `401` → `INVALID_CREDENTIAL`；`403 upgrade_required` → `INVALID_CREDENTIAL` 且说明套餐原因；`403 MODEL_NOT_IN_PLAN` → `PLAN_REQUIRED`；`402`/配额 → `QUOTA`；`429` → `RATE_LIMIT`（带 `retry-after`）；上下文超限 → `CONTEXT_WINDOW_EXCEEDED`；Google 模型的 JSON 指针会被内联。
- **图片走 harness attachment 服务**，每个请求只重新编码一次；超出预算时报 `IMAGE_OFFLOAD_REQUIRED`，不静默丢弃。
- **每个请求都带 harness 归因头**（`user-agent: deepseek-harness/…`），外加 CLI 自己的 `x-command-code-version`、`x-cli-environment`、`x-project-slug`、`x-taste-learning`、`x-session-id`。

## 排错

| 现象 | 原因与处理 |
| --- | --- |
| `INVALID_CREDENTIAL: Invalid 'Authorization' header or token` | key 过期或错误。重新运行 `command-code` 登录，或设置 `COMMANDCODE_API_KEY`。 |
| `403 upgrade_required` | 套餐无 Provider API（Go）。升级套餐，或改用官方 CLI。 |
| `PLAN_REQUIRED: MODEL_NOT_IN_PLAN` | 该模型不在你的套餐内。换模型或购买额外用量。 |
| `MISSING_CREDENTIAL` | 任何来源都没有 key。设置 `COMMANDCODE_API_KEY` 或用 CLI 登录。 |
| `422 cmd_zdr_no_providers` | 开了 `zdr: true` 但没有零保留上游服务该模型。关掉 ZDR 或换模型。 |
| 模型列表陈旧或为空 | `/commandcode refresh`；检查 `modelsURL` 与代理。`discovery: false` 固定使用内置快照。 |

## 开发

```sh
npm install --ignore-scripts   # 首次安装否则会执行 prepare 构建
npm run typecheck
npm test
npm run build
```

模块划分：`config.ts`（schema 与连接）、`catalog.ts`（发现、兜底、覆盖）、`credentials.ts`、`adapter.ts`（传输、请求头、降级）、`chat.ts`/`messages.ts`（线路序列化与 SSE 翻译）、`sse.ts`、`errors.ts`、`images.ts`、`google-schema.ts`、`static-catalog.ts`。

## 致谢

- 模型能力表（输入模态、reasoning efforts、最大输出）来自 `command-code` CLI manifest，经由 [pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider)（MIT）整理。
- `google-schema.ts` 改编自 magpie-community [plugins](https://github.com/magpie-community/plugins) 的 Command Code 包（MIT）。

## 许可

MIT。
