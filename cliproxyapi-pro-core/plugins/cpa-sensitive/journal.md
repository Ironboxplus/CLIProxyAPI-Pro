# SensitivePromptMasker 开发与部署记录

## 2026-07-16：Claude / Codex 全协议 JSON 兼容修复

### 背景与线上症状

目标是在 CPA Pro 官方动态插件接口中，对发送给模型的敏感信息进行 marker 替换，并在模型响应中恢复原值，同时兼容 Claude Messages、Codex/OpenAI Responses 和 OpenAI Chat Completions 的非流式与流式响应。

vmiss CPA Pro 的 Logs Viewer 已确认插件能够执行请求脱敏，例如：

```text
SensitivePromptMasker request.redacted count=<n> source=claude target=claude stream=false
```

但真实使用中先后出现以下错误：

1. Claude `context_management.edits[].type` 被改写，导致 `clear_thinking_20251015` 等固定 tag 校验失败。
2. Claude `tool_reference.tool_name` 被改成 restore marker，导致 `Tool reference ... not found in available tools`。
3. Claude tool result 中的 `image.source.data` 被扫描，导致 `invalid base64 data`。
4. Codex/OpenAI 工具参数中的 Windows 路径恢复后少一层 JSON escaping，导致内层 arguments 出现 `d:\OneDrive...` 形式的非法 JSON，并由客户端报告 `Bad escaped character`。
5. `response.custom_tool_call_input.delta` 被错误当作 JSON 字符串处理，可能改变 apply-patch 等自由文本中的反斜杠、引号和换行。
6. Codex `response.output_item.done`、`response.function_call_arguments.done` 和 `response.completed` 中的完整 arguments 没有走语义恢复，仍可能触发同类 JSON 错误。

同时出现过 Claude Opus 上游 `429`。当时只能确认第一跳由 provider 返回，尚不能排除插件对 prompt cache 的影响。后续结合插件开关 A/B、usage SQLite、真实失败请求离线重放和 Claude Code 缓存源码继续调查，已确认旧 marker 设计和过宽的 PII 规则会破坏 prompt cache；详细结论见本文后续“429 与 prompt cache 根因修复”。

### 根因

第一版实现把请求视为任意 JSON 字符串树，用全局字段名黑名单决定哪些值不扫描。这种方法没有区分：

- 应脱敏的自然语言文本；
- 可以脱敏但需要嵌套 JSON 恢复的工具参数；
- 不可修改的协议 tag、ID、工具引用、签名、encrypted content、base64/data URL 和文件载荷；
- Claude signed thinking 中必须保持原子一致的 `thinking` 与 `signature`；
- Codex function-call JSON arguments 与 custom-tool 自由文本。

字段名黑名单还会造成反向隐私漏洞。例如任意 `tool_use.input` 中的业务字段如果叫 `name`、`account_id` 或 `status`，旧实现会误认为它们是协议字段并跳过脱敏。

### Retrieval MCP 与源码核验

本次 review 使用 Retrieval MCP 的 `search_code`，并用本地 `rg`/逐行读取复核当前工作树。

检索范围：

```text
E:/Go/aiproxy/CPA/CLIProxyAPIPlus
E:/JETB/pythons/playground/codex
```

确认的真实结构包括：

- Claude `tool_result.content[].tool_reference.tool_name`；
- Claude signed-thinking 的 `thinking_delta` / `signature_delta`；
- Claude 允许无 `signature_delta` 的 thinking 流；
- Codex `response.function_call_arguments.delta/done`；
- Codex `response.custom_tool_call_input.delta` 的自由文本语义；
- Codex `response.output_item.done.item.arguments`；
- Codex `response.completed.response.output[]`；
- Responses `input_image.image_url`、`input_file.file_data/file_url`；
- Chat 嵌套 `file.file_data`、`input_audio.data`、`video_url.url`；
- `response.incomplete` 与 `response.done` 的终止语义。

### TDD：第一轮 RED

新增测试首先在当前实现上按目标行为失败，复现：

- signed thinking 正文被恢复但签名不变；
- custom-tool delta 多一层 JSON escaping；
- `.done` / `output_item.done` / `response.completed` 的完整 arguments 恢复后仍是非法 JSON；
- `tool_use.input` 中的 `name/account_id/status` 漏脱敏；
- Responses 图片与文件载荷被改写；
- 普通业务字段 `arguments` 被误当成嵌套 JSON；
- `response.incomplete` 未识别为终止事件。

