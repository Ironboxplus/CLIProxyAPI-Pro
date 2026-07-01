#!/usr/bin/env python3
import json
import shutil
import sys
from pathlib import Path

CUSTOMIZATION_DIR = Path(__file__).resolve().parent
OVERLAY_DIR = CUSTOMIZATION_DIR / 'overlay'
LOCALES_FILE = CUSTOMIZATION_DIR / 'monitoring-locales.json'

QUOTA_LOCALE_KEYS = {
    'en.json': {
        'cached_at': 'Updated',
        'just_now': 'Just now',
        'minutes_ago': '{{count}} minute ago',
        'minutes_ago_plural': '{{count}} minutes ago',
        'hours_ago': '{{count}} hour ago',
        'hours_ago_plural': '{{count}} hours ago',
        'days_ago': '{{count}} day ago',
        'days_ago_plural': '{{count}} days ago',
    },
    'ru.json': {
        'cached_at': 'Обновлено',
        'just_now': 'Только что',
        'minutes_ago': '{{count}} минуту назад',
        'minutes_ago_plural': '{{count}} минут назад',
        'hours_ago': '{{count}} час назад',
        'hours_ago_plural': '{{count}} часов назад',
        'days_ago': '{{count}} день назад',
        'days_ago_plural': '{{count}} дней назад',
    },
    'zh-CN.json': {
        'cached_at': '更新于',
        'just_now': '刚刚',
        'minutes_ago': '{{count}} 分钟前',
        'hours_ago': '{{count}} 小时前',
        'days_ago': '{{count}} 天前',
    },
    'zh-TW.json': {
        'cached_at': '更新於',
        'just_now': '剛剛',
        'minutes_ago': '{{count}} 分鐘前',
        'hours_ago': '{{count}} 小時前',
        'days_ago': '{{count}} 天前',
    },
}

GEMINI_CLI_LOCALE_KEYS = {
    'en.json': {
        'auth_filter': 'GeminiCLI',
        'quota': {
            'title': 'Gemini CLI Quota',
            'empty_title': 'No Gemini CLI Auth Files',
            'empty_desc': 'Upload a Gemini CLI credential to view remaining quota.',
            'idle': 'Click here to refresh quota',
            'loading': 'Loading quota...',
            'load_failed': 'Failed to load quota: {{message}}',
            'missing_auth_index': 'Auth file missing auth_index',
            'missing_project_id': 'Gemini CLI credential missing project ID',
            'empty_buckets': 'No quota data available',
            'remaining_amount': 'Remaining {{count}}',
            'tier_label': 'Tier',
            'tier_free': 'Free',
            'tier_legacy': 'Legacy',
            'tier_standard': 'Standard',
            'tier_pro': 'Pro',
            'tier_ultra': 'Ultra',
            'credit_label': 'Google One AI Credits',
            'credit_amount': '{{count}} credits',
        },
    },
    'ru.json': {
        'auth_filter': 'GeminiCLI',
        'quota': {
            'title': 'Квота Gemini CLI',
            'empty_title': 'Файлы авторизации Gemini CLI отсутствуют',
            'empty_desc': 'Загрузите учётные данные Gemini CLI, чтобы увидеть оставшуюся квоту.',
            'idle': 'Не загружено. Нажмите "Обновить квоту".',
            'loading': 'Загрузка квоты...',
            'load_failed': 'Не удалось загрузить квоту: {{message}}',
            'missing_auth_index': 'В файле авторизации отсутствует auth_index',
            'missing_project_id': 'В учётных данных Gemini CLI отсутствует идентификатор проекта',
            'empty_buckets': 'Данные по квоте отсутствуют',
            'remaining_amount': 'Осталось {{count}}',
            'tier_label': 'Уровень',
            'tier_free': 'Бесплатный',
            'tier_legacy': 'Legacy',
            'tier_standard': 'Standard',
            'tier_pro': 'Pro',
            'tier_ultra': 'Ultra',
            'credit_label': 'Google One AI кредиты',
            'credit_amount': '{{count}} кредитов',
        },
    },
    'zh-CN.json': {
        'auth_filter': 'GeminiCLI',
        'quota': {
            'title': 'Gemini CLI 额度',
            'empty_title': '暂无 Gemini CLI 认证',
            'empty_desc': '上传 Gemini CLI 认证文件后即可查看额度。',
            'idle': '点击此处刷新额度',
            'loading': '正在加载额度...',
            'load_failed': '额度获取失败：{{message}}',
            'missing_auth_index': '认证文件缺少 auth_index',
            'missing_project_id': 'Gemini CLI 凭证缺少 Project ID',
            'empty_buckets': '暂无额度数据',
            'remaining_amount': '剩余 {{count}}',
            'tier_label': '层级',
            'tier_free': '免费',
            'tier_legacy': 'Legacy',
            'tier_standard': 'Standard',
            'tier_pro': 'Pro',
            'tier_ultra': 'Ultra',
            'credit_label': 'Google One AI 积分',
            'credit_amount': '{{count}} 积分',
        },
    },
    'zh-TW.json': {
        'auth_filter': 'GeminiCLI',
        'quota': {
            'title': 'Gemini CLI 配額',
            'empty_title': '暫無 Gemini CLI 驗證',
            'empty_desc': '上傳 Gemini CLI 驗證檔案後即可查看配額。',
            'idle': '點擊此處重新整理配額',
            'loading': '正在載入配額...',
            'load_failed': '配額取得失敗：{{message}}',
            'missing_auth_index': '驗證檔案缺少 auth_index',
            'missing_project_id': 'Gemini CLI 憑證缺少 Project ID',
            'empty_buckets': '暫無配額資料',
            'remaining_amount': '剩餘 {{count}}',
            'tier_label': '層級',
            'tier_free': '免費',
            'tier_legacy': 'Legacy',
            'tier_standard': 'Standard',
            'tier_pro': 'Pro',
            'tier_ultra': 'Ultra',
            'credit_label': 'Google One AI 點數',
            'credit_amount': '{{count}} 點數',
        },
    },
}

AUTH_FILES_SEARCH_PLACEHOLDER_KEYS = {
    'en.json': 'Filter by name, type, provider, note, or plan. Use * as a wildcard',
    'ru.json': 'Фильтр по имени, типу, провайдеру, заметке или тарифу, поддерживается wildcard *',
    'zh-CN.json': '输入名称、类型、提供方、备注或套餐关键字，支持 * 通配',
    'zh-TW.json': '輸入名稱、類型、供應方、備註或套餐關鍵字，支援 * 萬用字元',
}


_writes = {}


def read(path: Path) -> str:
    if path in _writes:
        return _writes[path]
    return path.read_text()


def write(path: Path, text: str) -> None:
    _writes[path] = text


def flush_writes() -> None:
    for path, text in _writes.items():
        path.write_text(text)


