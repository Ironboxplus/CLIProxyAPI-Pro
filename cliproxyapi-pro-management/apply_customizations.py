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
        'refresh_single': 'Refresh this quota',
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
        'refresh_single': 'Обновить эту квоту',
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
        'refresh_single': '刷新此配额',
        'cached_at': '更新于',
        'just_now': '刚刚',
        'minutes_ago': '{{count}} 分钟前',
        'hours_ago': '{{count}} 小时前',
        'days_ago': '{{count}} 天前',
    },
    'zh-TW.json': {
        'refresh_single': '重新整理此配額',
        'cached_at': '更新於',
        'just_now': '剛剛',
        'minutes_ago': '{{count}} 分鐘前',
        'hours_ago': '{{count}} 小時前',
        'days_ago': '{{count}} 天前',
    },
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
    for old, new in [
        ("  errorStatus?: number;\n}\n\n// Quota state types", "  errorStatus?: number;\n  cachedAt?: number;\n}\n\n// Quota state types"),
        ("  errorStatus?: number;\n}\n\nexport interface GeminiCliQuotaBucketState", "  errorStatus?: number;\n  cachedAt?: number;\n}\n\nexport interface GeminiCliQuotaBucketState"),
        ("  errorStatus?: number;\n}\n\nexport interface CodexQuotaWindow", "  errorStatus?: number;\n  cachedAt?: number;\n}\n\nexport interface CodexQuotaWindow"),
        ("  errorStatus?: number;\n}\n\n// Kimi API payload types", "  errorStatus?: number;\n  cachedAt?: number;\n}\n\n// Kimi API payload types"),
        ("  errorStatus?: number;\n}\n", "  errorStatus?: number;\n  cachedAt?: number;\n}\n"),
    ]:
        replace_once(path, old, new)


def patch_quota_configs(target: Path) -> None:
    path = target / 'src/components/quota/quotaConfigs.ts'
    for old, new in [
        ("    extraUsage: data.extraUsage,\n    planType: data.planType,\n  }),", "    extraUsage: data.extraUsage,\n    planType: data.planType,\n    cachedAt: Date.now(),\n  }),"),
        ("  buildSuccessState: (groups) => ({ status: 'success', groups }),", "  buildSuccessState: (groups) => ({ status: 'success', groups, cachedAt: Date.now() }),"),
        ("    windows: data.windows,\n    planType: data.planType,\n  }),", "    windows: data.windows,\n    planType: data.planType,\n    cachedAt: Date.now(),\n  }),"),
        ("      creditBalance: supplementarySnapshot.creditBalance ?? data.creditBalance,\n    };", "      creditBalance: supplementarySnapshot.creditBalance ?? data.creditBalance,\n      cachedAt: Date.now(),\n    };"),
        ("  buildSuccessState: (rows) => ({ status: 'success', rows }),", "  buildSuccessState: (rows) => ({ status: 'success', rows, cachedAt: Date.now() }),"),
    ]:
        replace_once(path, old, new)


def patch_quota_page(target: Path) -> None:
    path = target / 'src/pages/QuotaPage.tsx'
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
        "  useEffect(() => {\n    loadFiles();\n    loadConfig();\n  }, [loadFiles, loadConfig]);\n",
        "  useEffect(() => {\n    loadFiles();\n    loadConfig();\n    void quotaPersistenceMiddleware.ensureFresh();\n  }, [loadFiles, loadConfig]);\n",
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
        "import { QuotaCachedTime, QuotaCardHeaderAction } from '@/extensions/quota/QuotaCardExtras';\nimport { TYPE_COLORS } from '@/utils/quota';\n",
    )
    replace_once(path, "  errorStatus?: number;\n}", "  errorStatus?: number;\n  cachedAt?: number;\n}")
    replace_once(
        path,
        "        <span className={styles.fileName}>{item.name}</span>\n      </div>",
        "        <span className={styles.fileName}>{item.name}</span>\n        <QuotaCardHeaderAction quotaStatus={quotaStatus} canRefresh={canRefresh} onRefresh={onRefresh} />\n      </div>",
    )
    replace_once(
        path,
        "        ) : quota ? (\n          renderQuotaItems(quota, t, { styles, QuotaProgressBar })\n        ) : (",
        "        ) : quota ? (\n          <>\n            {renderQuotaItems(quota, t, { styles, QuotaProgressBar })}\n            <QuotaCachedTime quotaStatus={quotaStatus} cachedAt={quota.cachedAt} />\n          </>\n        ) : (",
    )


def patch_quota_styles(target: Path) -> None:
    return


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
    replace_once(
        auth_files_path,
        "  list: async () => dedupeAuthFilesResponse(await apiClient.get<AuthFilesResponse>('/auth-files')),\n\n  setStatus: (name: string, disabled: boolean) =>\n",
        "  list: async () => dedupeAuthFilesResponse(await apiClient.get<AuthFilesResponse>('/auth-files')),\n\n  patchFile: (payload: AuthFilePatchPayload) =>\n    apiClient.patch<AuthFileStatusResponse>('/auth-files', payload),\n\n  setStatus: (name: string, disabled: boolean) =>\n",
    )
    replace_once(
        auth_files_path,
        "  setStatus: (name: string, disabled: boolean) =>\n    apiClient.patch<AuthFileStatusResponse>('/auth-files/status', { name, disabled }),\n\n  patchFields:",
        "  setStatus: (name: string, disabled: boolean) =>\n    apiClient.patch<AuthFileStatusResponse>('/auth-files/status', { name, disabled }),\n\n  setStatusWithFallback: async (name: string, disabled: boolean) => {\n    try {\n      return await authFilesApi.patchFile({ name, disabled });\n    } catch {\n      return authFilesApi.setStatus(name, disabled);\n    }\n  },\n\n  patchFields:",
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
        replace_once(
            select_path,
            "            className={styles.dropdown}\n",
            "            className={[styles.dropdown, dropdownClassName].filter(Boolean).join(' ')}\n",
        )
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
    patch_quota_configs(target)
    patch_quota_page(target)
    patch_quota_card(target)
    patch_supporting_api_and_types(target)
    patch_locales(target)
    flush_writes()
    print(f'OK: CPA-Management customization applied to {target}')


if __name__ == '__main__':
    main()
