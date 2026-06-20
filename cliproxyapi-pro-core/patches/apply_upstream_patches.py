#!/usr/bin/env python3
import os
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(os.environ.get('SRC_ROOT', '/src/CLIProxyAPI'))
PRO_PANEL_REPOSITORY = 'https://github.com/ssfun/CLIProxyAPI-Pro'
PRO_PANEL_RELEASE_API = 'https://api.github.com/repos/ssfun/CLIProxyAPI-Pro/releases/latest'


_writes = {}


def read_text(path: Path) -> str:
    return path.read_text(encoding='utf-8')


def write_text(path: Path, text: str) -> None:
    path.write_text(text, encoding='utf-8')


def read(path: Path) -> str:
    if path in _writes:
        return _writes[path]
    return read_text(path)


def write(path: Path, text: str) -> None:
    _writes[path] = text


def module_path() -> str:
    match = re.search(r'^module\s+(\S+)', read_text(ROOT / 'go.mod'), re.MULTILINE)
    if not match:
        raise SystemExit(f'module path not found in {ROOT / "go.mod"}')
    return match.group(1)


def import_path(suffix: str) -> str:
    return f'{MODULE_PATH}/{suffix}'


def rewrite_module_imports(path: Path) -> None:
    text = read(path)
    text = re.sub(r'github\.com/router-for-me/CLIProxyAPI/v\d+', MODULE_PATH, text)
    write(path, text)


def flush_writes() -> None:
    for path, text in _writes.items():
        write_text(path, text)


def replace_once(path: Path, old: str, new: str) -> None:
    text = read(path)
    if new and new in text:
        return
    if old not in text:
        raise SystemExit(f'pattern not found in {path}: {old[:120]!r}')
    write(path, text.replace(old, new, 1))


def insert_before(path: Path, marker: str, insertion: str, present: str) -> None:
    text = read(path)
    if present in text:
        return
    if marker not in text:
        raise SystemExit(f'pattern not found in {path}: {marker[:120]!r}')
    write(path, text.replace(marker, insertion + marker, 1))


def ensure_go_require(path: Path, module: str, version: str) -> None:
    text = read(path)
    if re.search(rf'^\s*{re.escape(module)}\s+', text, re.MULTILINE):
        return
    line = f'\t{module} {version}\n'
    marker = 'require (\n'
    if marker in text:
        write(path, text.replace(marker, marker + line, 1))
        return
    write(path, text.rstrip() + f'\n\nrequire {module} {version}\n')


def insert_before_nth(path: Path, marker: str, insertion: str, occurrence: int, present: str) -> None:
    text = read(path)
    if present in text:
        return
    start = -1
    for _ in range(occurrence):
        start = text.find(marker, start + 1)
        if start < 0:
            raise SystemExit(f'pattern occurrence {occurrence} not found in {path}: {marker[:120]!r}')
    write(path, text[:start] + insertion + text[start:])


def add_go_import(path: Path, after: str, import_line: str) -> None:
    text = read(path)
    if import_line.strip() in text:
        return
    if after not in text:
        raise SystemExit(f'import anchor not found in {path}: {after[:120]!r}')
    write(path, text.replace(after, after + import_line, 1))


def replace_go_function(path: Path, signature: str, new_function: str, present: str) -> None:
    text = read(path)
    if present in text:
        return
    start = text.find(signature)
    if start < 0:
        raise SystemExit(f'function not found in {path}: {signature!r}')
    brace = text.find('{', start)
    if brace < 0:
        raise SystemExit(f'function body not found in {path}: {signature!r}')
    depth = 0
    for index in range(brace, len(text)):
        char = text[index]
        if char == '{':
            depth += 1
        elif char == '}':
            depth -= 1
            if depth == 0:
                end = index + 1
                if end < len(text) and text[end] == '\n':
                    end += 1
                write(path, text[:start] + new_function + text[end:])
                return
    raise SystemExit(f'function body end not found in {path}: {signature!r}')