def replace_once(path: Path, old: str, new: str) -> None:
    text = read(path)
    if new in text:
        return
    if old not in text:
        raise RuntimeError(f'Pattern not found in {path}: {old[:120]!r}')
    write(path, text.replace(old, new, 1))


def replace_all(path: Path, old: str, new: str) -> None:
    text = read(path)
    if old not in text:
        return
    write(path, text.replace(old, new))


def replace_once_in_quota_config(path: Path, store_setter: str, old: str, new: str) -> None:
    text = read(path)
    marker = f"  storeSetter: '{store_setter}',"
    marker_start = text.find(marker)
    if marker_start == -1:
        raise RuntimeError(f'Pattern not found in {path}: {marker!r}')

    success_start = text.find('  buildSuccessState:', marker_start)
    error_start = text.find('  buildErrorState:', success_start)
    if success_start == -1 or error_start == -1:
        raise RuntimeError(f'Pattern not found in {path}: buildSuccessState block for {store_setter}')

    block = text[success_start:error_start]
    if new in block:
        return
    if old not in block:
        raise RuntimeError(f'Pattern not found in {path}: {old[:120]!r}')

    updated = block.replace(old, new, 1)
    write(path, f'{text[:success_start]}{updated}{text[error_start:]}')


def ensure_cached_at_in_quota_success_state(path: Path, store_setter: str) -> None:
    text = read(path)
    marker = f"  storeSetter: '{store_setter}',"
    marker_start = text.find(marker)
    if marker_start == -1:
        raise RuntimeError(f'Pattern not found in {path}: {marker!r}')

    success_start = text.find('  buildSuccessState:', marker_start)
    error_start = text.find('  buildErrorState:', success_start)
    if success_start == -1 or error_start == -1:
        raise RuntimeError(f'Pattern not found in {path}: buildSuccessState block for {store_setter}')

    block = text[success_start:error_start]
    if 'cachedAt:' in block:
        return

    multiline_end = '\n  }),'
    if multiline_end in block:
        updated = block.replace(multiline_end, '\n    cachedAt: Date.now(),\n  }),', 1)
    else:
        inline_end = '}),'
        inline_end_start = block.rfind(inline_end)
        if inline_end_start == -1:
            raise RuntimeError(f'Pattern not found in {path}: buildSuccessState return end for {store_setter}')
        updated = f'{block[:inline_end_start].rstrip()}, cachedAt: Date.now() {block[inline_end_start:]}'

    write(path, f'{text[:success_start]}{updated}{text[error_start:]}')


def insert_once(path: Path, marker: str, insertion: str, present: str) -> None:
    text = read(path)
    if present in text:
        return
    if marker not in text:
        raise RuntimeError(f'Pattern not found in {path}: {marker[:120]!r}')
    write(path, text.replace(marker, insertion, 1))


def copy_overlay(target: Path) -> None:
    for src in OVERLAY_DIR.rglob('*'):
        rel = src.relative_to(OVERLAY_DIR)
        dst = target / rel
        if src.is_dir():
            dst.mkdir(parents=True, exist_ok=True)
        else:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)


def patch_routes(target: Path) -> None:
    path = target / 'src/router/MainRoutes.tsx'
    replace_once(
        path,
        "import { QuotaPage } from '@/pages/QuotaPage';\n",
        "import { QuotaPage } from '@/pages/QuotaPage';\nimport { MonitoringCenterPage } from '@/pages/MonitoringCenterPage';\nimport { AccountInspectionPage } from '@/pages/AccountInspectionPage';\n",
    )
    replace_once(
        path,
        "  { path: '/quota', element: <QuotaPage /> },\n",
        "  { path: '/quota', element: <QuotaPage /> },\n  { path: '/monitoring', element: <MonitoringCenterPage /> },\n  { path: '/account-inspection', element: <AccountInspectionPage /> },\n",
    )


def patch_layout(target: Path) -> None:
    path = target / 'src/components/layout/MainLayout.tsx'
    insert_once(
        path,
        "import {\n  IconSidebar",
        "import { QuotaPersistenceBootstrap } from '@/extensions/quota/QuotaPersistenceBootstrap';\nimport {\n  IconSidebar",
        "QuotaPersistenceBootstrap",
    )
    insert_once(
        path,
        "  IconSidebarProviders,\n",
        "  IconSidebarMonitor,\n  IconSidebarProviders,\n",
        "  IconSidebarMonitor,\n",
    )
    replace_once(
        path,
        "  oauth: <IconSidebarOauth size={18} />,\n  quota: <IconSidebarQuota size={18} />,\n",
        "  oauth: <IconSidebarOauth size={18} />,\n  quota: <IconSidebarQuota size={18} />,\n  monitoring: <IconSidebarMonitor size={18} />,\n",
    )
    text = read(path)
    if "path: '/monitoring'" not in text:
        flat_quota_item = "    { path: '/quota', label: t('nav.quota_management'), icon: sidebarIcons.quota },\n"
        grouped_quota_item = (
            "        {\n"
            "          path: '/quota',\n"
            "          labelKey: 'nav.quota_management',\n"
            "          metaKey: 'nav_meta.quota_management',\n"
            "          icon: sidebarIcons.quota,\n"
            "        },\n"
        )
        if flat_quota_item in text:
            write(
                path,
                text.replace(
                    flat_quota_item,
                    flat_quota_item
                    + "    { path: '/monitoring', label: t('nav.monitoring_center'), icon: sidebarIcons.monitoring },\n"
                    + "    { path: '/account-inspection', label: t('nav.account_inspection'), icon: sidebarIcons.monitoring },\n",
                    1,
                ),
            )
        elif grouped_quota_item in text:
            write(
                path,
                text.replace(
                    grouped_quota_item,
                    grouped_quota_item
                    + "        {\n"
                    + "          path: '/monitoring',\n"
                    + "          labelKey: 'nav.monitoring_center',\n"
                    + "          metaKey: 'nav_meta.monitoring_center',\n"
                    + "          icon: sidebarIcons.monitoring,\n"
                    + "        },\n"
                    + "        {\n"
                    + "          path: '/account-inspection',\n"
                    + "          labelKey: 'nav.account_inspection',\n"
                    + "          metaKey: 'nav_meta.account_inspection',\n"
                    + "          icon: sidebarIcons.monitoring,\n"
                    + "        },\n",
                    1,
                ),
            )
        else:
            raise RuntimeError(f'Pattern not found in {path}: quota navigation item')
    replace_once(
        path,
        "            <PageTransition\n",
        "            <QuotaPersistenceBootstrap />\n            <PageTransition\n",
    )