### 第一轮实现

- 工具参数流按协议区分 JSON arguments 与普通文本。
- 非流式恢复先解析外层 JSON，再根据 function-call 语义恢复嵌套 arguments。
- Codex 非 delta 的 `response.*` 事件统一走语义恢复。
- `response.incomplete` 加入终止判断。
- signed thinking 请求块、redacted thinking 和 encrypted reasoning 按 opaque block 处理。
- Claude thinking delta 暂不直接恢复，以避免破坏随后 signature。
- Responses 直接图片/文件载荷增加保护。

### 第二轮 review 与 RED

两个独立 terra 审查发现第一轮仍有边界问题：

1. 任意工具 JSON 仍可能通过伪造 `type: thinking/message/function_call/input_image` 触发协议规则。
2. 无签名 Claude thinking 会永久暴露 marker。
3. Chat 的嵌套 file/audio/video wrapper 未保护。
4. `response.done` 未触发 stream/session 清理。

对应新增第二轮 RED 测试。

### 第二轮实现

请求与响应遍历改为 `payloadMode` 上下文：

- `payloadNone`：正常协议树；
- `payloadArbitrary`：任意工具业务 JSON，禁止依据后代对象的 `type` 猜协议；
- `payloadProtocolContent`：只在已知 tool-result/function-output/content 边界识别严格协议内容块。

具体行为：

- `tool_use.input` 和 custom-tool input 的所有后代都按业务 JSON 扫描/恢复。
- 工具业务对象即使包含 `type: thinking/message/function_call/input_image`，也不能触发 opaque 或结构字段跳过。
- 嵌套 `file`、`input_audio`、`video_url` 传输载荷保持原样。
- `response.done`、`response.incomplete`、`response.completed`、`response.failed` 均视为 Codex 终止事件。
- Claude thinking delta 使用按 block index 的缓冲：
  - 遇到 `signature_delta`，原样释放 marker 文本和签名，保持签名一致；
  - 到 `content_block_stop` 仍无签名，才恢复 marker；
  - 每个 thinking block 的缓冲上限为 1 MiB，避免无界内存增长。

### 当前本地验证

CPA overlay 插件目录：

```text
E:/Go/aiproxy/CPA/CLIProxyAPI-Pro/cliproxyapi-pro-core/plugins/cpa-sensitive
```

独立仓库：

```text
E:/Go/aiproxy/CPA/SensitivePromptMasker
```

已通过：

```text
go test ./... -count=1
go vet ./...
```

覆盖的协议测试包括：

- OpenAI Chat content/reasoning/tool arguments；
- Claude text/thinking/partial_json/tool_reference/tool_result/image；
- Codex output text/function arguments/custom-tool input；
- SSE marker 任意切分；
- Windows 路径、引号和反斜杠嵌套 JSON；
- 非流式与流式完整 function-call 事件；
- signed/unsigned thinking；
- 媒体、文件、音频和视频载荷；
- 协议终止与 session 清理条件。

本机 race test 未完成：Windows 启用 `CGO_ENABLED=1` 后缺少 `gcc`，错误为：

```text
cgo: C compiler "gcc" not found
```

不能把 race test 记为通过。后续在编译机或 Linux 环境补充 cgo/race 验证。

### `.99` 编译记录

编译机为 `10.100.100.99`，Windows 主机名 `DESKTOP-CUP9FO9`，当前 Go 环境：

```text
go version go1.26.2 windows/amd64
```

机器上没有可复用的 Zig，因此从 Zig 官方下载 `zig-x86_64-windows-0.16.0.zip`，先落到本机，再按约束上传到 `.99`：

```text
URL:    https://ziglang.org/download/0.16.0/zig-x86_64-windows-0.16.0.zip
size:   97217739 bytes
SHA256: 68659EB5F1E4EB1437A722F1DD889C5A322C9954607F5EDCF337BC3684A75A7E
```

上传到 `.99` 的源码包包含当前工作树和本 journal，不包含 `.git` 与旧二进制：

```text
SensitivePromptMasker-source.zip
size:   66028 bytes
SHA256: 038DC088967E4D69901B3838E9D1A61801276656423C87A9D8BD9B5344028BE0
```