def replace_go_call_block(path: Path, call_start: str, new_block: str, present: str) -> None:
    text = read(path)
    if present in text:
        return
    start = text.find(call_start)
    if start < 0:
        raise SystemExit(f'call block not found in {path}: {call_start!r}')
    brace = text.find('{', start)
    if brace < 0:
        raise SystemExit(f'call block body not found in {path}: {call_start!r}')
    depth = 0
    for index in range(brace, len(text)):
        char = text[index]
        if char == '{':
            depth += 1
        elif char == '}':
            depth -= 1
            if depth == 0:
                end = index + 1
                while end < len(text) and text[end] in ')\n':
                    end += 1
                    if text[end - 1] == '\n':
                        break
                write(path, text[:start] + new_block + text[end:])
                return
    raise SystemExit(f'call block end not found in {path}: {call_start!r}')


MODULE_PATH = module_path()

config_go = ROOT / 'internal/config/config.go'
replace_once(
    config_go,
    'DefaultPanelGitHubRepository = "https://github.com/router-for-me/Cli-Proxy-API-Management-Center"',
    f'DefaultPanelGitHubRepository = "{PRO_PANEL_REPOSITORY}"',
)

config_example = ROOT / 'config.example.yaml'
replace_once(
    config_example,
    '  panel-github-repository: "https://github.com/router-for-me/Cli-Proxy-API-Management-Center"',
    f'  panel-github-repository: "{PRO_PANEL_REPOSITORY}"',
)

insert_before(
    config_go,
    '// NormalizeCommentIndentation removes indentation from standalone YAML comment lines to keep them left aligned.\n',
    '// SaveConfigPreserveCommentsUpdateNestedBoolScalar updates a nested bool scalar while preserving comments and positions.\nfunc SaveConfigPreserveCommentsUpdateNestedBoolScalar(configFile string, path []string, value bool) error {\n\tdata, err := os.ReadFile(configFile)\n\tif err != nil {\n\t\treturn err\n\t}\n\tvar root yaml.Node\n\tif err = yaml.Unmarshal(data, &root); err != nil {\n\t\treturn err\n\t}\n\tif root.Kind != yaml.DocumentNode || len(root.Content) == 0 {\n\t\treturn fmt.Errorf("invalid yaml document structure")\n\t}\n\tnode := root.Content[0]\n\tfor i, key := range path {\n\t\tif i == len(path)-1 {\n\t\t\tv := getOrCreateMapValue(node, key)\n\t\t\tv.Kind = yaml.ScalarNode\n\t\t\tv.Tag = "!!bool"\n\t\t\tif value {\n\t\t\t\tv.Value = "true"\n\t\t\t} else {\n\t\t\t\tv.Value = "false"\n\t\t\t}\n\t\t} else {\n\t\t\tnext := getOrCreateMapValue(node, key)\n\t\t\tif next.Kind != yaml.MappingNode {\n\t\t\t\tnext.Kind = yaml.MappingNode\n\t\t\t\tnext.Tag = "!!map"\n\t\t\t}\n\t\t\tnode = next\n\t\t}\n\t}\n\tf, err := os.Create(configFile)\n\tif err != nil {\n\t\treturn err\n\t}\n\tdefer func() { _ = f.Close() }()\n\tvar buf bytes.Buffer\n\tenc := yaml.NewEncoder(&buf)\n\tenc.SetIndent(2)\n\tif err = enc.Encode(&root); err != nil {\n\t\t_ = enc.Close()\n\t\treturn err\n\t}\n\tif err = enc.Close(); err != nil {\n\t\treturn err\n\t}\n\tdata = NormalizeCommentIndentation(buf.Bytes())\n\t_, err = f.Write(data)\n\treturn err\n}\n\n',
    'func SaveConfigPreserveCommentsUpdateNestedBoolScalar',
)

