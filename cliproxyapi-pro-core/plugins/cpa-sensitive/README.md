# CPA Sensitive plugin

This directory is the CPA Pro compatibility copy of
[`Ironboxplus/SensitivePromptMasker`](https://github.com/Ironboxplus/SensitivePromptMasker).
The runtime core is synchronized with standalone release `v0.1.2`; CPA Pro keeps
only the surrounding build/config integration needed to bundle the official
dynamic plugin.

`cpa-sensitive` is a standalone CLIProxyAPI C-ABI plugin extracted from the
Octopus prompt sanitization and Privacy Shield work. CPA itself only supplies
the public interceptor lifecycle and a stable `cpa_request_id` metadata value.

The top-level compatibility layer selects an explicit adapter from CPA's
`SourceFormat` / `ToFormat`: Claude handles `system`, Anthropic message content,
and `content_block_delta` / `message_stop`; Codex handles Responses-style
`instructions`, `input`, `response.output_text.delta`, function-call argument
deltas, and `response.completed`. OpenAI Chat uses the generic chat adapter.
The replacement, detector, marker, and state code remains protocol-neutral.

The plugin runs in four stages:

1. `request.intercept_before`: apply ordered literal replacements to system,
   developer, assistant, and Gemini `model` text fields.
2. `request.intercept_after`: scan the final provider payload with Gitleaks,
   built-in PII rules, and optional custom regular expressions; replace findings
   with request-scoped markers.
3. `response.intercept_after`: restore markers in non-stream JSON responses.
4. `response.intercept_stream_chunk`: restore complete and cross-chunk markers
   while preserving JSON escaping.

Octopus `replacement_groups`, legacy `system_prompt_replacements`, `models`,
`src`, `dst`, and `order` retain their meaning. CPA adds `source_formats` and
`to_formats`; groups with `to_formats` run in the post-auth adapter before
Privacy Shield. Legacy `base_urls` are
accepted so config migration is visible, but the group is not activated until
it is converted because CPA's public interceptor ABI does not expose credential
endpoint URLs.

Octopus `pii_types`, `pii_aggressive`, `pii_aggressive_types`,
`debug_cache_ttl_seconds`, and body/string/finding limits are accepted. The
legacy debug TTL becomes the restoration session TTL unless
`session.ttl_seconds` is set. Octopus per-channel `channels` cannot be mapped
because CPA interceptor callbacks do not carry an Octopus channel ID; enable or
disable the CPA plugin instance instead.

Example configuration:

```yaml
plugins:
  enabled: true
  dir: plugins
  configs:
    cpa-sensitive:
      enabled: true
      priority: 10
      sanitization:
        enabled: true
        replacement_groups:
          - id: client-fingerprint
            models: ["gpt-*", "claude-*"]
            source_formats: ["openai", "openai-response", "claude"]
            replacements:
              - id: claude-code-name
                src: "Claude Code"
                dst: "AI coding client"
                order: 10
      privacy_shield:
        enabled: true
        pii_enabled: true
        max_body_bytes: 1048576
        max_string_bytes: 262144
        max_findings: 0
        pii_types:
          gitleaks: true
          email: true
          phone: true
          national_id: true
          bank_card: true
          ip: true
          jwt: true
          uuid: true
          credential_url: true
          mac_address: true
          ipv6: true
          path: true
          generic_token: false
        pii_aggressive: false
        pii_aggressive_types:
          relative_path: false
          username_hostname: false
          generic_token: false
          loose_secret: false
        custom_rules:
          - id: internal-token
            description: Internal token syntax
            regex: 'secret_[A-Za-z0-9]{24,}'
      session:
        ttl_seconds: 86400
        max_sessions: 4096
```

Build for the current platform:

```bash
go mod tidy
go test ./...
go build -buildmode=c-shared -o cpa-sensitive.so .
```

Use `.dll` on Windows and `.dylib` on macOS. The generated C header is not
required at runtime.

Runtime redaction/restoration activity is emitted through CPA's official
`host.log` callback and appears in **Logs Viewer** under runtime `CPA`. Logs
contain only stage, count, model, protocol, request ID, and stream state. The
plugin never logs request bodies, original sensitive values, or marker strings.
Keep CPA's detailed body logger disabled in production with `request-log: false`.