`.99` 上先通过：

```text
go test ./... -count=1
go vet ./...
```

Linux amd64 动态插件使用以下关键参数交叉编译：

```text
CGO_ENABLED=1
GOOS=linux
GOARCH=amd64
CC=zig.exe cc -target x86_64-linux-gnu.2.17
CXX=zig.exe c++ -target x86_64-linux-gnu.2.17
go build -trimpath -buildvcs=false -buildmode=c-shared -ldflags "-s -w -X main.cpaSensitivePluginVersion=0.1.0"
```

构建产物：

```text
cpa-sensitive.so
size:   10957088 bytes
SHA256: 620E3DF7C783847D0B6555D31075D28326825F7FF41F96ECE9E4FC5F29ED525B
format: ELF64 x86-64
```

已验证导出符号：

```text
cliproxy_plugin_init
cliproxyPluginCall
cliproxyPluginFree
cliproxyPluginShutdown
```

产物传输链路严格为 `.99 -> 本机 -> vmiss`，没有从 `.99` 直传 vmiss，也没有使用或修改 4090。

### vmiss CPA Pro 部署

只操作 vmiss 的 CPA Pro 容器 `cli-proxy-api-dev`，没有改动另一套 CPA、其他容器或 Docker 环境。CPA Pro 运行版本为 `v7.2.78-pro`。

目标路径：

```text
/root/docker/CLI-dev/plugins/linux/amd64/cpa-sensitive.so
```

部署前旧插件 SHA256：

```text
4e58f1d051274e380fc448b4b3870ad931fe80b0244d0308808e2d0506bb611d
```

备份时间戳为 `20260716-044201`，已备份旧 `.so` 和 `config.yaml`。新文件先以 `.so.new` 上传并检查 ELF、`ldd` 与 SHA256，再原子替换。线上文件当前 SHA256 与 `.99` 构建结果一致：

```text
620e3df7c783847d0b6555d31075d28326825f7ff41f96ece9e4fc5f29ed525b
```

当前配置：

```yaml
plugins:
  configs:
    cpa-sensitive:
      enabled: true
      sanitization:
        enabled: false
        replacement_groups: []
      privacy_shield:
        enabled: true
        gitleaks: true
        pii_enabled: true
        pii_aggressive: true
```

`privacy_shield` 的所有普通与 aggressive 类型均已开启，包括 path、relative_path、username_hostname、generic_token 和 loose_secret。`sanitization` 是独立的静态 list/map 关键字替换功能；当前没有配置 replacement group，因此仍保持关闭，不影响自动敏感信息检测与恢复。

容器重启后检查结果：

```text
running=true
restart_count=0
status=running
plugin_id=cpa-sensitive
plugin_name=CPA Sensitive
plugin_version=0.1.0
```

### Haiku 真实模型验证

使用 CPA 当前真实 OAuth provider 和模型 `claude-haiku-4-5-20251001`，通过容器网络地址 `http://172.18.0.5:8317` 验证。测试请求中的 API key 只从 vmiss 配置读取，脚本不打印 key、请求正文或脱敏原值。

最终一轮结果为 7/7：

```text
PASS claude_nonstream_tool HTTP 200
PASS claude_stream_tool HTTP 200
PASS codex_nonstream_tool HTTP 200
PASS codex_stream_tool HTTP 200
PASS openai_chat_tool HTTP 200
PASS claude_context_tag HTTP 200
PASS claude_base64_image HTTP 200
all_passed=true total=7
```

验证内容：

- Claude Messages 非流式 `tool_use.input` 中 Windows 路径精确恢复；
- Claude Messages 流式 `partial_json` 拼接后可被标准 JSON parser 解析，Windows 路径精确恢复；
- Codex/OpenAI Responses 非流式 `function_call.arguments` 合法且精确恢复；
- Codex/OpenAI Responses 流式 delta、done、output item、completed 中非空 arguments 均为合法 JSON；
- OpenAI Chat 非流式 tool arguments 合法且精确恢复；
- `context_management.edits[].type=clear_thinking_20251015` 在开启合法 thinking 配置后返回 200；
- 64x64 PNG base64 原样通过 Claude 图片请求；
- 所有响应均检查不存在 `CPA_RESTORE_SECRET_` marker 泄漏。