updater = ROOT / 'internal/managementasset/updater.go'
replace_once(
    updater,
    'defaultManagementReleaseURL  = "https://api.github.com/repos/router-for-me/Cli-Proxy-API-Management-Center/releases/latest"',
    f'defaultManagementReleaseURL  = "{PRO_PANEL_RELEASE_API}"',
)
add_go_import(updater, '"net/http"\n', '\t"net/url"\n')
replace_once(updater, '\tgitURL := strings.ToLower(strings.TrimSpace(os.Getenv("GITSTORE_GIT_URL")))\n', '')
replace_once(updater, 'tok != "" && strings.Contains(gitURL, "github.com")', 'tok != "" && isGitHubReleaseURL(releaseURL)')
insert_before(
    updater,
    'func fetchLatestAsset(ctx context.Context, client *http.Client, releaseURL string) (*releaseAsset, string, error) {\n',
    '''func isGitHubReleaseURL(releaseURL string) bool {
\tparsed, err := url.Parse(strings.TrimSpace(releaseURL))
\tif err != nil || parsed.Host == "" {
\t\treturn false
\t}
\treturn strings.Contains(strings.ToLower(parsed.Host), "github.com")
}

''',
    'func isGitHubReleaseURL(releaseURL string) bool',
)

server = ROOT / 'internal/api/server.go'
auth_files = ROOT / 'internal/api/handlers/management/auth_files.go'
management_scheduler = ROOT / 'internal/api/handlers/management/account_inspection_scheduler.go'
management_scheduler_test = ROOT / 'internal/api/handlers/management/account_inspection_scheduler_test.go'
scheduler_source = Path('/tmp/account_inspection_scheduler.go')
if not scheduler_source.is_file():
    scheduler_source = Path(__file__).resolve().parent / 'account_inspection_scheduler.go'
write_text(management_scheduler, re.sub(r'github\.com/router-for-me/CLIProxyAPI/v\d+', MODULE_PATH, read_text(scheduler_source)))
scheduler_test_source = Path(__file__).resolve().parent / 'account_inspection_scheduler_test.go'
if scheduler_test_source.is_file():
    write_text(management_scheduler_test, re.sub(r'github\.com/router-for-me/CLIProxyAPI/v\d+', MODULE_PATH, read_text(scheduler_test_source)))
replace_once(
    auth_files,
    '''		"unavailable":    auth.Unavailable,
		"runtime_only":   runtimeOnly,
''',
    '''		"unavailable":    auth.Unavailable,
		"last_error":     authFileLastError(auth),
		"runtime_only":   runtimeOnly,
''',
)
insert_before(
    auth_files,
    'func authAttribute(auth *coreauth.Auth, key string) string {\n',
    '''func authFileLastError(auth *coreauth.Auth) *coreauth.Error {
	if auth == nil {
		return nil
	}
	if auth.LastError != nil {
		return auth.LastError
	}
	if auth.Metadata == nil {
		return nil
	}
	raw, ok := auth.Metadata["last_error"].(map[string]any)
	if !ok {
		return nil
	}
	lastError := &coreauth.Error{
		Code:       metadataString(raw["code"]),
		Message:    metadataString(raw["message"]),
		Retryable:  metadataBool(raw["retryable"]),
		HTTPStatus: metadataInt(raw["http_status"]),
	}
	if lastError.Code == "" && lastError.Message == "" && lastError.HTTPStatus == 0 {
		return nil
	}
	return lastError
}

func metadataString(value any) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(value))
}

func metadataBool(value any) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		return strings.EqualFold(strings.TrimSpace(typed), "true")
	default:
		return false
	}
}

func metadataInt(value any) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	case json.Number:
		parsed, _ := typed.Int64()
		return int(parsed)
	case string:
		parsed, _ := strconv.Atoi(strings.TrimSpace(typed))
		return parsed
	default:
		return 0
	}
}

''',
    'func authFileLastError',
)

patch_dir = Path(__file__).resolve().parent
embeddedusage_source = patch_dir.parent / 'embeddedusage'
embeddedusage_target = ROOT / 'internal/embeddedusage'
if embeddedusage_source.is_dir():
    shutil.copytree(embeddedusage_source, embeddedusage_target, dirs_exist_ok=True)