def patch_icons(target: Path) -> None:
    path = target / 'src/components/ui/icons.tsx'
    insert_once(
        path,
        "export function IconSidebarLogs({ size = 20, ...props }: IconProps) {\n",
        "export function IconSidebarMonitor({ size = 20, ...props }: IconProps) {\n  return (\n    <svg {...sidebarSvgProps} width={size} height={size} {...props}>\n      <path d=\"M3 12h3l2.2-4.5 4.2 9 2.4-5h6.2\" />\n      <path d=\"M4 19h16\" />\n      <path d=\"M4 5h16\" fill=\"currentColor\" fillOpacity=\"0.08\" />\n    </svg>\n  );\n}\n\nexport function IconSidebarLogs({ size = 20, ...props }: IconProps) {\n",
        "export function IconSidebarMonitor",
    )


def patch_quota_types(target: Path) -> None:
    path = target / 'src/types/quota.ts'
    insert_once(
        path,
        "// API payload types\n",
        "// API payload types\nexport interface GeminiCliQuotaBucket {\n  modelId?: string;\n  model_id?: string;\n  tokenType?: string;\n  token_type?: string;\n  remainingFraction?: number | string;\n  remaining_fraction?: number | string;\n  remainingAmount?: number | string;\n  remaining_amount?: number | string;\n  resetTime?: string;\n  reset_time?: string;\n}\n\nexport interface GeminiCliQuotaPayload {\n  buckets?: GeminiCliQuotaBucket[];\n}\n\nexport interface GeminiCliCredits {\n  creditType?: string;\n  credit_type?: string;\n  creditAmount?: string | number;\n  credit_amount?: string | number;\n}\n\nexport interface GeminiCliUserTier {\n  id?: string;\n  name?: string;\n  description?: string;\n  availableCredits?: GeminiCliCredits[];\n  available_credits?: GeminiCliCredits[];\n}\n\nexport interface GeminiCliCodeAssistPayload {\n  currentTier?: GeminiCliUserTier | null;\n  current_tier?: GeminiCliUserTier | null;\n  paidTier?: GeminiCliUserTier | null;\n  paid_tier?: GeminiCliUserTier | null;\n}\n\nexport interface GeminiCliParsedBucket {\n  modelId: string;\n  tokenType: string | null;\n  remainingFraction: number | null;\n  remainingAmount: number | null;\n  resetTime: string | undefined;\n}\n\n",
        "export interface GeminiCliQuotaBucket",
    )
    insert_once(
        path,
        "export interface CodexQuotaWindow",
        "export interface GeminiCliQuotaBucketState {\n  id: string;\n  label: string;\n  remainingFraction: number | null;\n  remainingAmount: number | null;\n  resetTime: string | undefined;\n  tokenType: string | null;\n  modelIds?: string[];\n}\n\nexport interface GeminiCliQuotaState {\n  status: 'idle' | 'loading' | 'success' | 'error';\n  buckets: GeminiCliQuotaBucketState[];\n  projectId?: string;\n  project_id?: string;\n  tierLabel?: string | null;\n  tierId?: string | null;\n  creditBalance?: number | null;\n  error?: string;\n  errorStatus?: number;\n  cachedAt?: number;\n}\n\nexport interface CodexQuotaWindow",
        "export interface GeminiCliQuotaState",
    )
    for old, new in [
        (
            "  errorStatus?: number;\n}\n\n// Quota state types",
            "  errorStatus?: number;\n  cachedAt?: number;\n}\n\n// Quota state types",
        ),
        (
            "  errorStatus?: number;\n}\n\nexport interface CodexQuotaWindow",
            "  errorStatus?: number;\n  cachedAt?: number;\n}\n\nexport interface CodexQuotaWindow",
        ),
        (
            "  errorStatus?: number;\n}\n\n// Kimi API payload types",
            "  errorStatus?: number;\n  cachedAt?: number;\n}\n\n// Kimi API payload types",
        ),
        (
            "export interface KimiQuotaState {\n  status: 'idle' | 'loading' | 'success' | 'error';\n  rows: KimiQuotaRow[];\n  error?: string;\n  errorStatus?: number;\n}",
            "export interface KimiQuotaState {\n  status: 'idle' | 'loading' | 'success' | 'error';\n  rows: KimiQuotaRow[];\n  error?: string;\n  errorStatus?: number;\n  cachedAt?: number;\n}",
        ),
        (
            "export interface XaiQuotaState {\n  status: 'idle' | 'loading' | 'success' | 'error';\n  billing: XaiBillingSummary | null;\n  error?: string;\n  errorStatus?: number;\n}",
            "export interface XaiQuotaState {\n  status: 'idle' | 'loading' | 'success' | 'error';\n  billing: XaiBillingSummary | null;\n  error?: string;\n  errorStatus?: number;\n  cachedAt?: number;\n}",
        ),
    ]:
        replace_once(path, old, new)


def patch_quota_configs(target: Path) -> None:
    path = target / 'src/components/quota/quotaConfigs.ts'
    replace_once(
        path,
        "  CodexUsagePayload,\n  KimiQuotaRow,",
        "  CodexUsagePayload,\n  GeminiCliQuotaState,\n  KimiQuotaRow,",
    )
    replace_once(
        path,
        "type QuotaType = 'antigravity' | 'claude' | 'codex' | 'kimi' | 'xai';",
        "type QuotaType = 'antigravity' | 'claude' | 'codex' | 'gemini-cli' | 'kimi' | 'xai';",
    )
    replace_once(
        path,
        "  codexQuota: Record<string, CodexQuotaState>;\n  kimiQuota: Record<string, KimiQuotaState>;",
        "  codexQuota: Record<string, CodexQuotaState>;\n  geminiCliQuota: Record<string, GeminiCliQuotaState>;\n  kimiQuota: Record<string, KimiQuotaState>;",
    )
    replace_once(
        path,
        "  setCodexQuota: (updater: QuotaUpdater<Record<string, CodexQuotaState>>) => void;\n  setKimiQuota: (updater: QuotaUpdater<Record<string, KimiQuotaState>>) => void;",
        "  setCodexQuota: (updater: QuotaUpdater<Record<string, CodexQuotaState>>) => void;\n  setGeminiCliQuota: (updater: QuotaUpdater<Record<string, GeminiCliQuotaState>>) => void;\n  setKimiQuota: (updater: QuotaUpdater<Record<string, KimiQuotaState>>) => void;",
    )
    for store_setter in [
        'setClaudeQuota',
        'setAntigravityQuota',
        'setCodexQuota',
        'setKimiQuota',
        'setXaiQuota',
    ]:
        ensure_cached_at_in_quota_success_state(path, store_setter)
    for old, new in [
        (
            "  const groups = quota.groups ?? [];\n",
            "  const groups = Array.isArray(quota.groups) ? quota.groups : [];\n",
        ),
        (
            "        ...group.buckets.map((bucket) => {\n",
            "        ...(Array.isArray(group.buckets) ? group.buckets : []).map((bucket) => {\n",
        ),
    ]:
        replace_once(path, old, new)


