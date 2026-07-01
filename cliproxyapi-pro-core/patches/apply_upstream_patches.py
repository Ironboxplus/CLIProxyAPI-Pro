#!/usr/bin/env python3
import os
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(os.environ.get('SRC_ROOT', '/src/CLIProxyAPI'))
PRO_PANEL_REPOSITORY = 'https://github.com/Ironboxplus/CLIProxyAPI-Pro'
PRO_PANEL_RELEASE_API = 'https://api.github.com/repos/Ironboxplus/CLIProxyAPI-Pro/releases/latest'


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
insert_before(
    config_go,
    '// NormalizeCommentIndentation removes indentation from standalone YAML comment lines to keep them left aligned.\n',
    '// PluginAutoInstallProxyURL returns the proxy URL used by plugin store auto-install requests.\nfunc (cfg *Config) PluginAutoInstallProxyURL() string {\n\tif cfg == nil {\n\t\treturn ""\n\t}\n\treturn cfg.ProxyURL\n}\n\n// PluginAutoInstallEnabled reports whether dynamic plugins are enabled.\nfunc (cfg *Config) PluginAutoInstallEnabled() bool {\n\treturn cfg != nil && cfg.Plugins.Enabled\n}\n\n// PluginAutoInstallDir returns the normalized plugin discovery directory.\nfunc (cfg *Config) PluginAutoInstallDir() string {\n\tif cfg == nil {\n\t\treturn ""\n\t}\n\treturn cfg.Plugins.Dir\n}\n\n// PluginAutoInstallStoreSources returns configured third-party plugin registry URLs.\nfunc (cfg *Config) PluginAutoInstallStoreSources() []string {\n\tif cfg == nil || len(cfg.Plugins.StoreSources) == 0 {\n\t\treturn nil\n\t}\n\treturn append([]string(nil), cfg.Plugins.StoreSources...)\n}\n\n// PluginAutoInstallEnabledIDs returns configured plugin IDs that should be present at startup.\nfunc (cfg *Config) PluginAutoInstallEnabledIDs() []string {\n\tif cfg == nil || len(cfg.Plugins.Configs) == 0 {\n\t\treturn nil\n\t}\n\tids := make([]string, 0, len(cfg.Plugins.Configs))\n\tfor id, item := range cfg.Plugins.Configs {\n\t\tif item.Enabled == nil || !*item.Enabled {\n\t\t\tcontinue\n\t\t}\n\t\tids = append(ids, id)\n\t}\n\treturn ids\n}\n\n',
    'func (cfg *Config) PluginAutoInstallProxyURL',
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

server_main = ROOT / 'cmd/server/main.go'
add_go_import(server_main, '"' + import_path('internal/pluginhost') + '"\n', '\t"' + import_path('internal/pluginstore') + '"\n')
replace_once(
    server_main,
    '''\tconfigaccess.Register(&cfg.SDKConfig)
\tpluginHost.ApplyConfig(context.Background(), cfg)
''',
    '''\tconfigaccess.Register(&cfg.SDKConfig)
\tpluginstore.EnsureConfiguredPluginsInstalled(context.Background(), cfg)
\tpluginHost.ApplyConfig(context.Background(), cfg)
''',
)

write_text(ROOT / 'internal/pluginstore/autoinstall.go', f'''package pluginstore

import (
\t"context"
\t"net/http"
\t"os"
\t"path/filepath"
\t"regexp"
\t"runtime"
\t"sort"
\t"strings"

\t"{import_path('sdk/proxyutil')}"
\tlog "github.com/sirupsen/logrus"
\t"golang.org/x/sys/cpu"
)

var autoInstallPluginIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{{0,127}}$`)

// AutoInstallWarning describes a non-fatal plugin auto-install issue.
type AutoInstallWarning struct {{
\tPluginID string
\tSourceID string
\tSourceURL string
\tMessage string
}}

// AutoInstallReport summarizes startup plugin auto-install work.
type AutoInstallReport struct {{
\tInstalled []InstallResult
\tWarnings []AutoInstallWarning
}}

// AutoInstallConfig is the small read-only config surface needed by plugin auto-install.
type AutoInstallConfig interface {{
\tNormalizePluginsConfig()
\tPluginAutoInstallProxyURL() string
\tPluginAutoInstallEnabled() bool
\tPluginAutoInstallDir() string
\tPluginAutoInstallStoreSources() []string
\tPluginAutoInstallEnabledIDs() []string
}}

type autoInstallOptions struct {{
\tHTTPClient HTTPDoer
\tGOOS string
\tGOARCH string
\tInstall func(context.Context, Client, Plugin, InstallOptions) (InstallResult, error)
}}

type autoInstallSourcePlugin struct {{
\tsource Source
\tplugin Plugin
}}

// EnsureConfiguredPluginsInstalled downloads missing enabled plugins before the plugin host scans local binaries.
func EnsureConfiguredPluginsInstalled(ctx context.Context, cfg AutoInstallConfig) AutoInstallReport {{
\treport := ensureConfiguredPluginsInstalled(ctx, cfg, autoInstallOptions{{}})
\tfor _, warning := range report.Warnings {{
\t\tfields := log.Fields{{}}
\t\tif warning.PluginID != "" {{
\t\t\tfields["plugin_id"] = warning.PluginID
\t\t}}
\t\tif warning.SourceID != "" {{
\t\t\tfields["source_id"] = warning.SourceID
\t\t}}
\t\tif warning.SourceURL != "" {{
\t\t\tfields["source_url"] = warning.SourceURL
\t\t}}
\t\tlog.WithFields(fields).Warnf("pluginstore: auto install skipped: %s", warning.Message)
\t}}
\tfor _, installed := range report.Installed {{
\t\tlog.WithFields(log.Fields{{
\t\t\t"plugin_id": installed.ID,
\t\t\t"version": installed.Version,
\t\t\t"path": installed.Path,
\t\t}}).Info("pluginstore: plugin auto installed")
\t}}
\treturn report
}}

func ensureConfiguredPluginsInstalled(ctx context.Context, cfg AutoInstallConfig, options autoInstallOptions) AutoInstallReport {{
\tvar report AutoInstallReport
\tif ctx == nil {{
\t\tctx = context.Background()
\t}}
\tif cfg == nil {{
\t\treturn report
\t}}
\tcfg.NormalizePluginsConfig()
\tif !cfg.PluginAutoInstallEnabled() {{
\t\treturn report
\t}}

\tenabledIDs := enabledConfiguredPluginIDs(cfg)
\tif len(enabledIDs) == 0 {{
\t\treturn report
\t}}

\tinstalledIDs, errDiscover := installedPluginIDs(cfg.PluginAutoInstallDir())
\tif errDiscover != nil {{
\t\treport.Warnings = append(report.Warnings, AutoInstallWarning{{Message: "discover installed plugins: " + errDiscover.Error()}})
\t\treturn report
\t}}

\tmissingIDs := make([]string, 0, len(enabledIDs))
\tfor _, id := range enabledIDs {{
\t\tif _, installed := installedIDs[id]; installed {{
\t\t\tcontinue
\t\t}}
\t\tmissingIDs = append(missingIDs, id)
\t}}
\tif len(missingIDs) == 0 {{
\t\treturn report
\t}}
\twanted := make(map[string]struct{{}}, len(missingIDs))
\tfor _, id := range missingIDs {{
\t\twanted[id] = struct{{}}{{}}
\t}}

\tsources, errSources := NormalizeSources(cfg.PluginAutoInstallStoreSources())
\tif errSources != nil {{
\t\treport.Warnings = append(report.Warnings, AutoInstallWarning{{Message: "normalize plugin store sources: " + errSources.Error()}})
\t\treturn report
\t}}

\thttpClient := options.HTTPClient
\tif httpClient == nil {{
\t\thttpClient = autoInstallHTTPClient(cfg.PluginAutoInstallProxyURL())
\t}}

\tmatches := make(map[string][]autoInstallSourcePlugin, len(missingIDs))
\tfor _, source := range sources {{
\t\tclient := Client{{HTTPClient: httpClient, RegistryURL: source.URL}}
\t\tregistry, errRegistry := client.FetchRegistry(ctx)
\t\tif errRegistry != nil {{
\t\t\treport.Warnings = append(report.Warnings, AutoInstallWarning{{
\t\t\t\tSourceID: source.ID,
\t\t\t\tSourceURL: source.URL,
\t\t\t\tMessage: "fetch plugin registry: " + errRegistry.Error(),
\t\t\t}})
\t\t\tcontinue
\t\t}}
\t\tfor _, plugin := range registry.Plugins {{
\t\t\tif _, ok := wanted[plugin.ID]; !ok {{
\t\t\t\tcontinue
\t\t\t}}
\t\t\tmatches[plugin.ID] = append(matches[plugin.ID], autoInstallSourcePlugin{{source: source, plugin: plugin}})
\t\t}}
\t}}

\tinstaller := options.Install
\tif installer == nil {{
\t\tinstaller = func(ctx context.Context, client Client, plugin Plugin, installOptions InstallOptions) (InstallResult, error) {{
\t\t\treturn client.Install(ctx, plugin, installOptions)
\t\t}}
\t}}
\tgoos := strings.TrimSpace(options.GOOS)
\tif goos == "" {{
\t\tgoos = runtime.GOOS
\t}}
\tgoarch := strings.TrimSpace(options.GOARCH)
\tif goarch == "" {{
\t\tgoarch = runtime.GOARCH
\t}}

\tfor _, id := range missingIDs {{
\t\tcandidates := matches[id]
\t\tswitch len(candidates) {{
\t\tcase 0:
\t\t\treport.Warnings = append(report.Warnings, AutoInstallWarning{{PluginID: id, Message: "plugin not found in configured registries"}})
\t\t\tcontinue
\t\tcase 1:
\t\t\tcandidate := candidates[0]
\t\t\tresult, errInstall := installer(ctx, Client{{HTTPClient: httpClient, RegistryURL: candidate.source.URL}}, candidate.plugin, InstallOptions{{
\t\t\t\tPluginsDir: cfg.PluginAutoInstallDir(),
\t\t\t\tGOOS: goos,
\t\t\t\tGOARCH: goarch,
\t\t\t}})
\t\t\tif errInstall != nil {{
\t\t\t\treport.Warnings = append(report.Warnings, AutoInstallWarning{{
\t\t\t\t\tPluginID: id,
\t\t\t\t\tSourceID: candidate.source.ID,
\t\t\t\t\tSourceURL: candidate.source.URL,
\t\t\t\t\tMessage: "install plugin: " + errInstall.Error(),
\t\t\t\t}})
\t\t\t\tcontinue
\t\t\t}}
\t\t\treport.Installed = append(report.Installed, result)
\t\tdefault:
\t\t\treport.Warnings = append(report.Warnings, AutoInstallWarning{{PluginID: id, Message: "plugin id appears in multiple registries; install source is ambiguous"}})
\t\t}}
\t}}

\treturn report
}}

func enabledConfiguredPluginIDs(cfg AutoInstallConfig) []string {{
\tconfiguredIDs := cfg.PluginAutoInstallEnabledIDs()
\tids := make([]string, 0, len(configuredIDs))
\tfor _, id := range configuredIDs {{
\t\tid = strings.TrimSpace(id)
\t\tif id == "" {{
\t\t\tcontinue
\t\t}}
\t\tif !autoInstallValidatePluginID(id) {{
\t\t\tcontinue
\t\t}}
\t\tids = append(ids, id)
\t}}
\tsort.Strings(ids)
\treturn ids
}}

func installedPluginIDs(pluginsDir string) (map[string]struct{{}}, error) {{
\tfiles, err := autoInstallDiscoverPluginFiles(pluginsDir)
\tif err != nil {{
\t\treturn nil, err
\t}}
\tout := make(map[string]struct{{}}, len(files))
\tfor _, file := range files {{
\t\tout[file.ID] = struct{{}}{{}}
\t}}
\treturn out, nil
}}

type autoInstallPluginFile struct {{
\tID string
\tPath string
}}

func autoInstallValidatePluginID(id string) bool {{
\treturn autoInstallPluginIDPattern.MatchString(id)
}}

func autoInstallPluginIDFromPath(path string) string {{
\tbase := filepath.Base(path)
\tlowerBase := strings.ToLower(base)
\tfor _, extension := range []string{{".so", ".dylib", ".dll"}} {{
\t\tif strings.HasSuffix(lowerBase, extension) {{
\t\t\treturn base[:len(base)-len(extension)]
\t\t}}
\t}}
\treturn base
}}

func autoInstallPluginExtension(goos string) string {{
\tswitch goos {{
\tcase "darwin":
\t\treturn ".dylib"
\tcase "windows":
\t\treturn ".dll"
\tdefault:
\t\treturn ".so"
\t}}
}}

func autoInstallDiscoverPluginFiles(root string) ([]autoInstallPluginFile, error) {{
\troot = strings.TrimSpace(root)
\tif root == "" {{
\t\troot = "plugins"
\t}}

\tcandidates := autoInstallCandidateDirs(root, runtime.GOOS, runtime.GOARCH, autoInstallCPUVariant())
\textension := autoInstallPluginExtension(runtime.GOOS)
\tselected := make([]autoInstallPluginFile, 0)
\tseen := make(map[string]struct{{}})
\tfor _, dir := range candidates {{
\t\tentries, errReadDir := os.ReadDir(dir)
\t\tif errReadDir != nil {{
\t\t\tif os.IsNotExist(errReadDir) {{
\t\t\t\tcontinue
\t\t\t}}
\t\t\treturn nil, errReadDir
\t\t}}
\t\tfiles := make([]string, 0, len(entries))
\t\tfor _, entry := range entries {{
\t\t\tif entry == nil || !entry.Type().IsRegular() {{
\t\t\t\tcontinue
\t\t\t}}
\t\t\tif strings.HasSuffix(strings.ToLower(entry.Name()), extension) {{
\t\t\t\tfiles = append(files, filepath.Join(dir, entry.Name()))
\t\t\t}}
\t\t}}
\t\tsort.Strings(files)
\t\tfor _, path := range files {{
\t\t\tid := autoInstallPluginIDFromPath(path)
\t\t\tif !autoInstallValidatePluginID(id) {{
\t\t\t\tcontinue
\t\t\t}}
\t\t\tif _, exists := seen[id]; exists {{
\t\t\t\tcontinue
\t\t\t}}
\t\t\tseen[id] = struct{{}}{{}}
\t\t\tselected = append(selected, autoInstallPluginFile{{ID: id, Path: path}})
\t\t}}
\t}}
\treturn selected, nil
}}

func autoInstallCandidateDirs(root, goos, goarch, variant string) []string {{
\tdirs := make([]string, 0, 3)
\tif variant != "" {{
\t\tdirs = append(dirs, filepath.Join(root, goos, goarch+"-"+variant))
\t}}
\tdirs = append(dirs, filepath.Join(root, goos, goarch))
\tdirs = append(dirs, root)
\treturn dirs
}}

func autoInstallCPUVariant() string {{
\tif runtime.GOARCH != "amd64" {{
\t\treturn ""
\t}}
\tif cpu.X86.HasAVX512F && cpu.X86.HasAVX512BW && cpu.X86.HasAVX512CD && cpu.X86.HasAVX512DQ && cpu.X86.HasAVX512VL {{
\t\treturn "v4"
\t}}
\tif cpu.X86.HasAVX && cpu.X86.HasAVX2 && cpu.X86.HasBMI1 && cpu.X86.HasBMI2 && cpu.X86.HasFMA {{
\t\treturn "v3"
\t}}
\tif cpu.X86.HasSSE3 && cpu.X86.HasSSSE3 && cpu.X86.HasSSE41 && cpu.X86.HasSSE42 && cpu.X86.HasPOPCNT {{
\t\treturn "v2"
\t}}
\treturn "v1"
}}

func autoInstallHTTPClient(proxyURL string) HTTPDoer {{
\tclient := &http.Client{{}}
\tproxyURL = strings.TrimSpace(proxyURL)
\tif proxyURL == "" {{
\t\treturn client
\t}}
\ttransport, _, errBuild := proxyutil.BuildHTTPTransport(proxyURL)
\tif errBuild != nil {{
\t\tlog.WithError(errBuild).Warn("pluginstore: invalid proxy URL for auto install")
\t\treturn client
\t}}
\tif transport != nil {{
\t\tclient.Transport = transport
\t}}
\treturn client
}}
''')

write_text(ROOT / 'internal/pluginstore/autoinstall_test.go', f'''package pluginstore

import (
\t"context"
\t"io"
\t"net/http"
\t"os"
\t"path/filepath"
\t"runtime"
\t"sort"
\t"strings"
\t"testing"
)

type autoInstallFakeDoer map[string]string

func (d autoInstallFakeDoer) Do(req *http.Request) (*http.Response, error) {{
\tbody, ok := d[req.URL.String()]
\tif !ok {{
\t\treturn &http.Response{{
\t\t\tStatusCode: http.StatusNotFound,
\t\t\tBody: io.NopCloser(strings.NewReader("missing")),
\t\t\tHeader: make(http.Header),
\t\t}}, nil
\t}}
\treturn &http.Response{{
\t\tStatusCode: http.StatusOK,
\t\tBody: io.NopCloser(strings.NewReader(body)),
\t\tHeader: make(http.Header),
\t}}, nil
}}

func enabledBoolPtr(value bool) *bool {{
\treturn &value
}}

type fakeAutoInstallPlugin struct {{
\tEnabled *bool
}}

type fakeAutoInstallConfig struct {{
\tProxyURL string
\tEnabled bool
\tDir string
\tStoreSources []string
\tConfigs map[string]fakeAutoInstallPlugin
}}

func (cfg *fakeAutoInstallConfig) NormalizePluginsConfig() {{
\tif cfg == nil {{
\t\treturn
\t}}
\tcfg.Dir = strings.TrimSpace(cfg.Dir)
\tif cfg.Dir == "" {{
\t\tcfg.Dir = "plugins"
\t}}
\tif len(cfg.StoreSources) > 0 {{
\t\tsources := make([]string, 0, len(cfg.StoreSources))
\t\tfor _, source := range cfg.StoreSources {{
\t\t\tsource = strings.TrimSpace(source)
\t\t\tif source == "" {{
\t\t\t\tcontinue
\t\t\t}}
\t\t\tsources = append(sources, source)
\t\t}}
\t\tcfg.StoreSources = sources
\t}}
\tif cfg.Configs == nil {{
\t\tcfg.Configs = map[string]fakeAutoInstallPlugin{{}}
\t}}
}}

func (cfg *fakeAutoInstallConfig) PluginAutoInstallProxyURL() string {{
\tif cfg == nil {{
\t\treturn ""
\t}}
\treturn cfg.ProxyURL
}}

func (cfg *fakeAutoInstallConfig) PluginAutoInstallEnabled() bool {{
\treturn cfg != nil && cfg.Enabled
}}

func (cfg *fakeAutoInstallConfig) PluginAutoInstallDir() string {{
\tif cfg == nil {{
\t\treturn ""
\t}}
\treturn cfg.Dir
}}

func (cfg *fakeAutoInstallConfig) PluginAutoInstallStoreSources() []string {{
\tif cfg == nil || len(cfg.StoreSources) == 0 {{
\t\treturn nil
\t}}
\treturn append([]string(nil), cfg.StoreSources...)
}}

func (cfg *fakeAutoInstallConfig) PluginAutoInstallEnabledIDs() []string {{
\tif cfg == nil || len(cfg.Configs) == 0 {{
\t\treturn nil
\t}}
\tids := make([]string, 0, len(cfg.Configs))
\tfor id, item := range cfg.Configs {{
\t\tif item.Enabled == nil || !*item.Enabled {{
\t\t\tcontinue
\t\t}}
\t\tids = append(ids, id)
\t}}
\tsort.Strings(ids)
\treturn ids
}}

func TestEnsureConfiguredPluginsInstalledSkipsDisabledGlobal(t *testing.T) {{
\tcfg := &fakeAutoInstallConfig{{
\t\tEnabled: false,
\t\tDir: t.TempDir(),
\t\tConfigs: map[string]fakeAutoInstallPlugin{{
\t\t\t"sample-provider": {{Enabled: enabledBoolPtr(true)}},
\t\t}},
\t}}
\tcalled := false
\treport := ensureConfiguredPluginsInstalled(context.Background(), cfg, autoInstallOptions{{
\t\tInstall: func(context.Context, Client, Plugin, InstallOptions) (InstallResult, error) {{
\t\t\tcalled = true
\t\t\treturn InstallResult{{}}, nil
\t\t}},
\t}})
\tif called {{
\t\tt.Fatal("installer called while plugins are globally disabled")
\t}}
\tif len(report.Installed) != 0 || len(report.Warnings) != 0 {{
\t\tt.Fatalf("report = %#v, want empty", report)
\t}}
}}

func TestEnsureConfiguredPluginsInstalledSkipsDisabledPlugin(t *testing.T) {{
\tcfg := &fakeAutoInstallConfig{{
\t\tEnabled: true,
\t\tDir: t.TempDir(),
\t\tConfigs: map[string]fakeAutoInstallPlugin{{
\t\t\t"sample-provider": {{Enabled: enabledBoolPtr(false)}},
\t\t}},
\t}}
\tcalled := false
\treport := ensureConfiguredPluginsInstalled(context.Background(), cfg, autoInstallOptions{{
\t\tInstall: func(context.Context, Client, Plugin, InstallOptions) (InstallResult, error) {{
\t\t\tcalled = true
\t\t\treturn InstallResult{{}}, nil
\t\t}},
\t}})
\tif called {{
\t\tt.Fatal("installer called for disabled plugin")
\t}}
\tif len(report.Installed) != 0 || len(report.Warnings) != 0 {{
\t\tt.Fatalf("report = %#v, want empty", report)
\t}}
}}

func TestEnsureConfiguredPluginsInstalledSkipsInstalledPlugin(t *testing.T) {{
\troot := t.TempDir()
\ttargetDir := filepath.Join(root, runtime.GOOS, runtime.GOARCH)
\tif err := os.MkdirAll(targetDir, 0o755); err != nil {{
\t\tt.Fatalf("MkdirAll() error = %v", err)
\t}}
\tif err := os.WriteFile(filepath.Join(targetDir, "sample-provider"+autoInstallPluginExtension(runtime.GOOS)), []byte("plugin"), 0o755); err != nil {{
\t\tt.Fatalf("WriteFile() error = %v", err)
\t}}
\tcfg := &fakeAutoInstallConfig{{
\t\tEnabled: true,
\t\tDir: root,
\t\tConfigs: map[string]fakeAutoInstallPlugin{{
\t\t\t"sample-provider": {{Enabled: enabledBoolPtr(true)}},
\t\t}},
\t}}
\tcalled := false
\treport := ensureConfiguredPluginsInstalled(context.Background(), cfg, autoInstallOptions{{
\t\tInstall: func(context.Context, Client, Plugin, InstallOptions) (InstallResult, error) {{
\t\t\tcalled = true
\t\t\treturn InstallResult{{}}, nil
\t\t}},
\t}})
\tif called {{
\t\tt.Fatal("installer called for already installed plugin")
\t}}
\tif len(report.Installed) != 0 || len(report.Warnings) != 0 {{
\t\tt.Fatalf("report = %#v, want empty", report)
\t}}
}}

func TestEnsureConfiguredPluginsInstalledInstallsUniqueRegistryMatch(t *testing.T) {{
\troot := t.TempDir()
\tcfg := &fakeAutoInstallConfig{{
\t\tEnabled: true,
\t\tDir: root,
\t\tConfigs: map[string]fakeAutoInstallPlugin{{
\t\t\t"sample-provider": {{Enabled: enabledBoolPtr(true)}},
\t\t}},
\t}}
\tfakeHTTP := autoInstallFakeDoer{{
\t\tDefaultRegistryURL: `{{"schema_version":1,"plugins":[{{"id":"sample-provider","name":"Sample","description":"Sample plugin","author":"Tester","repository":"https://github.com/example/sample-provider"}}]}}`,
\t}}
\tvar gotPlugin Plugin
\tvar gotOptions InstallOptions
\treport := ensureConfiguredPluginsInstalled(context.Background(), cfg, autoInstallOptions{{
\t\tHTTPClient: fakeHTTP,
\t\tGOOS: "linux",
\t\tGOARCH: "amd64",
\t\tInstall: func(_ context.Context, _ Client, plugin Plugin, options InstallOptions) (InstallResult, error) {{
\t\t\tgotPlugin = plugin
\t\t\tgotOptions = options
\t\t\treturn InstallResult{{ID: plugin.ID, Version: "1.2.3", Path: filepath.Join(options.PluginsDir, options.GOOS, options.GOARCH, plugin.ID+".so")}}, nil
\t\t}},
\t}})
\tif len(report.Warnings) != 0 {{
\t\tt.Fatalf("warnings = %#v, want none", report.Warnings)
\t}}
\tif len(report.Installed) != 1 {{
\t\tt.Fatalf("installed len = %d, want 1; report=%#v", len(report.Installed), report)
\t}}
\tif gotPlugin.ID != "sample-provider" {{
\t\tt.Fatalf("installed plugin = %#v", gotPlugin)
\t}}
\tif gotOptions.PluginsDir != root || gotOptions.GOOS != "linux" || gotOptions.GOARCH != "amd64" {{
\t\tt.Fatalf("install options = %#v", gotOptions)
\t}}
}}

func TestEnsureConfiguredPluginsInstalledSkipsAmbiguousRegistryMatch(t *testing.T) {{
\tsourceURL := "https://plugins.example/registry.json"
\tcfg := &fakeAutoInstallConfig{{
\t\tEnabled: true,
\t\tDir: t.TempDir(),
\t\tStoreSources: []string{{sourceURL}},
\t\tConfigs: map[string]fakeAutoInstallPlugin{{
\t\t\t"sample-provider": {{Enabled: enabledBoolPtr(true)}},
\t\t}},
\t}}
\tregistry := `{{"schema_version":1,"plugins":[{{"id":"sample-provider","name":"Sample","description":"Sample plugin","author":"Tester","repository":"https://github.com/example/sample-provider"}}]}}`
\tcalled := false
\treport := ensureConfiguredPluginsInstalled(context.Background(), cfg, autoInstallOptions{{
\t\tHTTPClient: autoInstallFakeDoer{{
\t\t\tDefaultRegistryURL: registry,
\t\t\tsourceURL: registry,
\t\t}},
\t\tInstall: func(context.Context, Client, Plugin, InstallOptions) (InstallResult, error) {{
\t\t\tcalled = true
\t\t\treturn InstallResult{{}}, nil
\t\t}},
\t}})
\tif called {{
\t\tt.Fatal("installer called for ambiguous registry match")
\t}}
\tif len(report.Installed) != 0 {{
\t\tt.Fatalf("installed = %#v, want none", report.Installed)
\t}}
\tif len(report.Warnings) != 1 || !strings.Contains(report.Warnings[0].Message, "multiple registries") {{
\t\tt.Fatalf("warnings = %#v, want ambiguity warning", report.Warnings)
\t}}
}}
''')

replace_once(
    ROOT / 'internal/pluginhost/auth_provider.go',
    '''\treq.RawJSON = bytes.Clone(req.RawJSON)
\tresp, errParse := provider.ParseAuth(ctx, req)
''',
    '''\treq.RawJSON = normalizePluginStorageJSON(req.Provider, bytes.Clone(req.RawJSON))
\tresp, errParse := provider.ParseAuth(ctx, req)
''',
)

replace_once(
    ROOT / 'internal/pluginhost/auth_provider.go',
    '''\tif provider != "" {
\t\tmetadata["type"] = provider
\t}
\tattributes := cloneStringMap(data.Attributes)
''',
    '''\tif provider != "" {
\t\tmetadata["type"] = provider
\t}
\tdisabled := data.Disabled || pluginAuthDisabledFromMetadata(metadata)
\tmetadata["disabled"] = disabled
\tattributes := cloneStringMap(data.Attributes)
''',
)

replace_once(
    ROOT / 'internal/pluginhost/auth_provider.go',
    '''\tstatus := coreauth.StatusActive
\tif data.Disabled {
\t\tstatus = coreauth.StatusDisabled
\t}
''',
    '''\tstatus := coreauth.StatusActive
\tif disabled {
\t\tstatus = coreauth.StatusDisabled
\t}
''',
)

replace_once(
    ROOT / 'internal/pluginhost/auth_provider.go',
    '''\t\tDisabled:         data.Disabled,
''',
    '''\t\tDisabled:         disabled,
''',
)

replace_once(
    ROOT / 'internal/pluginhost/adapters.go',
    '''func storageJSONFromAuth(auth *coreauth.Auth) []byte {
\tif auth == nil {
\t\treturn nil
\t}
\tif rawProvider, okRaw := auth.Storage.(interface{ RawJSON() []byte }); okRaw {
\t\treturn bytes.Clone(rawProvider.RawJSON())
\t}
\tif len(auth.Metadata) == 0 {
\t\treturn nil
\t}
\tdata, errMarshal := json.Marshal(auth.Metadata)
\tif errMarshal != nil {
\t\treturn nil
\t}
\treturn data
}
''',
    '''func storageJSONFromAuth(auth *coreauth.Auth) []byte {
\tif auth == nil {
\t\treturn nil
\t}
\tif rawProvider, okRaw := auth.Storage.(interface{ RawJSON() []byte }); okRaw {
\t\treturn normalizePluginStorageJSON(auth.Provider, bytes.Clone(rawProvider.RawJSON()))
\t}
\tif len(auth.Metadata) == 0 {
\t\treturn nil
\t}
\tdata, errMarshal := json.Marshal(auth.Metadata)
\tif errMarshal != nil {
\t\treturn nil
\t}
\treturn normalizePluginStorageJSON(auth.Provider, data)
}
''',
)

write_text(ROOT / 'internal/pluginhost/gemini_cli_storage_compat.go', '''package pluginhost

import (
\t"bytes"
\t"encoding/json"
\t"strings"
)

func normalizePluginStorageJSON(provider string, raw []byte) []byte {
\ttrimmed := bytes.TrimSpace(raw)
\tif len(trimmed) == 0 {
\t\treturn nil
\t}
\tprovider = normalizeProviderID(provider)
\tif provider != "gemini-cli" && provider != "gemini" {
\t\treturn raw
\t}
\tvar data map[string]any
\tif err := json.Unmarshal(trimmed, &data); err != nil || data == nil {
\t\treturn raw
\t}
\tnormalizeGeminiCLIStorageMap(data)
\tout, err := json.Marshal(data)
\tif err != nil {
\t\treturn raw
\t}
\treturn out
}

func pluginAuthDisabledFromMetadata(metadata map[string]any) bool {
\tif metadata == nil {
\t\treturn false
\t}
\tswitch value := metadata["disabled"].(type) {
\tcase bool:
\t\treturn value
\tcase string:
\t\tvalue = strings.ToLower(strings.TrimSpace(value))
\t\treturn value == "true" || value == "1" || value == "yes" || value == "on"
\tcase float64:
\t\treturn value != 0
\tcase int:
\t\treturn value != 0
\tcase int64:
\t\treturn value != 0
\tcase json.Number:
\t\tparsed, err := value.Int64()
\t\treturn err == nil && parsed != 0
\tdefault:
\t\treturn false
\t}
}

func normalizeGeminiCLIStorageMap(data map[string]any) {
\tif data == nil {
\t\treturn
\t}
\tif rawType := strings.TrimSpace(stringValue(data["type"])); rawType != "" {
\t\tproviderType := normalizeProviderID(rawType)
\t\tif providerType != "gemini-cli" && providerType != "gemini" {
\t\t\treturn
\t\t}
\t}
\trawToken, ok := data["token"]
\tif !ok {
\t\treturn
\t}
\tswitch token := rawToken.(type) {
\tcase map[string]any:
\t\treturn
\tcase string:
\t\ttoken = strings.TrimSpace(token)
\t\tif token == "" {
\t\t\tdelete(data, "token")
\t\t\treturn
\t\t}
\t\tvar parsed map[string]any
\t\tif err := json.Unmarshal([]byte(token), &parsed); err == nil && parsed != nil {
\t\t\tdata["token"] = parsed
\t\t\tcopyGeminiCLITokenFields(data, parsed)
\t\t\treturn
\t\t}
\t\tdata["token"] = map[string]any{"access_token": token}
\t\tif strings.TrimSpace(stringValue(data["access_token"])) == "" {
\t\t\tdata["access_token"] = token
\t\t}
\tdefault:
\t\tdelete(data, "token")
\t}
}

func copyGeminiCLITokenFields(data map[string]any, token map[string]any) {
\tfor _, key := range []string{"access_token", "refresh_token", "token_type", "expiry", "expires_in", "scope"} {
\t\tif _, exists := data[key]; exists {
\t\t\tcontinue
\t\t}
\t\tif value, ok := token[key]; ok {
\t\t\tdata[key] = value
\t\t}
\t}
}

func stringValue(value any) string {
\tswitch typed := value.(type) {
\tcase string:
\t\treturn typed
\tcase interface{ String() string }:
\t\treturn typed.String()
\tdefault:
\t\treturn ""
\t}
}
''')

write_text(ROOT / 'internal/pluginhost/gemini_cli_storage_compat_test.go', f'''package pluginhost

import (
\t"context"
\t"encoding/json"
\t"testing"

\tcoreauth "{import_path('sdk/cliproxy/auth')}"
\t"{import_path('sdk/pluginapi')}"
)

func TestParseAuthNormalizesGeminiCLIStringToken(t *testing.T) {{
\tvar seen map[string]any
\thost := newHostWithRecords(capabilityRecord{{
\t\tid: "geminicli",
\t\tplugin: pluginapi.Plugin{{
\t\t\tCapabilities: pluginapi.Capabilities{{
\t\t\t\tAuthProvider: fakeAuthProvider{{
\t\t\t\t\tidentifier: "gemini-cli",
\t\t\t\t\tparseAuth: func(ctx context.Context, req pluginapi.AuthParseRequest) (pluginapi.AuthParseResponse, error) {{
\t\t\t\t\t\tif err := json.Unmarshal(req.RawJSON, &seen); err != nil {{
\t\t\t\t\t\t\tt.Fatalf("normalized RawJSON is invalid: %v", err)
\t\t\t\t\t\t}}
\t\t\t\t\t\treturn pluginapi.AuthParseResponse{{
\t\t\t\t\t\t\tHandled: true,
\t\t\t\t\t\t\tAuth: pluginapi.AuthData{{
\t\t\t\t\t\t\t\tProvider: "gemini-cli",
\t\t\t\t\t\t\t\tID: "gemini.json",
\t\t\t\t\t\t\t\tStorageJSON: req.RawJSON,
\t\t\t\t\t\t\t}},
\t\t\t\t\t\t}}, nil
\t\t\t\t\t}},
\t\t\t\t}},
\t\t\t}},
\t\t}},
\t}})
\t_, handled, errParse := host.ParseAuth(context.Background(), pluginapi.AuthParseRequest{{
\t\tProvider: "gemini-cli",
\t\tRawJSON: []byte(`{{"type":"gemini-cli","token":"{{\\"access_token\\":\\"access-token\\",\\"refresh_token\\":\\"refresh-token\\"}}","project_id":"project-id"}}`),
\t}})
\tif errParse != nil {{
\t\tt.Fatalf("ParseAuth() error = %v", errParse)
\t}}
\tif !handled {{
\t\tt.Fatal("ParseAuth() handled = false")
\t}}
\ttoken, ok := seen["token"].(map[string]any)
\tif !ok {{
\t\tt.Fatalf("token = %#v, want object", seen["token"])
\t}}
\tif token["access_token"] != "access-token" || seen["access_token"] != "access-token" || seen["refresh_token"] != "refresh-token" {{
\t\tt.Fatalf("normalized storage = %#v", seen)
\t}}
}}

func TestStorageJSONFromAuthNormalizesGeminiCLIRawStringToken(t *testing.T) {{
\tauth := &coreauth.Auth{{
\t\tProvider: "gemini-cli",
\t\tStorage: &pluginTokenStorage{{
\t\t\tprovider: "gemini-cli",
\t\t\trawJSON: []byte(`{{"type":"gemini-cli","token":"plain-access-token","project_id":"project-id"}}`),
\t\t}},
\t}}
\tvar data map[string]any
\tif err := json.Unmarshal(storageJSONFromAuth(auth), &data); err != nil {{
\t\tt.Fatalf("storageJSONFromAuth() invalid JSON: %v", err)
\t}}
\ttoken, ok := data["token"].(map[string]any)
\tif !ok {{
\t\tt.Fatalf("token = %#v, want object", data["token"])
\t}}
\tif token["access_token"] != "plain-access-token" || data["access_token"] != "plain-access-token" {{
\t\tt.Fatalf("normalized storage = %#v", data)
\t}}
}}

func TestParseAuthRestoresDisabledFromPluginMetadata(t *testing.T) {{
\thost := newHostWithRecords(capabilityRecord{{
\t\tid: "geminicli",
\t\tplugin: pluginapi.Plugin{{
\t\t\tCapabilities: pluginapi.Capabilities{{
\t\t\t\tAuthProvider: fakeAuthProvider{{
\t\t\t\t\tidentifier: "gemini-cli",
\t\t\t\t\tparseAuth: func(ctx context.Context, req pluginapi.AuthParseRequest) (pluginapi.AuthParseResponse, error) {{
\t\t\t\t\t\treturn pluginapi.AuthParseResponse{{
\t\t\t\t\t\t\tHandled: true,
\t\t\t\t\t\t\tAuth: pluginapi.AuthData{{
\t\t\t\t\t\t\t\tProvider: "gemini-cli",
\t\t\t\t\t\t\t\tID: "disabled.json",
\t\t\t\t\t\t\t\tMetadata: map[string]any{{"disabled": true}},
\t\t\t\t\t\t\t\tStorageJSON: []byte(`{{"type":"gemini-cli","disabled":true}}`),
\t\t\t\t\t\t\t}},
\t\t\t\t\t\t}}, nil
\t\t\t\t\t}},
\t\t\t\t}},
\t\t\t}},
\t\t}},
\t}})
\tauth, handled, errParse := host.ParseAuth(context.Background(), pluginapi.AuthParseRequest{{
\t\tProvider: "gemini-cli",
\t\tRawJSON: []byte(`{{"type":"gemini-cli","disabled":true}}`),
\t}})
\tif errParse != nil {{
\t\tt.Fatalf("ParseAuth() error = %v", errParse)
\t}}
\tif !handled || auth == nil {{
\t\tt.Fatalf("ParseAuth() handled=%t auth=%#v, want auth", handled, auth)
\t}}
\tif !auth.Disabled || auth.Status != coreauth.StatusDisabled || auth.Metadata["disabled"] != true {{
\t\tt.Fatalf("auth disabled/status/metadata = %v/%v/%#v, want disabled", auth.Disabled, auth.Status, auth.Metadata["disabled"])
\t}}
}}
''')

server = ROOT / 'internal/api/server.go'
auth_files = ROOT / 'internal/api/handlers/management/auth_files.go'
api_tools = ROOT / 'internal/api/handlers/management/api_tools.go'
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
    api_tools,
    '''	Data            string            `json:"data"`
}
''',
    '''	Data            string            `json:"data"`
	UseExecutorSnake *bool             `json:"use_executor"`
	UseExecutorCamel *bool             `json:"useExecutor"`
	UseExecutorPascal *bool            `json:"UseExecutor"`
}
''',
)
insert_before(
    api_tools,
    'func firstNonEmptyString(values ...*string) string {\n',
    '''func firstNonNilBool(values ...*bool) bool {
\tfor _, v := range values {
\t\tif v != nil {
\t\t\treturn *v
\t\t}
\t}
\treturn false
}

''',
    'func firstNonNilBool(values ...*bool) bool',
)
replace_once(
    api_tools,
    '''\thttpClient := &http.Client{
\t\tTimeout: defaultAPICallTimeout,
\t}
\thttpClient.Transport = h.apiCallTransport(auth)

\tresp, errDo := httpClient.Do(req)
''',
    '''\tuseExecutor := firstNonNilBool(body.UseExecutorSnake, body.UseExecutorCamel, body.UseExecutorPascal)
\tvar resp *http.Response
\tvar errDo error
\tif useExecutor {
\t\tif auth == nil {
\t\t\tc.JSON(http.StatusBadRequest, gin.H{"error": "auth not found"})
\t\t\treturn
\t\t}
\t\tif h == nil || h.authManager == nil {
\t\t\tc.JSON(http.StatusServiceUnavailable, gin.H{"error": "core auth manager unavailable"})
\t\t\treturn
\t\t}
\t\tresp, errDo = h.authManager.HttpRequest(c.Request.Context(), auth, req)
\t} else {
\t\thttpClient := &http.Client{
\t\t\tTimeout: defaultAPICallTimeout,
\t\t}
\t\thttpClient.Transport = h.apiCallTransport(auth)
\t\tresp, errDo = httpClient.Do(req)
\t}
''',
)
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
replace_once(
    auth_files,
    '''				typeValue := gjson.GetBytes(data, "type").String()
				emailValue := gjson.GetBytes(data, "email").String()
				fileData["type"] = typeValue
				fileData["email"] = emailValue
''',
    '''				typeValue := gjson.GetBytes(data, "type").String()
				emailValue := gjson.GetBytes(data, "email").String()
				fileData["type"] = typeValue
				fileData["email"] = emailValue
				if lastErrorRaw := gjson.GetBytes(data, "last_error"); lastErrorRaw.IsObject() {
					var lastError map[string]any
					if errUnmarshal := json.Unmarshal([]byte(lastErrorRaw.Raw), &lastError); errUnmarshal == nil && len(lastError) > 0 {
						fileData["last_error"] = lastError
					}
				}
				if strings.EqualFold(strings.TrimSpace(typeValue), "codex") {
					if claims := extractCodexIDTokenClaimsFromRaw(gjson.GetBytes(data, "id_token").String()); claims != nil {
						fileData["id_token"] = claims
					}
				}
''',
)
insert_before(
    auth_files,
    'func extractCodexIDTokenClaims(auth *coreauth.Auth) gin.H {\n',
    '''func extractCodexIDTokenClaimsFromRaw(idTokenRaw string) gin.H {
	idToken := strings.TrimSpace(idTokenRaw)
	if idToken == "" {
		return nil
	}
	claims, err := codex.ParseJWTToken(idToken)
	if err != nil || claims == nil {
		return nil
	}
	return codexIDTokenClaimsEntry(claims)
}

''',
    'func extractCodexIDTokenClaimsFromRaw',
)
replace_go_function(
    auth_files,
    'func extractCodexIDTokenClaims(auth *coreauth.Auth) gin.H',
    '''func extractCodexIDTokenClaims(auth *coreauth.Auth) gin.H {
	if auth == nil || auth.Metadata == nil {
		return nil
	}
	if !strings.EqualFold(strings.TrimSpace(auth.Provider), "codex") {
		return nil
	}
	idTokenRaw, ok := auth.Metadata["id_token"].(string)
	if !ok {
		return nil
	}
	return extractCodexIDTokenClaimsFromRaw(idTokenRaw)
}

func codexIDTokenClaimsEntry(claims *codex.JWTClaims) gin.H {
	if claims == nil {
		return nil
	}
	result := gin.H{}
	if v := strings.TrimSpace(claims.CodexAuthInfo.ChatgptAccountID); v != "" {
		result["chatgpt_account_id"] = v
	}
	if v := strings.TrimSpace(claims.CodexAuthInfo.ChatgptPlanType); v != "" {
		result["plan_type"] = v
	}
	if v := claims.CodexAuthInfo.ChatgptSubscriptionActiveStart; v != nil {
		result["chatgpt_subscription_active_start"] = v
	}
	if v := claims.CodexAuthInfo.ChatgptSubscriptionActiveUntil; v != nil {
		result["chatgpt_subscription_active_until"] = v
	}

	if len(result) == 0 {
		return nil
	}
	return result
}
''',
    'func codexIDTokenClaimsEntry',
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
redisqueue_plugin_test = ROOT / 'internal/redisqueue/plugin_test.go'
if redisqueue_plugin_test.exists():
    text = read_text(redisqueue_plugin_test)
    text = text.replace(
        f'internallogging "{import_path("internal/logging")}"',
        f'"{import_path("internal/requestmeta")}"',
    )
    text = text.replace('internallogging.', 'requestmeta.')
    write_text(redisqueue_plugin_test, text)

(ROOT / 'internal/requestmeta').mkdir(parents=True, exist_ok=True)
write_text(ROOT / 'internal/requestmeta/requestid.go', f'''package requestmeta

import (
\t"context"
\t"crypto/rand"
\t"encoding/hex"
\t"strings"
)

type requestIDKey struct{{}}

// GenerateRequestID creates a new 8-character hex request ID.
func GenerateRequestID() string {{
\tb := make([]byte, 4)
\tif _, err := rand.Read(b); err != nil {{
\t\treturn "00000000"
\t}}
\treturn hex.EncodeToString(b)
}}

// WithRequestID returns a new context with the request ID attached.
func WithRequestID(ctx context.Context, requestID string) context.Context {{
\tif ctx == nil {{
\t\tctx = context.Background()
\t}}
\trequestID = strings.TrimSpace(requestID)
\tif requestID == "" {{
\t\treturn ctx
\t}}
\treturn context.WithValue(ctx, requestIDKey{{}}, requestID)
}}

// GetRequestID retrieves the request ID from the context.
func GetRequestID(ctx context.Context) string {{
\tif ctx == nil {{
\t\treturn ""
\t}}
\tif id, ok := ctx.Value(requestIDKey{{}}).(string); ok {{
\t\treturn strings.TrimSpace(id)
\t}}
\treturn ""
}}
''')

write_text(ROOT / 'internal/requestmeta/response.go', f'''package requestmeta

import (
\t"context"
\t"net/http"
\t"strings"
\t"sync"
\t"sync/atomic"
)

type endpointKey struct{{}}
type responseStatusKey struct{{}}
type responseHeadersKey struct{{}}

type responseStatusHolder struct {{
\tstatus atomic.Int32
}}

type responseHeadersHolder struct {{
\tmu      sync.RWMutex
\theaders http.Header
}}

func WithEndpoint(ctx context.Context, endpoint string) context.Context {{
\tif ctx == nil {{
\t\tctx = context.Background()
\t}}
\tendpoint = strings.TrimSpace(endpoint)
\tif endpoint == "" {{
\t\treturn ctx
\t}}
\treturn context.WithValue(ctx, endpointKey{{}}, endpoint)
}}

func GetEndpoint(ctx context.Context) string {{
\tif ctx == nil {{
\t\treturn ""
\t}}
\tif endpoint, ok := ctx.Value(endpointKey{{}}).(string); ok {{
\t\treturn strings.TrimSpace(endpoint)
\t}}
\treturn ""
}}

func WithResponseStatusHolder(ctx context.Context) context.Context {{
\tif ctx == nil {{
\t\tctx = context.Background()
\t}}
\tif holder, ok := ctx.Value(responseStatusKey{{}}).(*responseStatusHolder); ok && holder != nil {{
\t\treturn ctx
\t}}
\treturn context.WithValue(ctx, responseStatusKey{{}}, &responseStatusHolder{{}})
}}

func WithResponseHeadersHolder(ctx context.Context) context.Context {{
\tif ctx == nil {{
\t\tctx = context.Background()
\t}}
\tif holder, ok := ctx.Value(responseHeadersKey{{}}).(*responseHeadersHolder); ok && holder != nil {{
\t\treturn ctx
\t}}
\treturn context.WithValue(ctx, responseHeadersKey{{}}, &responseHeadersHolder{{}})
}}

func SetResponseStatus(ctx context.Context, status int) {{
\tif ctx == nil || status <= 0 {{
\t\treturn
\t}}
\tholder, ok := ctx.Value(responseStatusKey{{}}).(*responseStatusHolder)
\tif !ok || holder == nil {{
\t\treturn
\t}}
\tholder.status.Store(int32(status))
}}

func SetResponseHeaders(ctx context.Context, headers http.Header) {{
\tif ctx == nil {{
\t\treturn
\t}}
\tholder, ok := ctx.Value(responseHeadersKey{{}}).(*responseHeadersHolder)
\tif !ok || holder == nil {{
\t\treturn
\t}}
\tholder.mu.Lock()
\tdefer holder.mu.Unlock()
\tholder.headers = cloneHTTPHeader(headers)
}}

func GetResponseStatus(ctx context.Context) int {{
\tif ctx == nil {{
\t\treturn 0
\t}}
\tholder, ok := ctx.Value(responseStatusKey{{}}).(*responseStatusHolder)
\tif !ok || holder == nil {{
\t\treturn 0
\t}}
\treturn int(holder.status.Load())
}}

func GetResponseHeaders(ctx context.Context) http.Header {{
\tif ctx == nil {{
\t\treturn nil
\t}}
\tholder, ok := ctx.Value(responseHeadersKey{{}}).(*responseHeadersHolder)
\tif !ok || holder == nil {{
\t\treturn nil
\t}}
\tholder.mu.RLock()
\tdefer holder.mu.RUnlock()
\treturn cloneHTTPHeader(holder.headers)
}}

func cloneHTTPHeader(src http.Header) http.Header {{
\tif len(src) == 0 {{
\t\treturn nil
\t}}
\tdst := make(http.Header, len(src))
\tfor key, values := range src {{
\t\tdst[key] = append([]string(nil), values...)
\t}}
\treturn dst
}}
''')

write_text(ROOT / 'internal/logging/requestid.go', f'''package logging

import (
\t"context"

\t"github.com/gin-gonic/gin"
\t"{import_path('internal/requestmeta')}"
)

// ginRequestIDKey is the Gin context key for request IDs.
const ginRequestIDKey = "__request_id__"

// GenerateRequestID creates a new 8-character hex request ID.
func GenerateRequestID() string {{
\treturn requestmeta.GenerateRequestID()
}}

// WithRequestID returns a new context with the request ID attached.
func WithRequestID(ctx context.Context, requestID string) context.Context {{
\treturn requestmeta.WithRequestID(ctx, requestID)
}}

// GetRequestID retrieves the request ID from the context.
func GetRequestID(ctx context.Context) string {{
\treturn requestmeta.GetRequestID(ctx)
}}

// SetGinRequestID stores the request ID in the Gin context.
func SetGinRequestID(c *gin.Context, requestID string) {{
\tif c != nil {{
\t\tc.Set(ginRequestIDKey, requestID)
\t}}
}}

// GetGinRequestID retrieves the request ID from the Gin context.
func GetGinRequestID(c *gin.Context) string {{
\tif c == nil {{
\t\treturn ""
\t}}
\tif id, exists := c.Get(ginRequestIDKey); exists {{
\t\tif s, ok := id.(string); ok {{
\t\t\treturn s
\t\t}}
\t}}
\treturn ""
}}
''')

write_text(ROOT / 'internal/logging/requestmeta.go', f'''package logging

import (
\t"context"
\t"net/http"

\t"{import_path('internal/requestmeta')}"
)

func WithEndpoint(ctx context.Context, endpoint string) context.Context {{
\treturn requestmeta.WithEndpoint(ctx, endpoint)
}}

func GetEndpoint(ctx context.Context) string {{
\treturn requestmeta.GetEndpoint(ctx)
}}

func WithResponseStatusHolder(ctx context.Context) context.Context {{
\treturn requestmeta.WithResponseStatusHolder(ctx)
}}

func WithResponseHeadersHolder(ctx context.Context) context.Context {{
\treturn requestmeta.WithResponseHeadersHolder(ctx)
}}

func SetResponseStatus(ctx context.Context, status int) {{
\trequestmeta.SetResponseStatus(ctx, status)
}}

func SetResponseHeaders(ctx context.Context, headers http.Header) {{
\trequestmeta.SetResponseHeaders(ctx, headers)
}}

func GetResponseStatus(ctx context.Context) int {{
\treturn requestmeta.GetResponseStatus(ctx)
}}

func GetResponseHeaders(ctx context.Context) http.Header {{
\treturn requestmeta.GetResponseHeaders(ctx)
}}
''')

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
	if updated.Metadata != nil {
		delete(updated.Metadata, "last_error")
	}
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
subprocess.run([
    'gofmt',
    '-w',
    'cmd/server/main.go',
    'internal/logging/requestid.go',
    'internal/logging/requestmeta.go',
    'internal/pluginhost/gemini_cli_storage_compat.go',
    'internal/pluginhost/gemini_cli_storage_compat_test.go',
    'internal/pluginstore/autoinstall.go',
    'internal/pluginstore/autoinstall_test.go',
    'internal/redisqueue/plugin.go',
    'internal/redisqueue/plugin_test.go',
    'internal/requestmeta/requestid.go',
    'internal/requestmeta/response.go',
], cwd=ROOT, check=True)
subprocess.run(['go', 'mod', 'tidy'], cwd=ROOT, check=True)