elif not embeddedusage_target.is_dir():
    raise SystemExit(f'embeddedusage source not found: {embeddedusage_source}')
ensure_go_require(ROOT / 'go.mod', 'modernc.org/sqlite', 'v1.51.0')
for embeddedusage_file in embeddedusage_target.rglob('*.go'):
    rewrite_module_imports(embeddedusage_file)

redisqueue_plugin = ROOT / 'internal/redisqueue/plugin.go'
redisqueue_usage_toggle = ROOT / 'internal/redisqueue/usage_toggle.go'
write_text(redisqueue_plugin, re.sub(r'github\.com/router-for-me/CLIProxyAPI/v\d+', MODULE_PATH, read_text(patch_dir / 'redisqueue_plugin.go')))
write_text(redisqueue_usage_toggle, read_text(patch_dir / 'redisqueue_usage_toggle.go'))

add_go_import(server, '"' + import_path('internal/config') + '"\n', '\t"' + import_path('internal/embeddedusage') + '"\n')

replace_go_call_block(
    server,
    '\ts.engine.GET("/", func(c *gin.Context) {',
    '''\ts.engine.GET("/", func(c *gin.Context) {
\t\tc.Redirect(http.StatusTemporaryRedirect, "/management.html")
\t})
''',
    'c.Redirect(http.StatusTemporaryRedirect, "/management.html")',
)
replace_once(
    server,
    '''\t{
\t\tmgmt.GET("/config", s.mgmt.GetConfig)
''',
    '''\t{
\t\tembeddedusage.RegisterGinRoutes(mgmt.Group("/usage"))

\t\tmgmt.GET("/config", s.mgmt.GetConfig)
''',
)
replace_once(
    server,
    '''\t\tmgmt.POST("/api-call", s.mgmt.APICall)\n''',
    '''\t\tmgmt.POST("/api-call", s.mgmt.APICall)\n\t\ts.mgmt.RegisterAccountInspectionRoutes(mgmt)\n''',
)

handler = ROOT / 'internal/api/handlers/management/handler.go'
add_go_import(handler, '"net/http"\n', '\t"net/url"\n')
replace_once(
    handler,
    '''\t\tif provided == "" {
\t\t\tprovided = c.GetHeader("X-Management-Key")
\t\t}
''',
    '''\t\tif provided == "" {
\t\t\tprovided = c.GetHeader("X-Management-Key")
\t\t}
\t\tif provided == "" {
\t\t\tprovided = managementKeyFromWebSocketProtocol(c)
\t\t}
''',
)
insert_before(
    handler,
    '''func (h *Handler) Middleware() gin.HandlerFunc {
''',
    '''func managementKeyFromWebSocketProtocol(c *gin.Context) string {
\tif !strings.EqualFold(c.GetHeader("Upgrade"), "websocket") {
\t\treturn ""
\t}
\tfor _, protocol := range strings.Split(c.GetHeader("Sec-WebSocket-Protocol"), ",") {
\t\tprotocol = strings.TrimSpace(protocol)
\t\tif !strings.HasPrefix(protocol, "cpa-management.") {
\t\t\tcontinue
\t\t}
\t\tdecoded, err := url.QueryUnescape(strings.TrimPrefix(protocol, "cpa-management."))
\t\tif err != nil {
\t\t\treturn ""
\t\t}
\t\treturn decoded
\t}
\treturn ""
}

''',
    'func managementKeyFromWebSocketProtocol(c *gin.Context) string',
)
replace_once(
    handler,
    '''\th.startAttemptCleanup()
\treturn h
''',
    '''\th.startAccountInspectionScheduler()
\th.startAttemptCleanup()
\treturn h
''',
)