def patch_quota_page(target: Path) -> None:
    path = target / 'src/pages/QuotaPage.tsx'
    insert_once(
        path,
        "import { useAuthStore } from '@/stores';\n",
        "import { GEMINI_CLI_CONFIG } from '@/extensions/quota/geminiCliQuotaConfig';\nimport { useAuthStore } from '@/stores';\n",
        "GEMINI_CLI_CONFIG",
    )
    insert_once(
        path,
        "      <QuotaSection\n        config={KIMI_CONFIG}\n",
        "      <QuotaSection\n        config={GEMINI_CLI_CONFIG}\n        files={files}\n        loading={loading}\n        disabled={disableControls}\n      />\n      <QuotaSection\n        config={KIMI_CONFIG}\n",
        "config={GEMINI_CLI_CONFIG}",
    )
    replace_all(
        path,
        "import { FEATURES } from '@/config/features';\nimport { quotaPersistenceMiddleware } from '@/extensions/quota/persistenceMiddleware';\n",
        "",
    )
    replace_once(
        path,
        "import { useAuthStore } from '@/stores';\n",
        "import { quotaPersistenceMiddleware } from '@/extensions/quota/persistenceMiddleware';\nimport { useAuthStore } from '@/stores';\n",
    )
    replace_once(
        path,
        "  useEffect(() => {\n    loadFiles();\n  }, [loadFiles]);\n",
        "  useEffect(() => {\n    loadFiles();\n    void quotaPersistenceMiddleware.ensureFresh();\n  }, [loadFiles]);\n",
    )
    replace_all(
        path,
        "\n  useEffect(() => {\n    if (!FEATURES.QUOTA_PERSISTENCE) return;\n    quotaPersistenceMiddleware.start();\n    return () => quotaPersistenceMiddleware.stop();\n  }, []);\n",
        "",
    )
    replace_all(
        path,
        "\n  // Initialize persistence middleware\n  useEffect(() => {\n    if (FEATURES.QUOTA_PERSISTENCE) {\n      quotaPersistenceMiddleware.start();\n      return () => quotaPersistenceMiddleware.stop();\n    }\n  }, []);\n",
        "",
    )


def patch_quota_card(target: Path) -> None:
    path = target / 'src/components/quota/QuotaCard.tsx'
    replace_once(
        path,
        "import { TYPE_COLORS } from '@/utils/quota';\n",
        "import { QuotaCachedTime } from '@/extensions/quota/QuotaCardExtras';\nimport { TYPE_COLORS } from '@/utils/quota';\n",
    )
    replace_once(path, "  errorStatus?: number;\n}", "  errorStatus?: number;\n  cachedAt?: number;\n}")
    replace_once(
        path,
        "        ) : quota ? (\n          renderQuotaItems(quota, t, { styles, QuotaProgressBar })\n        ) : (",
        "        ) : quota ? (\n          <>\n            {renderQuotaItems(quota, t, { styles, QuotaProgressBar })}\n            <QuotaCachedTime quotaStatus={quotaStatus} cachedAt={quota.cachedAt} />\n          </>\n        ) : (",
    )


def patch_quota_store(target: Path) -> None:
    path = target / 'src/stores/useQuotaStore.ts'
    replace_once(
        path,
        "  CodexQuotaState,\n  KimiQuotaState,",
        "  CodexQuotaState,\n  GeminiCliQuotaState,\n  KimiQuotaState,",
    )
    replace_once(
        path,
        "  codexQuota: Record<string, CodexQuotaState>;\n  kimiQuota: Record<string, KimiQuotaState>;",
        "  codexQuota: Record<string, CodexQuotaState>;\n  geminiCliQuota: Record<string, GeminiCliQuotaState>;\n  kimiQuota: Record<string, KimiQuotaState>;",
    )
    replace_once(
        path,
        "  setCodexQuota: (updater: QuotaUpdater<Record<string, CodexQuotaState>>) => void;\n  setKimiQuota: (updater: QuotaUpdater<Record<string, KimiQuotaState>>) => void;",
        "  setCodexQuota: (updater: QuotaUpdater<Record<string, CodexQuotaState>>) => void;\n  setGeminiCliQuota: (updater: QuotaUpdater<Record<string, GeminiCliQuotaState>>) => void;\n  setKimiQuota: (updater: QuotaUpdater<Record<string, KimiQuotaState>>) => void;",
    )
    replace_once(
        path,
        "  codexQuota: {},\n  kimiQuota: {},",
        "  codexQuota: {},\n  geminiCliQuota: {},\n  kimiQuota: {},",
    )
    replace_once(
        path,
        "  setCodexQuota: (updater) =>\n    set((state) => ({\n      codexQuota: resolveUpdater(updater, state.codexQuota),\n    })),\n  setKimiQuota: (updater) =>",
        "  setCodexQuota: (updater) =>\n    set((state) => ({\n      codexQuota: resolveUpdater(updater, state.codexQuota),\n    })),\n  setGeminiCliQuota: (updater) =>\n    set((state) => ({\n      geminiCliQuota: resolveUpdater(updater, state.geminiCliQuota),\n    })),\n  setKimiQuota: (updater) =>",
    )
    replace_once(
        path,
        "      codexQuota: {},\n      kimiQuota: {},",
        "      codexQuota: {},\n      geminiCliQuota: {},\n      kimiQuota: {},",
    )


def patch_quota_constants(target: Path) -> None:
    path = target / 'src/utils/quota/constants.ts'
    insert_once(
        path,
        "  aistudio: {\n",
        "  'gemini-cli': {\n    light: { bg: '#e0e8ff', text: '#1e4fa3' },\n    dark: { bg: '#1c3f73', text: '#a8c7ff' },\n  },\n  aistudio: {\n",
        "'gemini-cli':",
    )


def patch_antigravity_quota_builders(target: Path) -> None:
    path = target / 'src/utils/quota/builders.ts'
    insert_once(
        path,
        "\nfunction getAntigravityWindowOrder(bucket: AntigravityQuotaBucket): number {\n",
        "\nfunction getCanonicalAntigravityGroupId(label: string, description?: string): string {\n  const normalizedLabel = toStableId(label, '');\n  const normalizedDescription = description ? toStableId(description, '') : '';\n  const combined = `${normalizedLabel}-${normalizedDescription}`;\n  if (combined.includes('claude') && (combined.includes('gpt') || combined.includes('gpt-oss') || combined.includes('openai'))) {\n    return 'claude-gpt';\n  }\n  if (combined.includes('gemini')) {\n    return 'gemini';\n  }\n  return normalizedLabel;\n}\n\nfunction getAntigravityWindowOrder(bucket: AntigravityQuotaBucket): number {\n",
        "getCanonicalAntigravityGroupId",
    )
    replace_once(
        path,
        "      const groupId = toStableId(label, `quota-group-${groupIndex + 1}`);\n      const buckets = Array.isArray(group.buckets) ? group.buckets : [];\n",
        "      const description = normalizeStringValue(group.description) ?? undefined;\n      const groupId = getCanonicalAntigravityGroupId(label, description) || `quota-group-${groupIndex + 1}`;\n      const buckets = Array.isArray(group.buckets) ? group.buckets : [];\n",
    )
    replace_once(
        path,
        "        description: normalizeStringValue(group.description) ?? undefined,\n",
        "        description,\n",
    )