第一次使用字符串形式 Responses `input` 时，当前 CPA Pro 转 Claude 路径返回 `messages: at least one message is required`；改为 Codex/Responses 客户端实际使用的结构化 `input[].content[].input_text` 后通过。这属于 CPA 的请求适配边界，不是插件 arguments 恢复错误。

第一次图片测试使用 1x1 PNG，Claude 返回 `Could not process image`；改为有效的 64x64 PNG 后返回 200，说明 base64 字段未被插件污染。

### Logs Viewer 验证

CPA Logs Viewer 的 `Current runtime: CPA / Log Content` 对应：

```text
/root/docker/CLI-dev/logs/main.log
```

真实测试已写入安全元数据日志，且同时覆盖三种 source：

```text
SensitivePromptMasker request.redacted count=2 source=claude target=claude ... model=claude-haiku-4-5-20251001
SensitivePromptMasker response.restored count=1 source=claude ...
SensitivePromptMasker request.redacted count=2 source=openai-response target=claude ...
SensitivePromptMasker response.restored count=1 source=openai-response ...
SensitivePromptMasker request.redacted count=2 source=openai target=claude ...
SensitivePromptMasker response.restored count=1 source=openai ...
```

`main.log` 中能搜到 8 条历史 marker，全部是新插件部署前已发生的 `clear_thinking` 和 `Tool reference` 400 记录，最后一条时间为 `2026-07-16 15:26:08`。从本次部署后的日志区间开始重新统计为 0，没有新增 marker 错误。

### 尚未完成或仍需注意

1. Windows 本机 race test 因缺少 `gcc` 未运行，不能宣称 `go test -race` 已通过。
2. 当前真实验证覆盖了最关键的 Claude/Codex/OpenAI 工具参数、context tag 和图片字段；signed thinking、unsigned thinking、custom-tool/apply-patch、文件/音频/视频等组合主要由单元测试覆盖，未逐项消耗真实模型请求重复验证。

### Git 提交与 CI

独立仓库已使用以下身份 amend 原提交并按要求执行 `force-with-lease`：

```text
ironbox <ironboxminus@gmail.com>
```

GitHub Actions `Build` 首轮最终结果为 success，验证的 commit tree 与本次代码修复一致。完成的 job：

```text
Test
Build linux/amd64
Build linux/arm64
Build darwin/amd64
Build darwin/arm64
Build windows/amd64
Build windows/arm64
Build freebsd/amd64
```

已确认实际生成 7 个构建 artifact：

```text
cpa-sensitive_0.0.0-dev_linux_amd64.zip
cpa-sensitive_0.0.0-dev_linux_arm64.zip
cpa-sensitive_0.0.0-dev_darwin_amd64.zip
cpa-sensitive_0.0.0-dev_darwin_arm64.zip
cpa-sensitive_0.0.0-dev_windows_amd64.zip
cpa-sensitive_0.0.0-dev_windows_arm64.zip
cpa-sensitive_0.0.0-dev_freebsd_amd64.zip
```

## 2026-07-16：429 与 prompt cache 根因修复

### 插件开关 A/B 与 usage 证据

插件开启时，旧 marker 每次请求都包含新的随机 nonce。Fable 同一会话连续请求的 `cache_read_tokens` 始终为 0，而 `cache_creation_tokens` 从 136176 持续增长到 147721，随后开始连续 429。插件关闭后，Fable 恢复为：

```text
cache_creation_tokens=84708 cache_read_tokens=0
cache_creation_tokens=2893  cache_read_tokens=84708
cache_creation_tokens=292   cache_read_tokens=87601
```

这说明 CPA 的 cooling 文案是首次 provider 429 之后的二次状态；插件真正的触发方式是不断改变 Claude 的缓存前缀，把正常 cache read 变成完整 cache creation。

第一轮修复将每请求 nonce 改成进程级随机 HMAC key，能够在同一进程中恢复缓存。Opus 实际记录从 `cache_creation_tokens=434624` 转为下一轮 `cache_read_tokens=434624`。但独立进程测试仍证明相同内容在插件重启后生成不同 marker，因此进程级随机 key 仍会在每次 CPA 重启后打穿缓存。

### 真实 Fable 失败请求离线重放