run = ROOT / 'internal/cmd/run.go'
add_go_import(run, '"' + import_path('internal/config') + '"\n', '\t"' + import_path('internal/embeddedusage') + '"\n')
insert_before(
    run,
    '// StartService builds and runs the proxy service using the exported SDK.\n',
    'func applyProRequiredStartupConfig(cfg *config.Config, configPath string) {\n\tif cfg == nil {\n\t\treturn\n\t}\n\tshouldPersistUsageStatistics := !cfg.UsageStatisticsEnabled\n\tshouldPersistPanelRepository := cfg.RemoteManagement.PanelGitHubRepository != config.DefaultPanelGitHubRepository\n\tcfg.UsageStatisticsEnabled = true\n\tcfg.RemoteManagement.PanelGitHubRepository = config.DefaultPanelGitHubRepository\n\tif configPath == "" {\n\t\treturn\n\t}\n\tif shouldPersistUsageStatistics {\n\t\tif err := config.SaveConfigPreserveCommentsUpdateNestedBoolScalar(configPath, []string{"usage-statistics-enabled"}, true); err != nil {\n\t\t\tlog.Warnf("failed to persist usage statistics config: %v", err)\n\t\t}\n\t}\n\tif shouldPersistPanelRepository {\n\t\tif err := config.SaveConfigPreserveCommentsUpdateNestedScalar(configPath, []string{"remote-management", "panel-github-repository"}, config.DefaultPanelGitHubRepository); err != nil {\n\t\t\tlog.Warnf("failed to persist panel repository config: %v", err)\n\t\t}\n\t}\n}\n\n',
    'func applyProRequiredStartupConfig',
)
insert_before_nth(
    run,
    '''\tservice, err := builder.Build()
''',
    '''\tusageService, err := embeddedusage.Start(ctx)
\tif err != nil {
\t\tlog.Errorf("failed to start embedded usage service: %v", err)
\t\tclose(doneCh)
\t\treturn cancelFn, doneCh
\t}
\tembeddedusage.SetDefaultService(usageService)
\tapplyProRequiredStartupConfig(cfg, configPath)

''',
    2,
    'embeddedusage.Start(ctx)',
)
insert_before_nth(
    run,
    '''\tservice, err := builder.Build()
''',
    '''\tusageService, err := embeddedusage.Start(runCtx)
\tif err != nil {
\t\tlog.Errorf("failed to start embedded usage service: %v", err)
\t\treturn
\t}
\tembeddedusage.SetDefaultService(usageService)
\tapplyProRequiredStartupConfig(cfg, configPath)

''',
    1,
    'embeddedusage.Start(runCtx)',
)