def patch_quota_styles(target: Path) -> None:
    path = target / 'src/pages/QuotaPage.module.scss'
    replace_once(
        path,
        ".codexGrid,\n.kimiGrid,",
        ".codexGrid,\n.geminiCliGrid,\n.kimiGrid,",
    )
    replace_once(
        path,
        ".codexControls,\n.kimiControls,",
        ".codexControls,\n.geminiCliControls,\n.kimiControls,",
    )
    replace_once(
        path,
        ".codexControl,\n.kimiControl,",
        ".codexControl,\n.geminiCliControl,\n.kimiControl,",
    )
    insert_once(
        path,
        ".kimiCard {\n",
        ".geminiCliCard {\n  background-image: linear-gradient(180deg, rgba(224, 232, 255, 0.2), rgba(224, 232, 255, 0));\n}\n\n.kimiCard {\n",
        ".geminiCliCard",
    )


def patch_auth_files_page_search(target: Path) -> None:
    path = target / 'src/pages/AuthFilesPage.tsx'
    replace_once(
        path,
        "import { useAuthStore, useNotificationStore, useThemeStore } from '@/stores';\n",
        "import { useAuthStore, useNotificationStore, useThemeStore, useQuotaStore } from '@/stores';\n",
    )
    insert_once(
        path,
        "const buildWildcardSearch = (value: string): RegExp | null => {\n"
        "  if (!value.includes('*')) return null;\n"
        "  const pattern = value.split('*').map(escapeWildcardSearchSegment).join('.*');\n"
        "  return new RegExp(pattern, 'i');\n"
        "};\n",
        "const buildWildcardSearch = (value: string): RegExp | null => {\n"
        "  if (!value.includes('*')) return null;\n"
        "  const pattern = value.split('*').map(escapeWildcardSearchSegment).join('.*');\n"
        "  return new RegExp(pattern, 'i');\n"
        "};\n"
        "\n"
        "const AUTH_FILE_SEARCH_FIELD_KEYS = [\n"
        "  'name',\n"
        "  'type',\n"
        "  'provider',\n"
        "  'note',\n"
        "  'remark',\n"
        "  'remarks',\n"
        "  'description',\n"
        "  'plan',\n"
        "  'plan_type',\n"
        "  'planType',\n"
        "  'package',\n"
        "  'package_name',\n"
        "  'packageName',\n"
        "  'subscription',\n"
        "  'subscription_plan',\n"
        "  'subscriptionPlan',\n"
        "  'tier',\n"
        "  'tier_id',\n"
        "  'tierId',\n"
        "  'tier_label',\n"
        "  'tierLabel',\n"
        "  'product',\n"
        "  'product_name',\n"
        "  'productName',\n"
        "  'quota_plan',\n"
        "  'quotaPlan',\n"
        "] as const;\n"
        "\n"
        "const PREMIUM_CODEX_SEARCH_PLAN_TYPES = new Set(['pro', 'prolite', 'pro-lite', 'pro_lite']);\n"
        "const XAI_SUPERGROK_LIMIT_CENTS = 15_000;\n"
        "const XAI_SUPERGROK_HEAVY_LIMIT_CENTS = 150_000;\n"
        "\n"
        "type AuthFileSearchTranslate = (key: string) => string;\n"
        "type AuthFileSearchQuotaStore = Pick<\n"
        "  ReturnType<typeof useQuotaStore.getState>,\n"
        "  'antigravityQuota' | 'claudeQuota' | 'codexQuota' | 'geminiCliQuota' | 'xaiQuota'\n"
        ">;\n"
        "\n"
        "const AUTH_FILE_NESTED_SEARCH_KEY_PATTERN =\n"
        "  /(note|remark|description|desc|plan|package|subscription|tier|product|quota)/i;\n"
        "\n"
        "const addAuthFileSearchValue = (values: string[], value: unknown) => {\n"
        "  if (value == null) return;\n"
        "  if (typeof value === 'string') {\n"
        "    const trimmed = value.trim();\n"
        "    if (trimmed) values.push(trimmed);\n"
        "    return;\n"
        "  }\n"
        "  if (typeof value === 'number' || typeof value === 'boolean') {\n"
        "    values.push(String(value));\n"
        "  }\n"
        "};\n"
        "\n"
        "const toAuthFileSearchRecord = (value: unknown): Record<string, unknown> | null =>\n"
        "  value && typeof value === 'object' && !Array.isArray(value)\n"
        "    ? (value as Record<string, unknown>)\n"
        "    : null;\n"
        "\n"
        "const normalizeAuthFileSearchPlan = (value: unknown): string =>\n"
        "  typeof value === 'string' ? value.trim().toLowerCase().replace(/_/g, '-') : '';\n"
        "\n"
        "const addCodexPlanSearchValues = (\n"
        "  values: string[],\n"
        "  planType: unknown,\n"
        "  t: AuthFileSearchTranslate\n"
        ") => {\n"
        "  const normalized = normalizeAuthFileSearchPlan(planType);\n"
        "  if (!normalized) return;\n"
        "  values.push(normalized, normalized.replace(/-/g, ' '));\n"
        "  if (normalized === 'pro') values.push(t('codex_quota.plan_pro'));\n"
        "  else if (PREMIUM_CODEX_SEARCH_PLAN_TYPES.has(normalized)) values.push(t('codex_quota.plan_prolite'));\n"
        "  else if (normalized === 'plus') values.push(t('codex_quota.plan_plus'));\n"
        "  else if (normalized === 'team') values.push(t('codex_quota.plan_team'));\n"
        "  else if (normalized === 'free') values.push(t('codex_quota.plan_free'));\n"
        "};\n"
        "\n"
        "const addClaudePlanSearchValues = (\n"
        "  values: string[],\n"
        "  planType: unknown,\n"
        "  t: AuthFileSearchTranslate\n"
        ") => {\n"
        "  const raw = typeof planType === 'string' ? planType.trim() : '';\n"
        "  if (!raw) return;\n"
        "  values.push(raw, raw.replace(/^plan[_-]/i, '').replace(/[_-]/g, ' '));\n"
        "  values.push(t(`claude_quota.${raw}`));\n"
        "};\n"
        "\n"
        "const addAntigravityPlanSearchValues = (\n"
        "  values: string[],\n"
        "  subscription: unknown,\n"
        "  t: AuthFileSearchTranslate\n"
        ") => {\n"
        "  const record = toAuthFileSearchRecord(subscription);\n"
        "  if (!record) return;\n"
        "  const plan = normalizeAuthFileSearchPlan(record.plan);\n"
        "  addAuthFileSearchValue(values, record.plan);\n"
        "  addAuthFileSearchValue(values, record.tierName);\n"
        "  addAuthFileSearchValue(values, record.tierId);\n"
        "  if (plan === 'free') values.push(t('antigravity_subscription.plan_free'));\n"
        "  else if (plan === 'pro') values.push(t('antigravity_subscription.plan_pro'));\n"
        "  else if (plan === 'ultra') values.push(t('antigravity_subscription.plan_ultra'));\n"
        "  else if (plan === 'ultra-lite') values.push(t('antigravity_subscription.plan_ultra_lite'));\n"
        "};\n"
        "\n"
        "const normalizeAuthFileSearchCents = (value: unknown): number | null => {\n"
        "  const source = toAuthFileSearchRecord(value)?.val ?? value;\n"
        "  if (typeof source === 'number' && Number.isFinite(source)) return source;\n"
        "  if (typeof source !== 'string') return null;\n"
        "  const parsed = Number(source.trim());\n"
        "  return Number.isFinite(parsed) ? parsed : null;\n"
        "};\n"
        "\n"
        "const addXaiPlanSearchValues = (\n"
        "  values: string[],\n"
        "  billing: unknown,\n"
        "  t: AuthFileSearchTranslate\n"
        ") => {\n"
        "  const record = toAuthFileSearchRecord(billing);\n"
        "  if (!record) return;\n"
        "  const monthlyLimitCents = normalizeAuthFileSearchCents(record.monthlyLimitCents);\n"
        "  if (monthlyLimitCents === XAI_SUPERGROK_LIMIT_CENTS) values.push(t('xai_quota.plan_supergrok'), 'supergrok');\n"
        "  if (monthlyLimitCents === XAI_SUPERGROK_HEAVY_LIMIT_CENTS) values.push(t('xai_quota.plan_supergrok_heavy'), 'supergrok heavy');\n"
        "};\n"
        "\n"
        "const buildAuthFileQuotaSearchValues = (\n"
        "  item: Record<string, unknown>,\n"
        "  quotaStore: AuthFileSearchQuotaStore,\n"
        "  t: AuthFileSearchTranslate\n"
        "): string[] => {\n"
        "  const name = typeof item.name === 'string' ? item.name : '';\n"
        "  if (!name) return [];\n"
        "  const values: string[] = [];\n"
        "  addAntigravityPlanSearchValues(values, quotaStore.antigravityQuota[name]?.subscription, t);\n"
        "  addClaudePlanSearchValues(values, quotaStore.claudeQuota[name]?.planType, t);\n"
        "  addCodexPlanSearchValues(values, quotaStore.codexQuota[name]?.planType, t);\n"
        "  addAuthFileSearchValue(values, quotaStore.geminiCliQuota[name]?.tierLabel);\n"
        "  addAuthFileSearchValue(values, quotaStore.geminiCliQuota[name]?.tierId);\n"
        "  addAuthFileSearchValue(values, quotaStore.geminiCliQuota[name]?.creditBalance);\n"
        "  addXaiPlanSearchValues(values, quotaStore.xaiQuota[name]?.billing, t);\n"
        "  return values;\n"
        "};\n"
        "\n"
        "const collectAuthFileSearchValues = (value: unknown, depth = 0): string[] => {\n"
        "  if (value == null) return [];\n"
        "  if (typeof value === 'string') return value.trim() ? [value] : [];\n"
        "  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];\n"
        "  if (depth >= 2) return [];\n"
        "  if (Array.isArray(value)) {\n"
        "    return value.flatMap((item) => collectAuthFileSearchValues(item, depth + 1));\n"
        "  }\n"
        "  if (typeof value !== 'object') return [];\n"
        "\n"
        "  return Object.entries(value as Record<string, unknown>).flatMap(([key, nestedValue]) =>\n"
        "    AUTH_FILE_NESTED_SEARCH_KEY_PATTERN.test(key)\n"
        "      ? collectAuthFileSearchValues(nestedValue, depth + 1)\n"
        "      : []\n"
        "  );\n"
        "};\n"
        "\n"
        "const buildAuthFileSearchValues = (\n"
        "  item: Record<string, unknown>,\n"
        "  quotaStore: AuthFileSearchQuotaStore,\n"
        "  t: AuthFileSearchTranslate\n"
        "): string[] => [\n"
        "  ...AUTH_FILE_SEARCH_FIELD_KEYS.flatMap((key) => collectAuthFileSearchValues(item[key])),\n"
        "  ...buildAuthFileQuotaSearchValues(item, quotaStore, t),\n"
        "];\n",
        "AUTH_FILE_SEARCH_FIELD_KEYS",
    )
    insert_once(
        path,
        "  const statusBarCache = useAuthFilesStatusBarCache(files);\n",
        "  const statusBarCache = useAuthFilesStatusBarCache(files);\n"
        "\n"
        "  const antigravityQuota = useQuotaStore((state) => state.antigravityQuota);\n"
        "  const claudeQuota = useQuotaStore((state) => state.claudeQuota);\n"
        "  const codexQuota = useQuotaStore((state) => state.codexQuota);\n"
        "  const geminiCliQuota = useQuotaStore((state) => state.geminiCliQuota);\n"
        "  const xaiQuota = useQuotaStore((state) => state.xaiQuota);\n"
        "  const quotaSearchStore = useMemo(\n"
        "    () => ({ antigravityQuota, claudeQuota, codexQuota, geminiCliQuota, xaiQuota }),\n"
        "    [antigravityQuota, claudeQuota, codexQuota, geminiCliQuota, xaiQuota]\n"
        "  );\n",
        "quotaSearchStore",
    )
    replace_once(
        path,
        "        [item.name, item.type, item.provider].some((value) => {\n"
        "          const content = (value || '').toString();\n"
        "          return wildcardSearch\n"
        "            ? wildcardSearch.test(content)\n"
        "            : content.toLowerCase().includes(normalizedTerm);\n"
        "        });\n",
        "        buildAuthFileSearchValues(item, quotaSearchStore, t).some((value) => {\n"
        "          const content = value.toString();\n"
        "          return wildcardSearch\n"
        "            ? wildcardSearch.test(content)\n"
        "            : content.toLowerCase().includes(normalizedTerm);\n"
        "        });\n",
    )
    replace_once(
        path,
        "  }, [filesMatchingStatusFilters, normalizedFilter, normalizedSearch, wildcardSearch]);\n",
        "  }, [filesMatchingStatusFilters, normalizedFilter, normalizedSearch, quotaSearchStore, t, wildcardSearch]);\n",
    )