对现有 429 错误日志中的 86651 字节 Fable 请求进行纯离线重放，没有调用模型，也没有输出原文。旧规则产生 88 个 mapping：

```text
pii-generic-token             69
pii-generic-token-aggressive  16
pii-path                       2
pii-phone                      1
```

其中 69 个普通 generic token 和 11 个 aggressive generic token 全部以 `mcp__` 开头，是公开 MCP 工具标识符，不是秘密。剩余 aggressive 命中也全部是小写单词和 `-/_` 组成的公开长标识符。电话规则只统计 7–15 位数字，还会把 `2026-07-16` / `20260716` 当成电话号码。

修复后的同一请求只产生 3 个 mapping：

```text
pii-path   2
pii-phone  1
```

`mcp__` mapping 为 0，generic-token mapping 为 0；将三个 marker 离线替换回原值后，请求与原始 86651 字节逐字节一致。

### 本次实现

1. marker 改为 `SHA-256(domain + JSON path + rule ID + finding index)` 的短 Base32 ID，不再使用 nonce、随机 key 或敏感原文。相同 JSON 位置跨请求、跨进程、跨 CPA 重启保持一致；原文变化不会改变 marker，恢复映射仍按请求隔离。
2. generic-token 验证器排除 `mcp__...` 和由小写自然单词加 `-/_` 组成的长公开标识符，同时保留混合大小写/数字的高熵 token 检测。
3. phone 验证器排除合法的 8 位日历日期，包括带分隔符和紧凑形式。
4. 请求脱敏不再 marshal 整棵 JSON。新实现只替换确认命中的 JSON string span，未命中的字段顺序、空白、转义和原始字节保持不变。
5. 对 duplicate-key 等无法唯一映射语义路径的少见合法 JSON，保留旧版整体 marshal fallback，避免把以前可接受的请求改成插件错误。
6. `X-Forwarded-Host` 在插件 request interceptor 中改写为 `api.anthropic.com`，不把真实代理 host 继续送往上游。该能力只覆盖插件之后的上游请求；CPA 在插件执行前捕获的原始 error request log 不属于插件可修改范围。

### TDD 与本地验证

新增测试先在旧实现上得到可复现失败，再完成实现：

```text
TestPrivacyMarkerIsStableAcrossProcesses
TestPrivacyMarkerUsesLocationInsteadOfSecretValue
TestPrivacyShieldPreservesUntouchedJSONBytes
TestPrivacyShieldFallsBackForDuplicateJSONKeys
TestGenericTokenDetectorIgnoresMCPToolIdentifiers
TestPhoneDetectorIgnoresCalendarDates
TestRequestInterceptorsMaskForwardedHost
```

当前本地结果：

```text
go test ./...                                      PASS
go vet ./...                                       PASS
BenchmarkRestoreContentManyMappings                108.7 ns/op, 112 B/op, 1 alloc/op
真实 Fable 429 请求离线回放                       PASS, 88 mappings -> 3 mappings
未命中 JSON 字节回环                              byte-identical=true
```

Windows 本机 `go test -race` 因 CGO 未启用未执行，必须在 `.99` 的 CGO/Zig 环境继续验证。此节记录完成时，新 `.so` 尚未部署，vmiss 插件保持关闭，也没有发送新的真实模型探测请求。

## 2026-07-16：同步 standalone v0.1.2

权威源码仓库为 `Ironboxplus/SensitivePromptMasker`。本兼容目录已同步 v0.1.2 的
`engine.go`、`privacy.go`、`plugin.go` 和 `plugin_test.go`：

- 响应 session 同时关联 `cpa_request_id`、`RequestBody`、`OriginalRequest` 和 body hash；
- 请求被 CPA 翻译或后置插件改写后，可用无歧义 marker 反查 session；
- 并发 session 对相同 marker 映射到不同原值时拒绝猜测，避免跨请求恢复；
- 新 marker 为纯字母数字 `CPAS...`，恢复端继续支持旧 marker；
- 修复完整响应和 Claude/OpenAI/Codex 流式工具参数中的文件名、路径与
  `working_directory` 恢复。

兼容目录独立执行 `go test ./...` 与 `go vet ./...` 均通过。完整 TDD、`.99` 构建哈希、
vmiss 部署和 Haiku 6/6 真实验证记录保存在 standalone 仓库的 `journal.md`。