write_text(ROOT / 'sdk/cliproxy/auth/inspection_refresh.go', '''package auth

import (
	"context"
	"errors"
	"strings"
	"time"
)

func (m *Manager) shouldRefreshForInspection(a *Auth, now time.Time) bool {
	if a == nil {
		return false
	}
	if hasUnauthorizedAuthFailure(a) {
		return false
	}
	if !a.NextRefreshAfter.IsZero() && now.Before(a.NextRefreshAfter) {
		return false
	}
	if evaluator, ok := a.Runtime.(RefreshEvaluator); ok && evaluator != nil {
		return evaluator.ShouldRefresh(now, a)
	}

	lastRefresh := a.LastRefreshedAt
	if lastRefresh.IsZero() {
		if ts, ok := authLastRefreshTimestamp(a); ok {
			lastRefresh = ts
		}
	}

	expiry, hasExpiry := a.ExpirationTime()

	if interval := authPreferredInterval(a); interval > 0 {
		if hasExpiry && !expiry.IsZero() {
			if !expiry.After(now) {
				return true
			}
			if expiry.Sub(now) <= interval {
				return true
			}
		}
		if lastRefresh.IsZero() {
			return true
		}
		return now.Sub(lastRefresh) >= interval
	}

	provider := strings.ToLower(a.Provider)
	lead := ProviderRefreshLead(provider, a.Runtime)
	if lead == nil {
		return false
	}
	if *lead <= 0 {
		if hasExpiry && !expiry.IsZero() {
			return now.After(expiry)
		}
		return false
	}
	if hasExpiry && !expiry.IsZero() {
		return time.Until(expiry) <= *lead
	}
	if !lastRefresh.IsZero() {
		return now.Sub(lastRefresh) >= *lead
	}
	return true
}

func (m *Manager) markRefreshPendingForInspection(id string, now time.Time, force bool) bool {
	m.mu.Lock()
	auth, ok := m.auths[id]
	if !ok || auth == nil {
		m.mu.Unlock()
		return false
	}
	if !force && !auth.NextRefreshAfter.IsZero() && now.Before(auth.NextRefreshAfter) {
		m.mu.Unlock()
		return false
	}
	auth.NextRefreshAfter = now.Add(refreshPendingBackoff)
	m.auths[id] = auth
	m.mu.Unlock()

	m.queueRefreshReschedule(id)
	return true
}

func (m *Manager) RefreshIfDueForInspection(ctx context.Context, id string) (*Auth, bool, error) {
	return m.refreshForInspection(ctx, id, false)
}

func (m *Manager) ForceRefreshForInspection(ctx context.Context, id string) (*Auth, bool, error) {
	return m.refreshForInspection(ctx, id, true)
}

func (m *Manager) refreshForInspection(ctx context.Context, id string, force bool) (*Auth, bool, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	now := time.Now()
	m.mu.RLock()
	auth := m.auths[id]
	if auth == nil {
		m.mu.RUnlock()
		return nil, false, nil
	}
	current := auth.Clone()
	accountType, _ := auth.AccountInfo()
	if accountType == "api_key" || (!force && !m.shouldRefreshForInspection(auth, now)) {
		m.mu.RUnlock()
		return current, false, nil
	}
	exec := m.executors[auth.Provider]
	m.mu.RUnlock()
	if exec == nil {
		return current, false, nil
	}
	if !m.markRefreshPendingForInspection(id, now, force) {
		m.mu.RLock()
		defer m.mu.RUnlock()
		if latest := m.auths[id]; latest != nil {
			return latest.Clone(), false, nil
		}
		return nil, false, nil
	}

	m.mu.RLock()
	auth = m.auths[id]
	if auth == nil {
		m.mu.RUnlock()
		return nil, false, nil
	}
	exec = m.executors[auth.Provider]
	cloned := auth.Clone()
	preservedDisabled := auth.Disabled
	preservedStatus := auth.Status
	preservedStatusMessage := auth.StatusMessage
	m.mu.RUnlock()
	if exec == nil {
		return cloned, false, nil
	}

	updated, err := exec.Refresh(ctx, cloned)
	if err != nil && errors.Is(err, context.Canceled) {
		return cloned, false, err
	}
	now = time.Now()
	if err != nil {
		unauthorized := isUnauthorizedError(err)
		m.mu.Lock()
		if current := m.auths[id]; current != nil {
			current.LastError = refreshErrorFromError(err)
			if unauthorized {
				current.NextRefreshAfter = time.Time{}
				current.Unavailable = true
				current.Status = StatusError
				current.StatusMessage = "unauthorized"
			} else {
				current.NextRefreshAfter = now.Add(refreshFailureBackoff)
			}
			m.auths[id] = current
			if m.scheduler != nil {
				m.scheduler.upsertAuth(current.Clone())
			}
		}
		m.mu.Unlock()
		m.queueRefreshReschedule(id)
		return cloned, false, err
	}
	if updated == nil {
		updated = cloned
	}
	if updated.Runtime == nil {
		updated.Runtime = auth.Runtime
	}
	updated.Disabled = preservedDisabled
	if preservedDisabled {
		updated.Status = preservedStatus
		updated.StatusMessage = preservedStatusMessage
	}
	updated.LastRefreshedAt = now
	updated.NextRefreshAfter = time.Time{}
	updated.LastError = nil
	updated.UpdatedAt = now
	if m.shouldRefreshForInspection(updated, now) {
		updated.NextRefreshAfter = now.Add(refreshIneffectiveBackoff)
	}
	saved, err := m.Update(ctx, updated)
	if err != nil {
		return updated, false, err
	}
	return saved, true, nil
}
''')

flush_writes()
subprocess.run(['go', 'mod', 'tidy'], cwd=ROOT, check=True)