def patch_supporting_api_and_types(target: Path) -> None:
    config_path = target / 'src/types/config.ts'
    replace_once(
        config_path,
        "export interface Config {\n  debug?: boolean;\n",
        "export interface AuthPoolCleanConfig {\n  baseUrl?: string;\n  token?: string;\n  targetType?: string;\n  workers?: number;\n  deleteWorkers?: number;\n  timeout?: number;\n  retries?: number;\n  usedPercentThreshold?: number;\n  sampleSize?: number;\n}\n\nexport interface Config {\n  debug?: boolean;\n",
    )
    replace_once(
        config_path,
        "  quotaExceeded?: QuotaExceededConfig;\n  requestLog?: boolean;\n",
        "  quotaExceeded?: QuotaExceededConfig;\n  clean?: AuthPoolCleanConfig;\n  usageStatisticsEnabled?: boolean;\n  requestLog?: boolean;\n",
    )
    replace_once(
        config_path,
        "  | 'quota-exceeded'\n  | 'request-log'\n",
        "  | 'quota-exceeded'\n  | 'usage-statistics-enabled'\n  | 'request-log'\n",
    )

    auth_file_type_path = target / 'src/types/authFile.ts'
    replace_once(
        auth_file_type_path,
        "export interface AuthFileItem {\n  name: string;\n",
        "export interface AuthFileLastError {\n  code?: string;\n  message?: string;\n  retryable?: boolean;\n  http_status?: number;\n  httpStatus?: number;\n}\n\nexport interface AuthFileItem {\n  name: string;\n",
    )
    replace_once(
        auth_file_type_path,
        "  statusMessage?: string;\n  lastRefresh?: string | number;\n",
        "  statusMessage?: string;\n  lastError?: AuthFileLastError | null;\n  'last_error'?: AuthFileLastError | null;\n  lastRefresh?: string | number;\n",
    )

    auth_file_constants_path = target / 'src/features/authFiles/constants.ts'
    replace_once(
        auth_file_constants_path,
        "export const getAuthFileStatusMessage = (file: AuthFileItem): string => {\n  const raw = file['status_message'] ?? file.statusMessage;\n  if (typeof raw === 'string') return raw.trim();\n  if (raw == null) return '';\n  return String(raw).trim();\n};\n",
        "const normalizeAuthFileMessageValue = (value: unknown): string => {\n  if (typeof value === 'string') return value.trim();\n  if (value == null) return '';\n  return String(value).trim();\n};\n\nconst getAuthFileLastErrorMessage = (file: AuthFileItem): string => {\n  const raw = file['last_error'] ?? file.lastError;\n  if (!raw || typeof raw !== 'object') return '';\n  return normalizeAuthFileMessageValue((raw as { message?: unknown }).message);\n};\n\nexport const getAuthFileStatusMessage = (file: AuthFileItem): string => {\n  const statusMessage = normalizeAuthFileMessageValue(file['status_message'] ?? file.statusMessage);\n  return statusMessage || getAuthFileLastErrorMessage(file);\n};\n",
    )

    auth_files_path = target / 'src/services/api/authFiles.ts'
    replace_once(
        auth_files_path,
        "type AuthFileStatusResponse = { status: string; disabled: boolean };\n",
        "type AuthFileStatusResponse = { status: string; disabled: boolean };\ntype AuthFilePatchPayload = { name: string; disabled?: boolean; [key: string]: unknown };\n",
    )
    insert_once(
        auth_files_path,
        "export const authFilesApi = {\n",
        "const AUTH_FILES_LIST_CACHE_TTL_MS = 2000;\nlet authFilesListCache: { expiresAt: number; response: AuthFilesResponse } | null = null;\nlet authFilesListRequest: Promise<AuthFilesResponse> | null = null;\nlet authFilesListVersion = 0;\n\nconst cloneAuthFilesResponse = (response: AuthFilesResponse): AuthFilesResponse => ({\n  ...response,\n  files: Array.isArray(response.files) ? [...response.files] : [],\n});\n\nconst invalidateAuthFilesListCache = () => {\n  authFilesListVersion += 1;\n  authFilesListCache = null;\n  authFilesListRequest = null;\n};\n\nconst fetchAuthFilesList = async (): Promise<AuthFilesResponse> => {\n  const now = Date.now();\n  if (authFilesListCache && authFilesListCache.expiresAt > now) {\n    return cloneAuthFilesResponse(authFilesListCache.response);\n  }\n  if (!authFilesListRequest) {\n    const requestVersion = authFilesListVersion;\n    authFilesListRequest = apiClient.get<AuthFilesResponse>('/auth-files')\n      .then(dedupeAuthFilesResponse)\n      .then((response) => {\n        if (requestVersion === authFilesListVersion) {\n          authFilesListCache = {\n            expiresAt: Date.now() + AUTH_FILES_LIST_CACHE_TTL_MS,\n            response: cloneAuthFilesResponse(response),\n          };\n        }\n        return response;\n      })\n      .finally(() => {\n        if (requestVersion === authFilesListVersion) {\n          authFilesListRequest = null;\n        }\n      });\n  }\n  return cloneAuthFilesResponse(await authFilesListRequest);\n};\n\nexport const authFilesApi = {\n",
        "AUTH_FILES_LIST_CACHE_TTL_MS",
    )
    replace_once(
        auth_files_path,
        "  list: async () => dedupeAuthFilesResponse(await apiClient.get<AuthFilesResponse>('/auth-files')),\n\n  setStatus: (name: string, disabled: boolean) =>\n    apiClient.patch<AuthFileStatusResponse>('/auth-files/status', { name, disabled }),\n\n",
        "  list: fetchAuthFilesList,\n\n  patchFile: async (payload: AuthFilePatchPayload) => {\n    const response = await apiClient.patch<AuthFileStatusResponse>('/auth-files', payload);\n    invalidateAuthFilesListCache();\n    return response;\n  },\n\n  setStatus: async (name: string, disabled: boolean) => {\n    const response = await apiClient.patch<AuthFileStatusResponse>('/auth-files/status', { name, disabled });\n    invalidateAuthFilesListCache();\n    return response;\n  },\n",
    )
    replace_once(
        auth_files_path,
        "  patchFields: (name: string, fields: AuthFileFieldsPatch) =>\n    apiClient.patch('/auth-files/fields', { name, ...fields }),\n\n",
        "  setStatusWithFallback: async (name: string, disabled: boolean) => {\n    try {\n      return await authFilesApi.patchFile({ name, disabled });\n    } catch {\n      return authFilesApi.setStatus(name, disabled);\n    }\n  },\n\n  patchFields: async (name: string, fields: AuthFileFieldsPatch) => {\n    const response = await apiClient.patch('/auth-files/fields', { name, ...fields });\n    invalidateAuthFilesListCache();\n    return response;\n  },\n\n",
    )
    replace_once(
        auth_files_path,
        "    const payload = await apiClient.postForm<AuthFileBatchUploadResponse>('/auth-files', formData);\n    return normalizeBatchUploadResponse(payload, requestedNames);\n",
        "    const payload = await apiClient.postForm<AuthFileBatchUploadResponse>('/auth-files', formData);\n    invalidateAuthFilesListCache();\n    return normalizeBatchUploadResponse(payload, requestedNames);\n",
    )
    replace_once(
        auth_files_path,
        "    const payload = await apiClient.delete<AuthFileBatchDeleteResponse>('/auth-files', {\n      data: { names: requestedNames },\n    });\n    return normalizeBatchDeleteResponse(payload, requestedNames);\n",
        "    const payload = await apiClient.delete<AuthFileBatchDeleteResponse>('/auth-files', {\n      data: { names: requestedNames },\n    });\n    invalidateAuthFilesListCache();\n    return normalizeBatchDeleteResponse(payload, requestedNames);\n",
    )
    replace_once(
        auth_files_path,
        "  deleteAll: () => apiClient.delete('/auth-files', { params: { all: true } }),\n",
        "  deleteAll: async () => {\n    const response = await apiClient.delete('/auth-files', { params: { all: true } });\n    invalidateAuthFilesListCache();\n    return response;\n  },\n",
    )

    api_index_path = target / 'src/services/api/index.ts'
    replace_once(
        api_index_path,
        "export * from './apiCall';\n",
        "export * from './apiCall';\nexport * from './accountInspection';\n",
    )

    format_path = target / 'src/utils/format.ts'
    insert_once(
        format_path,
        "/**\n * 格式化文件大小\n */",
        "const API_KEY_MASK_REGEX =\n  /(sk-[A-Za-z0-9-_]{6,}|sk-ant-[A-Za-z0-9-_]{6,}|AIza[0-9A-Za-z-_]{8,}|AI[a-zA-Z0-9_-]{6,}|hf_[A-Za-z0-9]{6,}|pk_[A-Za-z0-9]{6,}|rk_[A-Za-z0-9]{6,})/g;\n\nexport function maskSensitiveText(value: string): string {\n  const trimmed = String(value || '').trim();\n  if (!trimmed) {\n    return '';\n  }\n\n  return trimmed.replace(API_KEY_MASK_REGEX, (match) => maskApiKey(match));\n}\n\n/**\n * 格式化文件大小\n */",
        "export function maskSensitiveText(value: string): string",
    )

    select_path = target / 'src/components/ui/Select.tsx'
    if 'triggerClassName?: string;' not in read(select_path):
        replace_once(
            select_path,
            "  placeholder?: string;\n  className?: string;\n  disabled?: boolean;\n",
            "  placeholder?: string;\n  className?: string;\n  triggerClassName?: string;\n  dropdownClassName?: string;\n  disabled?: boolean;\n",
        )
    if 'triggerClassName,' not in read(select_path):
        replace_once(
            select_path,
            "  placeholder,\n  className,\n  disabled = false,\n",
            "  placeholder,\n  className,\n  triggerClassName,\n  dropdownClassName,\n  disabled = false,\n",
        )
    if 'dropdownClassName].filter(Boolean).join' not in read(select_path):
        text = read(select_path)
        dropdown_class_replacements = [
            (
                "            className={styles.dropdown}\n",
                "            className={[styles.dropdown, dropdownClassName].filter(Boolean).join(' ')}\n",
            ),
            (
                "        className={styles.dropdown}\n",
                "        className={[styles.dropdown, dropdownClassName].filter(Boolean).join(' ')}\n",
            ),
        ]
        for old, new in dropdown_class_replacements:
            if old in text:
                write(select_path, text.replace(old, new, 1))
                break
        else:
            raise RuntimeError(f'Pattern not found in {select_path}: Select dropdown className')
    if 'triggerClassName].filter(Boolean).join' not in read(select_path):
        text = read(select_path)
        old_simple = "          className={styles.trigger}\n"
        old_sized = "          className={`${styles.trigger} ${size === 'sm' ? styles.triggerSm : ''}`.trim()}\n"
        if old_simple in text:
            write(
                select_path,
                text.replace(
                    old_simple,
                    "          className={[styles.trigger, triggerClassName].filter(Boolean).join(' ')}\n",
                    1,
                ),
            )
        elif old_sized in text:
            write(
                select_path,
                text.replace(
                    old_sized,
                    "          className={[styles.trigger, size === 'sm' ? styles.triggerSm : '', triggerClassName].filter(Boolean).join(' ')}\n",
                    1,
                ),
            )
        else:
            raise RuntimeError(f'Pattern not found in {select_path}: Select trigger className')


def patch_locales(target: Path) -> None:
    monitoring = json.loads(LOCALES_FILE.read_text())
    locales_dir = target / 'src/i18n/locales'
    for locale_path in sorted(locales_dir.glob('*.json')):
        data = json.loads(locale_path.read_text())
        additions = monitoring.get(locale_path.name, {})
        data.setdefault('nav', {}).update(additions.get('nav', {}))
        nav_additions = additions.get('nav', {})
        data.setdefault('nav_meta', {}).update(
            additions.get(
                'nav_meta',
                {
                    'monitoring_center': nav_additions.get('monitoring_center', 'Request Monitoring'),
                    'account_inspection': nav_additions.get('account_inspection', 'Account Inspection'),
                },
            )
        )
        data['monitoring'] = additions.get('monitoring', data.get('monitoring', {}))
        data['usage_stats'] = additions.get('usage_stats', data.get('usage_stats', {}))
        data.setdefault('quota_management', {}).update(QUOTA_LOCALE_KEYS.get(locale_path.name, {}))
        gemini_cli_locale = GEMINI_CLI_LOCALE_KEYS.get(locale_path.name, GEMINI_CLI_LOCALE_KEYS['en.json'])
        data.setdefault('auth_files', {})['filter_gemini-cli'] = gemini_cli_locale['auth_filter']
        data.setdefault('auth_files', {})['search_placeholder'] = AUTH_FILES_SEARCH_PLACEHOLDER_KEYS.get(
            locale_path.name,
            AUTH_FILES_SEARCH_PLACEHOLDER_KEYS['en.json'],
        )
        data.setdefault('gemini_cli_quota', {}).update(gemini_cli_locale['quota'])
        locale_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')


def main() -> None:
    if len(sys.argv) > 2:
        raise SystemExit('Usage: apply_customizations.py [target_dir]')
    target = Path(sys.argv[1] if len(sys.argv) == 2 else '.').resolve()
    if not (target / 'src').is_dir() or not (target / 'package.json').is_file():
        raise SystemExit(f'Target directory does not look like the upstream project: {target}')
    if not OVERLAY_DIR.is_dir():
        raise SystemExit(f'Overlay directory not found: {OVERLAY_DIR}')

    copy_overlay(target)
    patch_routes(target)
    patch_layout(target)
    patch_icons(target)
    patch_quota_types(target)
    patch_quota_store(target)
    patch_quota_constants(target)
    patch_quota_configs(target)
    patch_antigravity_quota_builders(target)
    patch_quota_page(target)
    patch_quota_card(target)
    patch_quota_styles(target)
    patch_auth_files_page_search(target)
    patch_supporting_api_and_types(target)
    patch_locales(target)
    flush_writes()
    print(f'OK: CPA-Management customization applied to {target}')


if __name__ == '__main__':
    main()
