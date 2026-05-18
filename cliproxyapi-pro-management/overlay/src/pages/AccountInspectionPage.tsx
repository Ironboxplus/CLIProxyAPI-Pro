import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  IconChevronDown,
  IconChevronUp,
} from '@/components/ui/icons';
import { getAuthFileIcon } from '@/features/authFiles/constants';
import {
  ACCOUNT_INSPECTION_ALL_PROVIDER_TYPE,
  ACCOUNT_INSPECTION_SUPPORTED_PROVIDERS,
  ACCOUNT_INSPECTION_SETTING_LIMITS,
  applyAccountInspectionExecutionResult,
  buildAccountInspectionBackendViewState,
  buildExecutionFailureMessage,
  clearAccountInspectionConfigurableSettings,
  createIdleAccountInspectionProgressSnapshot,
  DEFAULT_ACCOUNT_INSPECTION_SETTINGS,
  hasAccountInspectionAutoExecutePolicies,
  isSuggestedAction,
  loadAccountInspectionConfigurableSettings,
  saveAccountInspectionConfigurableSettings,
  type AccountInspectionAction,
  type AccountInspectionAutoErrorAction,
  type AccountInspectionConfigurableSettings,
  type AccountInspectionExecutionResult,
  type AccountInspectionLogLevel,
  type AccountInspectionProgressSnapshot,
  type AccountInspectionResultItem,
  type AccountInspectionRunResult,
} from '@/features/monitoring/accountInspection';
import {
  accountInspectionApi,
  accountInspectionWebSocketProtocol,
  apiClient,
  buildAccountInspectionLogsWebSocketUrl,
  type AccountInspectionLogStreamMessage,
  type AccountInspectionScheduleResponse,
} from '@/services/api';
import { quotaPersistenceMiddleware } from '@/extensions/quota/persistenceMiddleware';
import { useAuthStore, useConfigStore, useNotificationStore, useQuotaStore } from '@/stores';
import type { AuthFileItem, AuthFilesResponse } from '@/types';
import { isDisabledAuthFile, isQuotaLowState, readBooleanValue, resolveAuthProvider } from '@/utils/quota';
import { resolveProviderDisplayLabel } from '@/utils/sourceResolver';
import styles from './AccountInspectionPage.module.scss';

type RunStatus = 'idle' | 'running' | 'paused' | 'success' | 'error';

type ResultHealthStatus = 'healthy' | 'disabled' | 'authInvalid' | 'quotaExhausted' | 'inspectionError' | 'recoverable' | 'processed';

type ResultFilter = 'all' | 'pending' | 'authInvalid' | 'quotaExhausted' | 'inspectionError' | 'recoverable' | 'processed';

type ManualAccountInspectionAction = Exclude<AccountInspectionAction, 'keep'>;

type QuotaAccountStatsState = Pick<
  ReturnType<typeof useQuotaStore.getState>,
  'antigravityQuota' | 'claudeQuota' | 'codexQuota' | 'geminiCliQuota' | 'kimiQuota'
>;

type HealthCounts = {
  total: number;
  healthy: number;
  disabled: number;
  authInvalid: number;
  quotaExhausted: number;
  inspectionError: number;
  recoverable: number;
};

type InspectionLogEntry = {
  id: string;
  level: AccountInspectionLogLevel;
  message: string;
  timestamp: number;
};

type SummaryCard = {
  key: string;
  label: string;
  value: string;
  description?: string;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
};

type InspectionSettingsDraft = {
  targetType: string;
  workers: string;
  deleteWorkers: string;
  timeout: string;
  retries: string;
  usedPercentThreshold: string;
  sampleSize: string;
  autoExecuteQuotaLimitDisable: boolean;
  autoExecuteQuotaRecoveryEnable: boolean;
  autoExecuteAccountErrorAction: AccountInspectionAutoErrorAction;
};

type InspectionSettingsDraftField = Exclude<
  keyof InspectionSettingsDraft,
  'autoExecuteQuotaLimitDisable' | 'autoExecuteQuotaRecoveryEnable' | 'autoExecuteAccountErrorAction'
>;

type ScheduleDraft = {
  enabled: boolean;
  intervalMinutes: string;
};

type ProviderAccountStats = {
  provider: string;
  total: number;
  enabled: number;
  highAvailable: number;
  disabled: number;
  quotaLow: number;
  abnormal: number;
};

type ResolvedTheme = 'light' | 'dark';

type AuthFileAccountStats = {
  total: number;
  providerCount: number;
  enabled: number;
  highAvailable: number;
  disabled: number;
  quotaLow: number;
  abnormal: number;
  providers: ProviderAccountStats[];
};

type AutoExecutionCounts = {
  delete: number;
  disable: number;
  enable: number;
};

type AuthFileExportEntry = {
  name: string;
  content: string;
};


type ZipFileEntry = {
  path: string;
  data: Uint8Array;
  compressedData: Uint8Array;
  compressionMethod: 0 | 8;
  crc32: number;
};

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

const ACCOUNT_INSPECTION_LOG_LIMIT = 200;

const appendInspectionLogEntry = (entries: InspectionLogEntry[], entry: InspectionLogEntry) =>
  [...entries, entry].slice(-ACCOUNT_INSPECTION_LOG_LIMIT);

const getProviderInitial = (label: string) => label.trim().charAt(0).toUpperCase() || '?';

const getDocumentTheme = (): ResolvedTheme => {
  if (typeof document === 'undefined') return 'light';
  const root = document.documentElement;
  const theme = root.dataset.theme || root.getAttribute('data-theme') || root.className;
  return String(theme).toLowerCase().includes('dark') ? 'dark' : 'light';
};

const emptyAutoExecutionCounts = (): AutoExecutionCounts => ({
  delete: 0,
  disable: 0,
  enable: 0,
});

const getCrc32 = (data: Uint8Array) => {
  let crc = 0xffffffff;
  data.forEach((byte) => {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  });
  return (crc ^ 0xffffffff) >>> 0;
};

const getDosTimestamp = (date: Date) => {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
};

const writeUint16 = (view: DataView, offset: number, value: number) => {
  view.setUint16(offset, value, true);
};

const writeUint32 = (view: DataView, offset: number, value: number) => {
  view.setUint32(offset, value >>> 0, true);
};

const concatUint8Arrays = (parts: Uint8Array[]) => {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  parts.forEach((part) => {
    output.set(part, offset);
    offset += part.length;
  });
  return output;
};

const sanitizeZipPathSegment = (value: string) =>
  value
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/^\.+$/, '_')
    .trim() || 'unknown';

const getAuthFileZipPath = (entry: AuthFileExportEntry, usedPaths: Set<string>) => {
  const rawName = sanitizeZipPathSegment(entry.name);
  const baseName = rawName.toLowerCase().endsWith('.json') ? rawName : `${rawName}.json`;
  let path = baseName;
  let index = 2;

  while (usedPaths.has(path)) {
    const dotIndex = baseName.toLowerCase().lastIndexOf('.json');
    const stem = dotIndex >= 0 ? baseName.slice(0, dotIndex) : baseName;
    path = `${stem}-${index}.json`;
    index += 1;
  }

  usedPaths.add(path);
  return path;
};

const toArrayBuffer = (data: Uint8Array) => {
  const arrayBuffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(arrayBuffer).set(data);
  return arrayBuffer;
};

const compressZipData = async (data: Uint8Array): Promise<{ data: Uint8Array; method: 0 | 8 }> => {
  const CompressionStreamCtor = (globalThis as typeof globalThis & {
    CompressionStream?: new (format: 'deflate-raw') => TransformStream<Uint8Array, Uint8Array>;
  }).CompressionStream;

  if (!CompressionStreamCtor) {
    return { data, method: 0 };
  }

  try {
    const stream = new Blob([toArrayBuffer(data)]).stream().pipeThrough(new CompressionStreamCtor('deflate-raw'));
    return { data: new Uint8Array(await new Response(stream).arrayBuffer()), method: 8 };
  } catch {
    return { data, method: 0 };
  }
};

const buildZipArchive = async (entries: AuthFileExportEntry[]) => {
  const encoder = new TextEncoder();
  const usedPaths = new Set<string>();
  const files: ZipFileEntry[] = await Promise.all(
    entries.map(async (entry) => {
      const path = getAuthFileZipPath(entry, usedPaths);
      const data = encoder.encode(entry.content);
      const compressed = await compressZipData(data);
      return {
        path,
        data,
        compressedData: compressed.data,
        compressionMethod: compressed.method,
        crc32: getCrc32(data),
      };
    })
  );
  const timestamp = getDosTimestamp(new Date());
  const parts: Uint8Array[] = [];
  const centralDirectoryParts: Uint8Array[] = [];
  let offset = 0;

  files.forEach((file) => {
    const fileName = encoder.encode(file.path);
    const localHeader = new Uint8Array(30 + fileName.length);
    const localView = new DataView(localHeader.buffer);

    writeUint32(localView, 0, 0x04034b50);
    writeUint16(localView, 4, 20);
    writeUint16(localView, 6, 0x0800);
    writeUint16(localView, 8, file.compressionMethod);
    writeUint16(localView, 10, timestamp.time);
    writeUint16(localView, 12, timestamp.date);
    writeUint32(localView, 14, file.crc32);
    writeUint32(localView, 18, file.compressedData.length);
    writeUint32(localView, 22, file.data.length);
    writeUint16(localView, 26, fileName.length);
    localHeader.set(fileName, 30);

    parts.push(localHeader, file.compressedData);

    const centralDirectoryHeader = new Uint8Array(46 + fileName.length);
    const centralView = new DataView(centralDirectoryHeader.buffer);

    writeUint32(centralView, 0, 0x02014b50);
    writeUint16(centralView, 4, 20);
    writeUint16(centralView, 6, 20);
    writeUint16(centralView, 8, 0x0800);
    writeUint16(centralView, 10, file.compressionMethod);
    writeUint16(centralView, 12, timestamp.time);
    writeUint16(centralView, 14, timestamp.date);
    writeUint32(centralView, 16, file.crc32);
    writeUint32(centralView, 20, file.compressedData.length);
    writeUint32(centralView, 24, file.data.length);
    writeUint16(centralView, 28, fileName.length);
    writeUint32(centralView, 42, offset);
    centralDirectoryHeader.set(fileName, 46);

    centralDirectoryParts.push(centralDirectoryHeader);
    offset += localHeader.length + file.compressedData.length;
  });

  const centralDirectory = concatUint8Arrays(centralDirectoryParts);
  const endOfCentralDirectory = new Uint8Array(22);
  const endView = new DataView(endOfCentralDirectory.buffer);
  writeUint32(endView, 0, 0x06054b50);
  writeUint16(endView, 8, files.length);
  writeUint16(endView, 10, files.length);
  writeUint32(endView, 12, centralDirectory.length);
  writeUint32(endView, 16, offset);

  return new Blob(
    [...parts, centralDirectory, endOfCentralDirectory].map(toArrayBuffer),
    { type: 'application/zip' }
  );
};

const downloadBlobFile = (fileName: string, blob: Blob) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

const actionToneClass: Record<AccountInspectionAction, string> = {
  keep: styles.actionKeep,
  delete: styles.actionDelete,
  disable: styles.actionDisable,
  enable: styles.actionEnable,
};

const levelClassMap: Record<AccountInspectionLogLevel, string> = {
  info: styles.logInfo,
  success: styles.logSuccess,
  warning: styles.logWarning,
  error: styles.logError,
};

const healthToneClass: Record<ResultHealthStatus, string> = {
  healthy: styles.healthHealthy,
  disabled: styles.healthDisabled,
  authInvalid: styles.healthAuthInvalid,
  quotaExhausted: styles.healthQuota,
  inspectionError: styles.healthError,
  recoverable: styles.healthRecoverable,
  processed: styles.healthProcessed,
};

const healthLabelKey: Record<ResultHealthStatus, string> = {
  healthy: 'monitoring.account_inspection_health_healthy',
  disabled: 'monitoring.account_inspection_health_disabled',
  authInvalid: 'monitoring.account_inspection_health_auth_invalid',
  quotaExhausted: 'monitoring.account_inspection_health_quota_exhausted',
  inspectionError: 'monitoring.account_inspection_health_inspection_error',
  recoverable: 'monitoring.account_inspection_health_recoverable',
  processed: 'monitoring.account_inspection_health_processed',
};

const resolveResultHealthStatus = (item: AccountInspectionResultItem): ResultHealthStatus => {
  if (item.executed) return 'processed';
  if (item.error) return 'inspectionError';
  if (item.action === 'delete' || (item.statusCode !== null && [400, 401, 403, 404].includes(item.statusCode))) {
    return 'authInvalid';
  }
  if (item.isQuota || item.action === 'disable') return 'quotaExhausted';
  if (item.action === 'enable') return 'recoverable';
  if (item.disabled) return 'disabled';
  return 'healthy';
};

const readAuthFileStatusMessage = (file: AuthFileItem) => {
  const raw = file['status_message'] ?? file.statusMessage;
  if (raw === undefined || raw === null) return '';
  return String(raw).trim();
};

const hasAuthFileLastError = (file: AuthFileItem) => {
  const raw = file['last_error'] ?? file.lastError;
  if (!raw) return false;
  if (typeof raw === 'string') return raw.trim().length > 0;
  return true;
};

const isAuthFileAbnormal = (file: AuthFileItem) => {
  if (readBooleanValue(file.unavailable ?? file['unavailable'])) return true;
  if (hasAuthFileLastError(file)) return true;
  const status = String(file.status ?? file.state ?? '').trim().toLowerCase();
  if (status && !['active', 'disabled', 'pending', 'refreshing'].includes(status)) return true;
  return readAuthFileStatusMessage(file).length > 0;
};

const incrementProviderStats = (stats: ProviderAccountStats, disabled: boolean, quotaLow: boolean, abnormal: boolean) => {
  stats.total += 1;
  if (disabled) {
    stats.disabled += 1;
  } else {
    stats.enabled += 1;
  }
  if (!disabled && !quotaLow && !abnormal) stats.highAvailable += 1;
  if (quotaLow) stats.quotaLow += 1;
  if (abnormal) stats.abnormal += 1;
};

const emptyProviderAccountStats = (provider: string): ProviderAccountStats => ({
  provider,
  total: 0,
  enabled: 0,
  highAvailable: 0,
  disabled: 0,
  quotaLow: 0,
  abnormal: 0,
});

const buildAuthFileAccountStats = (
  files: AuthFileItem[],
  quotaStore: QuotaAccountStatsState
): AuthFileAccountStats => {
  const providerStats = new Map<string, ProviderAccountStats>();
  const stats: AuthFileAccountStats = {
    total: files.length,
    providerCount: 0,
    enabled: 0,
    highAvailable: 0,
    disabled: 0,
    quotaLow: 0,
    abnormal: 0,
    providers: [],
  };

  files.forEach((file) => {
    const provider = resolveAuthProvider(file) || 'unknown';
    const disabled = isDisabledAuthFile(file);
    const abnormal = isAuthFileAbnormal(file);
    const quotaLow =
      isQuotaLowState(quotaStore.antigravityQuota[file.name]) ||
      isQuotaLowState(quotaStore.claudeQuota[file.name]) ||
      isQuotaLowState(quotaStore.codexQuota[file.name]) ||
      isQuotaLowState(quotaStore.geminiCliQuota[file.name]) ||
      isQuotaLowState(quotaStore.kimiQuota[file.name]);

    if (disabled) {
      stats.disabled += 1;
    } else {
      stats.enabled += 1;
    }
    if (!disabled && !quotaLow && !abnormal) stats.highAvailable += 1;
    if (abnormal) stats.abnormal += 1;
    if (quotaLow) stats.quotaLow += 1;

    const providerEntry = providerStats.get(provider) ?? emptyProviderAccountStats(provider);
    incrementProviderStats(providerEntry, disabled, quotaLow, abnormal);
    providerStats.set(provider, providerEntry);
  });

  stats.providers = [...providerStats.values()].sort((left, right) => right.total - left.total || left.provider.localeCompare(right.provider));
  stats.providerCount = stats.providers.length;
  return stats;
};

const emptyHealthCounts = (): HealthCounts => ({
  total: 0,
  healthy: 0,
  disabled: 0,
  authInvalid: 0,
  quotaExhausted: 0,
  inspectionError: 0,
  recoverable: 0,
});

const countHealthStatuses = (items: AccountInspectionResultItem[]): HealthCounts => {
  const counts = emptyHealthCounts();
  counts.total = items.length;
  items.forEach((item) => {
    switch (resolveResultHealthStatus(item)) {
      case 'healthy':
      case 'processed':
        counts.healthy += 1;
        break;
      case 'disabled':
        counts.disabled += 1;
        break;
      case 'authInvalid':
        counts.authInvalid += 1;
        break;
      case 'quotaExhausted':
        counts.quotaExhausted += 1;
        break;
      case 'inspectionError':
        counts.inspectionError += 1;
        break;
      case 'recoverable':
        counts.recoverable += 1;
        break;
    }
  });
  return counts;
};

const buildManualActionItem = (
  item: AccountInspectionResultItem,
  action: ManualAccountInspectionAction
): AccountInspectionResultItem => ({
  ...item,
  action,
  actionReason: item.actionReason || action,
});

const getManualActions = (item: AccountInspectionResultItem): ManualAccountInspectionAction[] => {
  const healthStatus = resolveResultHealthStatus(item);
  if (healthStatus === 'healthy' || healthStatus === 'processed') return [];
  return [item.disabled ? 'enable' : 'disable', 'delete'];
};

const summaryToneClass: Record<NonNullable<SummaryCard['tone']>, string> = {
  neutral: '',
  good: styles.summaryGood,
  warn: styles.summaryWarn,
  bad: styles.summaryBad,
};

const INSPECTION_TARGET_OPTIONS = [
  { value: ACCOUNT_INSPECTION_ALL_PROVIDER_TYPE, label: 'All' },
  ...ACCOUNT_INSPECTION_SUPPORTED_PROVIDERS.map((provider) => ({
    value: provider,
    label: resolveProviderDisplayLabel(provider),
  })),
] as const;

const AUTO_ERROR_ACTION_OPTIONS: Array<{ value: AccountInspectionAutoErrorAction; labelKey: string }> = [
  { value: 'none', labelKey: 'monitoring.account_inspection_settings_account_error_action_none' },
  { value: 'disable', labelKey: 'monitoring.account_inspection_settings_account_error_action_disable' },
  { value: 'delete', labelKey: 'monitoring.account_inspection_settings_account_error_action_delete' },
];

const {
  workers: WORKER_LIMITS,
  deleteWorkers: DELETE_WORKER_LIMITS,
  timeout: TIMEOUT_LIMITS,
  retries: RETRY_LIMITS,
  usedPercentThreshold: THRESHOLD_LIMITS,
  sampleSize: SAMPLE_SIZE_LIMITS,
  scheduleIntervalMinutes: SCHEDULE_INTERVAL_LIMITS,
} = ACCOUNT_INSPECTION_SETTING_LIMITS;

const formatTimestamp = (value: number, locale: string) => new Date(value).toLocaleString(locale);

const formatInspectionInterval = (minutes: number, locale: string) =>
  new Intl.NumberFormat(locale, { style: 'unit', unit: 'minute', unitDisplay: 'short' }).format(minutes);

const DONUT_COLORS = ['#2563eb', '#22c55e', '#f97316', '#8b5cf6', '#06b6d4', '#ec4899'];

const formatPercent = (value: number | null) => (value === null ? '--' : `${value.toFixed(1)}%`);

const toSettingsDraft = (settings: AccountInspectionConfigurableSettings): InspectionSettingsDraft => ({
  targetType: settings.targetType,
  workers: String(settings.workers),
  deleteWorkers: String(settings.deleteWorkers),
  timeout: String(settings.timeout),
  retries: String(settings.retries),
  usedPercentThreshold: String(settings.usedPercentThreshold),
  sampleSize: String(settings.sampleSize),
  autoExecuteQuotaLimitDisable: settings.autoExecuteQuotaLimitDisable,
  autoExecuteQuotaRecoveryEnable: settings.autoExecuteQuotaRecoveryEnable,
  autoExecuteAccountErrorAction: settings.autoExecuteAccountErrorAction,
});

const formatActionLabel = (action: AccountInspectionAction, t: ReturnType<typeof useTranslation>['t']) => {
  switch (action) {
    case 'delete':
      return t('monitoring.account_inspection_action_delete');
    case 'disable':
      return t('monitoring.account_inspection_action_disable');
    case 'enable':
      return t('monitoring.account_inspection_action_enable');
    case 'keep':
    default:
      return t('monitoring.account_inspection_action_keep');
  }
};

const formatCurrentStateLabel = (item: AccountInspectionResultItem, t: ReturnType<typeof useTranslation>['t']) => {
  if (item.disabled) return t('monitoring.account_inspection_state_disabled');
  return t('monitoring.account_inspection_state_enabled');
};

const formatRunInspectionButtonLabel = (status: RunStatus, t: ReturnType<typeof useTranslation>['t']) => {
  if (status === 'paused') return t('monitoring.account_inspection_resume');
  if (status === 'running') return t('monitoring.account_inspection_running');
  return t('monitoring.account_inspection_run');
};

const countActions = (items: AccountInspectionResultItem[]) => {
  const summary = {
    delete: 0,
    disable: 0,
    enable: 0,
  };

  items.forEach((item) => {
    if (item.action === 'delete') summary.delete += 1;
    if (item.action === 'disable') summary.disable += 1;
    if (item.action === 'enable') summary.enable += 1;
  });

  return summary;
};

const buildActionRiskPreview = (items: AccountInspectionResultItem[], t: ReturnType<typeof useTranslation>['t']) =>
  items
    .filter((item) => item.action === 'delete' || item.action === 'disable')
    .slice(0, 5)
    .map((item) => ({
      key: item.key,
      account: item.fileName,
      provider: item.provider,
      action: formatActionLabel(item.action, t),
      reason: item.actionReason || item.error || '-',
      dangerous: item.action === 'delete',
    }));

const buildExecuteConfirmationMessage = (
  items: AccountInspectionResultItem[],
  t: ReturnType<typeof useTranslation>['t'],
  hasAutoExecutePolicy: boolean
) => {
  const counts = countActions(items);
  const preview = buildActionRiskPreview(items, t);
  const hasDelete = counts.delete > 0;

  return (
    <div className={styles.confirmationBody}>
      <p>
        {t('monitoring.account_inspection_execute_confirm_body', {
          total: items.length,
          delete: counts.delete,
          disable: counts.disable,
          enable: counts.enable,
        })}
      </p>
      <div className={styles.confirmationStats}>
        <span className={hasDelete ? styles.confirmationDangerStat : ''}>{`${t('monitoring.account_inspection_action_delete')}: ${counts.delete}`}</span>
        <span>{`${t('monitoring.account_inspection_action_disable')}: ${counts.disable}`}</span>
        <span>{`${t('monitoring.account_inspection_action_enable')}: ${counts.enable}`}</span>
      </div>
      {preview.length > 0 ? (
        <div className={styles.confirmationPreview}>
          <strong>{t('monitoring.account_inspection_preview_title')}</strong>
          {preview.map((item) => (
            <div key={item.key} className={styles.confirmationPreviewRow}>
              <span>{item.account}</span>
              <small>{item.provider}</small>
              <strong className={item.dangerous ? styles.errorText : undefined}>{item.action}</strong>
              <em>{item.reason}</em>
            </div>
          ))}
        </div>
      ) : null}
      {hasAutoExecutePolicy ? (
        <p className={styles.warningText}>
          {t('monitoring.account_inspection_settings_auto_section_desc')}
        </p>
      ) : null}
      {hasDelete ? (
        <p className={styles.dangerText}>
          {t('monitoring.account_inspection_delete_irreversible_warning', {
            defaultValue: 'Delete actions cannot be restored from this page. Confirm that auth files are backed up before continuing.',
          })}
        </p>
      ) : null}
    </div>
  );
};

const withChanged = <S, K extends keyof S>(
  state: S,
  key: K,
  next: S[K],
  isEqual: (left: S[K], right: S[K]) => boolean
): S => {
  if (isEqual(next, state[key])) return state;
  return { ...state, [key]: next };
};

const sameProgressSnapshot = (left: AccountInspectionProgressSnapshot, right: AccountInspectionProgressSnapshot) =>
  left.total === right.total &&
  left.completed === right.completed &&
  left.inFlight === right.inFlight &&
  left.pending === right.pending &&
  left.percent === right.percent &&
  left.status === right.status &&
  left.startedAt === right.startedAt &&
  left.summary.totalFiles === right.summary.totalFiles &&
  left.summary.probeSetCount === right.summary.probeSetCount &&
  left.summary.sampledCount === right.summary.sampledCount &&
  left.summary.disabledCount === right.summary.disabledCount &&
  left.summary.enabledCount === right.summary.enabledCount &&
  left.summary.deleteCount === right.summary.deleteCount &&
  left.summary.disableCount === right.summary.disableCount &&
  left.summary.enableCount === right.summary.enableCount &&
  left.summary.keepCount === right.summary.keepCount &&
  left.summary.errorCount === right.summary.errorCount;

const sameInspectionSettings = (left: AccountInspectionConfigurableSettings, right: AccountInspectionConfigurableSettings) =>
  left.targetType === right.targetType &&
  left.workers === right.workers &&
  left.deleteWorkers === right.deleteWorkers &&
  left.timeout === right.timeout &&
  left.retries === right.retries &&
  left.usedPercentThreshold === right.usedPercentThreshold &&
  left.sampleSize === right.sampleSize &&
  left.autoExecuteQuotaLimitDisable === right.autoExecuteQuotaLimitDisable &&
  left.autoExecuteQuotaRecoveryEnable === right.autoExecuteQuotaRecoveryEnable &&
  left.autoExecuteAccountErrorAction === right.autoExecuteAccountErrorAction;

const sameSettingsDraft = (left: InspectionSettingsDraft, right: InspectionSettingsDraft) =>
  left.targetType === right.targetType &&
  left.workers === right.workers &&
  left.deleteWorkers === right.deleteWorkers &&
  left.timeout === right.timeout &&
  left.retries === right.retries &&
  left.usedPercentThreshold === right.usedPercentThreshold &&
  left.sampleSize === right.sampleSize &&
  left.autoExecuteQuotaLimitDisable === right.autoExecuteQuotaLimitDisable &&
  left.autoExecuteQuotaRecoveryEnable === right.autoExecuteQuotaRecoveryEnable &&
  left.autoExecuteAccountErrorAction === right.autoExecuteAccountErrorAction;

const sameScheduleDraft = (left: ScheduleDraft, right: ScheduleDraft) =>
  left.enabled === right.enabled && left.intervalMinutes === right.intervalMinutes;

const sameScheduleResponse = (
  left: AccountInspectionScheduleResponse | null,
  right: AccountInspectionScheduleResponse | null
) => {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.schedule.enabled === right.schedule.enabled &&
    left.schedule.intervalMinutes === right.schedule.intervalMinutes &&
    left.schedule.nextRunAt === right.schedule.nextRunAt &&
    sameInspectionSettings(left.schedule.settings, right.schedule.settings);
};

const sameAutoExecutionCounts = (left: AutoExecutionCounts, right: AutoExecutionCounts) =>
  left.delete === right.delete && left.disable === right.disable && left.enable === right.enable;

const sameRunStatus = (left: RunStatus, right: RunStatus) => left === right;

const handleAccountInspectionControlError = (
  error: unknown,
  appendLog: (level: AccountInspectionLogLevel, message: string) => void,
  showNotification: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void,
  fallbackMessage: string
) => {
  const message = error instanceof Error ? error.message : String(error || fallbackMessage);
  appendLog('error', message);
  showNotification(message, 'error');
};

type BackendInspectionViewState = ReturnType<typeof buildAccountInspectionBackendViewState>;

type InspectionBackendState = {
  inspectionSettings: AccountInspectionConfigurableSettings;
  settingsDraft: InspectionSettingsDraft;
  scheduleDraft: ScheduleDraft;
  scheduleResponse: AccountInspectionScheduleResponse | null;
  logs: InspectionLogEntry[];
  runStatus: RunStatus;
  progress: AccountInspectionProgressSnapshot;
  result: AccountInspectionRunResult | null;
  autoExecutionCounts: AutoExecutionCounts;
};

type InspectionBackendAction =
  | { type: 'configChanged'; settings: AccountInspectionConfigurableSettings; syncDraft: boolean }
  | { type: 'backendResponseReceived'; response: AccountInspectionScheduleResponse }
  | { type: 'clearScheduleResponse' }
  | { type: 'appendLog'; level: AccountInspectionLogLevel; message: string; timestamp: number }
  | { type: 'clearLogs' }
  | { type: 'startRun'; timestamp: number }
  | { type: 'runFailed' }
  | { type: 'clearAutoExecutionCounts' }
  | { type: 'setResult'; result: AccountInspectionRunResult | null }
  | { type: 'resetSettings'; settings: AccountInspectionConfigurableSettings }
  | { type: 'setSettingsDraft'; draft: InspectionSettingsDraft }
  | { type: 'updateSettingsDraft'; values: Partial<InspectionSettingsDraft> }
  | { type: 'updateScheduleDraft'; values: Partial<ScheduleDraft> };

const createInspectionBackendState = (settings: AccountInspectionConfigurableSettings): InspectionBackendState => ({
  inspectionSettings: settings,
  settingsDraft: toSettingsDraft(settings),
  scheduleDraft: { enabled: false, intervalMinutes: '360' },
  scheduleResponse: null,
  logs: [],
  runStatus: 'idle',
  progress: createIdleAccountInspectionProgressSnapshot(),
  result: null,
  autoExecutionCounts: emptyAutoExecutionCounts(),
});

const applyBackendViewState = (
  state: InspectionBackendState,
  response: AccountInspectionScheduleResponse,
  viewState: BackendInspectionViewState
) => {
  let nextState = state;
  nextState = withChanged(nextState, 'inspectionSettings', viewState.settings, sameInspectionSettings);
  nextState = withChanged(nextState, 'settingsDraft', toSettingsDraft(viewState.settings), sameSettingsDraft);
  nextState = withChanged(nextState, 'scheduleDraft', viewState.scheduleDraft, sameScheduleDraft);
  nextState = withChanged(nextState, 'scheduleResponse', response, sameScheduleResponse);
  nextState = withChanged(nextState, 'autoExecutionCounts', viewState.autoExecutionCounts, sameAutoExecutionCounts);
  nextState = withChanged(nextState, 'progress', viewState.progress, sameProgressSnapshot);
  nextState = withChanged(nextState, 'runStatus', viewState.runStatus, sameRunStatus);
  if (viewState.logs) {
    nextState = withChanged(nextState, 'logs', viewState.logs, Object.is);
  }
  return withChanged(nextState, 'result', viewState.result, Object.is);
};

const inspectionBackendReducer = (
  state: InspectionBackendState,
  action: InspectionBackendAction
): InspectionBackendState => {
  switch (action.type) {
    case 'configChanged': {
      let nextState = withChanged(state, 'inspectionSettings', action.settings, sameInspectionSettings);
      if (action.syncDraft) {
        nextState = withChanged(nextState, 'settingsDraft', toSettingsDraft(action.settings), sameSettingsDraft);
      }
      return nextState;
    }
    case 'backendResponseReceived':
      return applyBackendViewState(state, action.response, buildAccountInspectionBackendViewState(action.response));
    case 'clearScheduleResponse':
      return state.scheduleResponse === null ? state : { ...state, scheduleResponse: null };
    case 'appendLog':
      return {
        ...state,
        logs: appendInspectionLogEntry(state.logs, {
          id: `${action.timestamp}-${state.logs.length}`,
          level: action.level,
          message: action.message,
          timestamp: action.timestamp,
        }),
      };
    case 'clearLogs':
      return state.logs.length === 0 ? state : { ...state, logs: [] };
    case 'startRun':
      return {
        ...state,
        result: null,
        runStatus: 'running',
        autoExecutionCounts: emptyAutoExecutionCounts(),
        progress: {
          ...createIdleAccountInspectionProgressSnapshot(),
          status: 'running',
          startedAt: action.timestamp,
          updatedAt: action.timestamp,
        },
      };
    case 'runFailed':
      return state.runStatus === 'error' ? state : { ...state, runStatus: 'error' };
    case 'clearAutoExecutionCounts':
      return withChanged(state, 'autoExecutionCounts', emptyAutoExecutionCounts(), sameAutoExecutionCounts);
    case 'setResult':
      return state.result === action.result ? state : { ...state, result: action.result };
    case 'resetSettings':
      return {
        ...state,
        inspectionSettings: action.settings,
        settingsDraft: toSettingsDraft(action.settings),
      };
    case 'setSettingsDraft':
      return withChanged(state, 'settingsDraft', action.draft, sameSettingsDraft);
    case 'updateSettingsDraft':
      return { ...state, settingsDraft: { ...state.settingsDraft, ...action.values } };
    case 'updateScheduleDraft':
      return { ...state, scheduleDraft: { ...state.scheduleDraft, ...action.values } };
    default:
      return state;
  }
};

export function AccountInspectionPage() {
  const { t, i18n } = useTranslation();
  const config = useConfigStore((state) => state.config);
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const antigravityQuota = useQuotaStore((state) => state.antigravityQuota);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const geminiCliQuota = useQuotaStore((state) => state.geminiCliQuota);
  const kimiQuota = useQuotaStore((state) => state.kimiQuota);

  const [backendState, dispatchBackendState] = useReducer(
    inspectionBackendReducer,
    config,
    (initialConfig) => createInspectionBackendState(loadAccountInspectionConfigurableSettings(initialConfig))
  );
  const {
    inspectionSettings,
    settingsDraft,
    scheduleDraft,
    scheduleResponse,
    logs,
    runStatus,
    progress,
    result,
    autoExecutionCounts,
  } = backendState;
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [logsCollapsed, setLogsCollapsed] = useState(false);
  const [resultFilter, setResultFilter] = useState<ResultFilter>('pending');
  const [logLevelFilter, setLogLevelFilter] = useState<AccountInspectionLogLevel | 'all'>('all');
  const [authFiles, setAuthFiles] = useState<AuthFileItem[]>([]);
  const [authFilesLoaded, setAuthFilesLoaded] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [recheckingKey, setRecheckingKey] = useState<string | null>(null);
  const [exportingAuthFiles, setExportingAuthFiles] = useState(false);
  const [selectedAssetProvider, setSelectedAssetProvider] = useState<string>('all');
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => getDocumentTheme());
  const logListRef = useRef<HTMLDivElement | null>(null);
  const resultsPanelRef = useRef<HTMLDivElement | null>(null);
  const refreshedBackendFinishedAtRef = useRef(0);


  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setResolvedTheme(getDocumentTheme()));
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    dispatchBackendState({
      type: 'configChanged',
      settings: loadAccountInspectionConfigurableSettings(config),
      syncDraft: !isSettingsModalOpen,
    });
  }, [config, isSettingsModalOpen]);

  const loadAuthFiles = useCallback(async () => {
    if (connectionStatus !== 'connected') {
      setAuthFiles([]);
      setAuthFilesLoaded(false);
      return;
    }

    try {
      const response = await apiClient.get<AuthFilesResponse>('/auth-files');
      setAuthFiles(Array.isArray(response.files) ? response.files : []);
      setAuthFilesLoaded(true);
    } catch {
      setAuthFiles([]);
      setAuthFilesLoaded(false);
    }
  }, [connectionStatus]);

  useEffect(() => {
    void loadAuthFiles();
  }, [loadAuthFiles]);

  const applyBackendResponse = useCallback((response: AccountInspectionScheduleResponse) => {
    dispatchBackendState({ type: 'backendResponseReceived', response });

    if (
      response.status.state !== 'running' &&
      response.status.state !== 'paused' &&
      response.status.state !== 'stopping' &&
      response.status.lastFinishedAt > 0 &&
      refreshedBackendFinishedAtRef.current !== response.status.lastFinishedAt
    ) {
      refreshedBackendFinishedAtRef.current = response.status.lastFinishedAt;
      quotaPersistenceMiddleware.markStale(response.status.lastFinishedAt);
      void loadAuthFiles();
    }
  }, [loadAuthFiles]);

  const loadBackendSchedule = useCallback(async () => {
    if (connectionStatus !== 'connected') return;
    try {
      const response = await accountInspectionApi.getStatus();
      applyBackendResponse(response);
    } catch {
      dispatchBackendState({ type: 'clearScheduleResponse' });
    }
  }, [applyBackendResponse, connectionStatus]);

  useEffect(() => {
    void loadBackendSchedule();
  }, [loadBackendSchedule]);

  useEffect(() => {
    if (connectionStatus !== 'connected' || !apiBase || !managementKey) return;
    let closed = false;
    let socket: WebSocket | null = null;

    try {
      socket = new WebSocket(
        buildAccountInspectionLogsWebSocketUrl(apiBase),
        accountInspectionWebSocketProtocol(managementKey)
      );
    } catch {
      return;
    }

    socket.onmessage = (event) => {
      if (closed || typeof event.data !== 'string') return;
      try {
        const message = JSON.parse(event.data) as AccountInspectionLogStreamMessage;
        if (message.log) {
          dispatchBackendState({
            type: 'appendLog',
            level: message.log!.level,
            message: message.log!.message,
            timestamp: message.log!.time,
          });
          if (message.type === 'log') {
            return;
          }
        }
        applyBackendResponse({
          schedule: message.schedule,
          status: message.status,
        });
      } catch {
        return;
      }
    };

    return () => {
      closed = true;
      socket?.close();
    };
  }, [apiBase, applyBackendResponse, connectionStatus, managementKey]);

  const appendLog = useCallback((level: AccountInspectionLogLevel, message: string) => {
    dispatchBackendState({ type: 'appendLog', level, message, timestamp: Date.now() });
  }, []);

  useEffect(() => {
    if (logsCollapsed) return;
    const element = logListRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [logs, logsCollapsed]);

  const startFreshInspection = useCallback(
    async (preserveLogs: boolean = false, introMessage: string = '') => {
      if (connectionStatus !== 'connected') {
        const message = t('notification.connection_required');
        showNotification(message, 'warning');
        return;
      }

      if (!preserveLogs) {
        dispatchBackendState({ type: 'clearLogs' });
      }
      if (introMessage) {
        appendLog('info', introMessage);
      }

      dispatchBackendState({ type: 'startRun', timestamp: Date.now() });
      setLogsCollapsed(false);

      try {
        const response = await accountInspectionApi.runNow();
        applyBackendResponse(response);
      } catch (error) {
        handleAccountInspectionControlError(error, appendLog, showNotification, t('common.unknown_error'));
        dispatchBackendState({ type: 'runFailed' });
        setLogsCollapsed(false);
      }
    },
    [appendLog, applyBackendResponse, connectionStatus, showNotification, t]
  );

  const handleRunInspection = useCallback(() => {
    if (runStatus === 'paused') {
      setLogsCollapsed(false);
      void accountInspectionApi.resume()
        .then(applyBackendResponse)
        .catch((error) => handleAccountInspectionControlError(error, appendLog, showNotification, t('common.unknown_error')));
      return;
    }

    void startFreshInspection(false);
  }, [appendLog, applyBackendResponse, runStatus, showNotification, startFreshInspection, t]);

  const handleExportAuthFiles = useCallback(async () => {
    if (connectionStatus !== 'connected') {
      showNotification(t('notification.connection_required'), 'warning');
      return;
    }

    setExportingAuthFiles(true);
    try {
      const response = await apiClient.get<AuthFilesResponse>('/auth-files');
      const files = Array.isArray(response.files) ? response.files : [];
      const entries = await Promise.all(
        files
          .filter((file) => typeof file.name === 'string' && file.name.trim())
          .map(async (file) => {
            const name = file.name.trim();
            const downloadResponse = await apiClient.getRaw(`/auth-files/download?name=${encodeURIComponent(name)}`, {
              responseType: 'blob',
            });
            const blob = downloadResponse.data instanceof Blob
              ? downloadResponse.data
              : new Blob([downloadResponse.data], { type: 'application/json' });
            return {
              name,
              content: await blob.text(),
            };
          })
      );

      if (entries.length === 0) {
        showNotification(t('monitoring.account_inspection_auth_files_export_empty'), 'info');
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const archive = await buildZipArchive(entries);
      downloadBlobFile(`auth-files-export-${timestamp}.zip`, archive);
      showNotification(t('monitoring.account_inspection_auth_files_export_success', { count: entries.length }), 'success');
    } catch (error) {
      showNotification(error instanceof Error ? error.message : String(error || t('common.unknown_error')), 'error');
    } finally {
      setExportingAuthFiles(false);
    }
  }, [connectionStatus, showNotification, t]);

  const handlePauseInspection = useCallback(() => {
    if (runStatus !== 'running') return;
    void accountInspectionApi.pause()
      .then(applyBackendResponse)
      .catch((error) => handleAccountInspectionControlError(error, appendLog, showNotification, t('common.unknown_error')));
  }, [appendLog, applyBackendResponse, runStatus, showNotification, t]);

  const handleStopInspection = useCallback(() => {
    void accountInspectionApi.stop()
      .then((response) => {
        appendLog('warning', t('monitoring.account_inspection_stopped'));
        applyBackendResponse(response);
        setLogsCollapsed(false);
        dispatchBackendState({ type: 'clearAutoExecutionCounts' });
      })
      .catch((error) => handleAccountInspectionControlError(error, appendLog, showNotification, t('common.unknown_error')));
  }, [appendLog, applyBackendResponse, showNotification, t]);

  const executeItems = useCallback(
    async (items: AccountInspectionResultItem[]) => {
      const currentResult = result;
      if (!currentResult) return;
      const targets = items.filter(isSuggestedAction);
      const actionItems = targets.flatMap((item) => {
        if (item.action === 'keep') return [];
        return [{
          key: item.key,
          provider: item.provider,
          fileName: item.fileName,
          displayName: item.displayAccount,
          email: item.email,
          name: item.name,
          authIndex: item.authIndex,
          disabled: item.disabled,
          action: item.action,
        }];
      });
      if (actionItems.length === 0) {
        showNotification(t('monitoring.account_inspection_no_pending_actions'), 'info');
        return;
      }

      setExecuting(true);
      setLogsCollapsed(false);
      appendLog('info', t('monitoring.account_inspection_execute_started'));

      try {
        const response = await accountInspectionApi.executeActions(actionItems);
        const execution: AccountInspectionExecutionResult = {
          outcomes: response.outcomes.map((item) => ({
            action: item.action,
            fileName: item.fileName,
            displayAccount: item.displayName,
            email: item.email,
            name: item.name,
            provider: item.provider,
            authIndex: item.authIndex || null,
            success: item.success,
            error: item.error,
          })),
          refreshedFiles: [],
          refreshError: '',
        };

        const failed = execution.outcomes.filter((item) => !item.success);
        if (failed.length > 0) {
          showNotification(
            `${t('monitoring.account_inspection_execute_partial')}: ${failed
              .slice(0, 2)
              .map(buildExecutionFailureMessage)
              .join('；')}`,
            'warning'
          );
        } else {
          showNotification(t('monitoring.account_inspection_execute_success'), 'success');
        }
        const nextResult = applyAccountInspectionExecutionResult(currentResult, execution);
        dispatchBackendState({ type: 'setResult', result: nextResult });
        void loadAuthFiles();
      } finally {
        setExecuting(false);
      }
    },
    [appendLog, loadAuthFiles, result, showNotification, t]
  );

  const allResults = useMemo(
    () => (result ? result.results : []),
    [result]
  );

  const actionableResults = useMemo(
    () => allResults.filter((item) => isSuggestedAction(item) && !item.executed),
    [allResults]
  );

  const healthCounts = useMemo(
    () => countHealthStatuses(allResults),
    [allResults]
  );

  const resultFilterWithFallback = resultFilter === 'pending' && actionableResults.length === 0 && allResults.length > 0 ? 'all' : resultFilter;

  const filteredResults = useMemo(() => {
    switch (resultFilterWithFallback) {
      case 'all':
        return allResults;
      case 'authInvalid':
        return allResults.filter((item) => resolveResultHealthStatus(item) === 'authInvalid');
      case 'quotaExhausted':
        return allResults.filter((item) => resolveResultHealthStatus(item) === 'quotaExhausted');
      case 'inspectionError':
        return allResults.filter((item) => resolveResultHealthStatus(item) === 'inspectionError');
      case 'recoverable':
        return allResults.filter((item) => resolveResultHealthStatus(item) === 'recoverable');
      case 'processed':
        return allResults.filter((item) => item.executed || !isSuggestedAction(item));
      case 'pending':
      default:
        return actionableResults;
    }
  }, [actionableResults, allResults, resultFilterWithFallback]);

  const filteredLogs = useMemo(
    () => (logLevelFilter === 'all' ? logs : logs.filter((entry) => entry.level === logLevelFilter)),
    [logLevelFilter, logs]
  );

  const handleExecutePlanned = useCallback(() => {
    if (!result) return;

    const targets = actionableResults;
    const counts = countActions(targets);
    showConfirmation({
      title: t('monitoring.account_inspection_execute_confirm_title'),
      message: buildExecuteConfirmationMessage(
        targets,
        t,
        hasAccountInspectionAutoExecutePolicies(inspectionSettings)
      ),
      confirmText: t('monitoring.account_inspection_execute_confirm_button', {
        defaultValue: 'Execute {{count}} Actions',
        count: targets.length,
      }),
      cancelText: t('common.cancel'),
      variant: counts.delete > 0 ? 'danger' : 'primary',
      onConfirm: () => executeItems(targets),
    });
  }, [actionableResults, executeItems, inspectionSettings, result, showConfirmation, t]);

  const handleExecuteSingle = useCallback(
    (item: AccountInspectionResultItem, manualAction?: ManualAccountInspectionAction) => {
      const target = manualAction ? buildManualActionItem(item, manualAction) : item;
      const actionLabel = formatActionLabel(target.action, t);
      showConfirmation({
        title: t('monitoring.account_inspection_execute_single_title'),
        message: buildExecuteConfirmationMessage(
          [target],
          t,
          hasAccountInspectionAutoExecutePolicies(inspectionSettings)
        ),
        confirmText: actionLabel,
        cancelText: t('common.cancel'),
        variant: target.action === 'delete' ? 'danger' : 'primary',
        onConfirm: () => executeItems([target]),
      });
    },
    [executeItems, inspectionSettings, showConfirmation, t]
  );

  const handleRecheckSingle = useCallback(
    async (item: AccountInspectionResultItem) => {
      if (connectionStatus !== 'connected') {
        showNotification(t('notification.connection_required'), 'warning');
        return;
      }
      setRecheckingKey(item.key);
      setLogsCollapsed(false);
      appendLog('info', t('monitoring.account_inspection_recheck_started', {
        defaultValue: 'Rechecking {{account}}',
        account: item.fileName,
      }));
      try {
        const response = await accountInspectionApi.inspectOne({
          key: item.key,
          provider: item.provider,
          fileName: item.fileName,
          displayName: item.displayAccount,
          email: item.email,
          name: item.name,
          authIndex: item.authIndex,
          disabled: item.disabled,
        });
        applyBackendResponse(response);
      } catch (error) {
        handleAccountInspectionControlError(error, appendLog, showNotification, t('common.unknown_error'));
      } finally {
        setRecheckingKey(null);
      }
    },
    [appendLog, applyBackendResponse, connectionStatus, showNotification, t]
  );

  const quotaStore = useMemo(
    () => ({ antigravityQuota, claudeQuota, codexQuota, geminiCliQuota, kimiQuota }),
    [antigravityQuota, claudeQuota, codexQuota, geminiCliQuota, kimiQuota]
  );

  const authFileStats = useMemo(
    () => buildAuthFileAccountStats(authFiles, quotaStore),
    [authFiles, quotaStore]
  );

  useEffect(() => {
    if (selectedAssetProvider === 'all') return;
    if (authFileStats.providers.some((provider) => provider.provider === selectedAssetProvider)) return;
    setSelectedAssetProvider('all');
  }, [authFileStats.providers, selectedAssetProvider]);

  const selectedAssetStats = useMemo<AuthFileAccountStats | ProviderAccountStats>(() => {
    if (selectedAssetProvider === 'all') return authFileStats;
    return authFileStats.providers.find((provider) => provider.provider === selectedAssetProvider) ?? authFileStats;
  }, [authFileStats, selectedAssetProvider]);

  const selectedAssetLabel = selectedAssetProvider === 'all'
    ? t('monitoring.account_inspection_account_summary_title')
    : resolveProviderDisplayLabel(selectedAssetProvider);

  const accountAssetCards = useMemo<SummaryCard[]>(() => [
    {
      key: 'total',
      label: t('monitoring.account_inspection_account_total'),
      value: authFilesLoaded ? String(selectedAssetStats.total) : '--',
      description: selectedAssetLabel,
    },
    {
      key: 'enabled',
      label: t('monitoring.account_inspection_account_enabled'),
      value: authFilesLoaded ? String(selectedAssetStats.enabled) : '--',
      description: t('monitoring.account_inspection_inventory_health'),
      tone: authFilesLoaded && selectedAssetStats.enabled > 0 ? 'good' : 'neutral',
    },
    {
      key: 'highAvailable',
      label: t('monitoring.account_inspection_high_available', { defaultValue: 'High availability' }),
      value: authFilesLoaded ? String(selectedAssetStats.highAvailable) : '--',
      description: t('monitoring.account_inspection_high_available_desc', { defaultValue: 'Quota-ready non-error accounts' }),
      tone: authFilesLoaded && selectedAssetStats.highAvailable > 0 ? 'good' : 'neutral',
    },
    {
      key: 'quotaLow',
      label: t('monitoring.account_inspection_account_quota_low'),
      value: authFilesLoaded ? String(selectedAssetStats.quotaLow) : '--',
      description: t('monitoring.account_inspection_settings_auto_execute_quota_limit_disable_label'),
      tone: authFilesLoaded && selectedAssetStats.quotaLow > 0 ? 'bad' : 'neutral',
    },
    {
      key: 'disabled',
      label: t('monitoring.account_inspection_account_disabled'),
      value: authFilesLoaded ? String(selectedAssetStats.disabled) : '--',
      description: t('monitoring.account_inspection_blast_radius'),
      tone: authFilesLoaded && selectedAssetStats.disabled > 0 ? 'warn' : 'neutral',
    },
    {
      key: 'abnormal',
      label: t('monitoring.account_inspection_account_abnormal'),
      value: authFilesLoaded ? String(selectedAssetStats.abnormal) : '--',
      description: t('monitoring.account_inspection_settings_auto_execute_account_error_action_label'),
      tone: authFilesLoaded && selectedAssetStats.abnormal > 0 ? 'bad' : 'neutral',
    },
  ], [authFilesLoaded, selectedAssetLabel, selectedAssetStats, t]);

  const actionStats = useMemo(() => {
    const suggested = countActions(actionableResults);
    const autoTotal = autoExecutionCounts.delete + autoExecutionCounts.disable + autoExecutionCounts.enable;
    const manualTotal = suggested.delete + suggested.disable + suggested.enable;
    return {
      autoTotal,
      manualTotal,
      autoDelete: autoExecutionCounts.delete,
      autoDisable: autoExecutionCounts.disable,
      autoEnable: autoExecutionCounts.enable,
      manualDelete: suggested.delete,
      manualDisable: suggested.disable,
      manualEnable: suggested.enable,
      keep: result?.summary.keepCount ?? 0,
      error: result?.summary.errorCount ?? 0,
    };
  }, [actionableResults, autoExecutionCounts, result]);

  const pendingActionCount = actionableResults.length;
  const hasAutoExecutionPolicy = hasAccountInspectionAutoExecutePolicies(inspectionSettings);
  const inspectionScopeLabel = inspectionSettings.targetType === ACCOUNT_INSPECTION_ALL_PROVIDER_TYPE
    ? t('monitoring.filter_all_providers')
    : resolveProviderDisplayLabel(inspectionSettings.targetType);
  const settingEnabledLabel = t('monitoring.account_inspection_setting_enabled', { defaultValue: 'Enabled' });
  const settingDisabledLabel = t('monitoring.account_inspection_setting_disabled', { defaultValue: 'Disabled' });
  const quotaLimitAutoLabel = inspectionSettings.autoExecuteQuotaLimitDisable ? settingEnabledLabel : settingDisabledLabel;
  const quotaRecoveryAutoLabel = inspectionSettings.autoExecuteQuotaRecoveryEnable ? settingEnabledLabel : settingDisabledLabel;
  const accountErrorActionLabel = t(
    AUTO_ERROR_ACTION_OPTIONS.find((option) => option.value === inspectionSettings.autoExecuteAccountErrorAction)?.labelKey
      ?? 'monitoring.account_inspection_settings_account_error_action_none'
  );
  const scheduleStatusLabel = scheduleResponse?.schedule.enabled
    ? formatInspectionInterval(scheduleResponse.schedule.intervalMinutes, i18n.language)
    : settingDisabledLabel;
  const autoExecutionResultLabel = actionStats.autoTotal > 0
    ? [
        `${t('monitoring.account_inspection_action_enable')}: ${actionStats.autoEnable}`,
        `${t('monitoring.account_inspection_action_disable')}: ${actionStats.autoDisable}`,
        `${t('monitoring.account_inspection_action_delete')}: ${actionStats.autoDelete}`,
      ].join(' · ')
    : t('monitoring.account_inspection_auto_execute_no_actions');
  const showInspectionResults = useCallback((filter: ResultFilter) => {
    setResultFilter(filter);
    requestAnimationFrame(() => resultsPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }, []);

  const operationPhase = useMemo(() => {
    if (executing) return t('monitoring.account_inspection_phase_executing', { defaultValue: 'Executing suggested actions' });
    if (runStatus === 'paused') return t('monitoring.account_inspection_phase_paused', { defaultValue: 'Inspection paused' });
    if (runStatus === 'running') {
      if (progress.completed <= 0 && progress.inFlight <= 0) {
        return t('monitoring.account_inspection_phase_initializing', { defaultValue: 'Preparing account probes' });
      }
      return t('monitoring.account_inspection_phase_probing', { defaultValue: 'Probing account health' });
    }
    if (runStatus === 'error') return t('monitoring.account_inspection_phase_failed', { defaultValue: 'Inspection failed' });
    if (result && pendingActionCount > 0) return t('monitoring.account_inspection_phase_review', { defaultValue: 'Review suggested actions' });
    if (result) return t('monitoring.account_inspection_phase_completed', { defaultValue: 'Inspection completed' });
    return t('monitoring.account_inspection_phase_idle', { defaultValue: 'Ready to inspect' });
  }, [executing, pendingActionCount, progress.completed, progress.inFlight, result, runStatus, t]);

  const resultEmptyMessage = runStatus === 'running'
    ? t('monitoring.account_inspection_results_generating', { defaultValue: 'Inspection is running. Results will appear as soon as the backend publishes a snapshot.' })
    : runStatus === 'error'
      ? t('monitoring.account_inspection_results_error_empty', { defaultValue: 'Unable to complete the inspection. Check logs and retry.' })
      : t('monitoring.account_inspection_empty');
  const resultFilterTabs = useMemo<Array<{ key: ResultFilter; label: string; count: number }>>(() => [
    { key: 'all', label: t('monitoring.account_inspection_filter_all'), count: allResults.length },
    { key: 'pending', label: t('monitoring.account_inspection_filter_pending'), count: pendingActionCount },
    { key: 'authInvalid', label: t('monitoring.account_inspection_health_auth_invalid'), count: healthCounts.authInvalid },
    { key: 'quotaExhausted', label: t('monitoring.account_inspection_health_quota_exhausted'), count: healthCounts.quotaExhausted },
    { key: 'inspectionError', label: t('monitoring.account_inspection_health_inspection_error'), count: healthCounts.inspectionError },
    { key: 'recoverable', label: t('monitoring.account_inspection_health_recoverable'), count: healthCounts.recoverable },
    { key: 'processed', label: t('monitoring.account_inspection_filter_processed'), count: allResults.length - pendingActionCount },
  ], [allResults.length, healthCounts, pendingActionCount, t]);
  const logLevelOptions = useMemo<Array<{ key: AccountInspectionLogLevel | 'all'; label: string }>>(() => [
    { key: 'all', label: t('monitoring.account_inspection_filter_all') },
    { key: 'success', label: t('monitoring.account_inspection_log_success') },
    { key: 'warning', label: t('monitoring.account_inspection_log_warning') },
    { key: 'error', label: t('monitoring.account_inspection_log_error') },
  ], [t]);
  const progressLabel =
    progress.total > 0
      ? t('monitoring.account_inspection_progress_status', {
          completed: progress.completed,
          total: progress.total,
          inFlight: progress.inFlight,
          pending: progress.pending,
          percent: progress.percent,
        })
      : t('monitoring.account_inspection_progress_idle');
  const openSettingsModal = useCallback(() => {
    dispatchBackendState({ type: 'setSettingsDraft', draft: toSettingsDraft(inspectionSettings) });
    setIsSettingsModalOpen(true);
  }, [inspectionSettings]);

  const handleSettingsDraftChange = useCallback(
    (field: InspectionSettingsDraftField, value: string) => {
      dispatchBackendState({
        type: 'updateSettingsDraft',
        values: { [field]: value },
      });
    },
    []
  );

  const handleAutoExecuteQuotaLimitChange = useCallback((value: boolean) => {
    dispatchBackendState({
      type: 'updateSettingsDraft',
      values: { autoExecuteQuotaLimitDisable: value },
    });
  }, []);

  const handleAutoExecuteQuotaRecoveryChange = useCallback((value: boolean) => {
    dispatchBackendState({
      type: 'updateSettingsDraft',
      values: { autoExecuteQuotaRecoveryEnable: value },
    });
  }, []);

  const handleAutoExecuteAccountErrorActionChange = useCallback((value: string) => {
    dispatchBackendState({
      type: 'updateSettingsDraft',
      values: {
        autoExecuteAccountErrorAction: value === 'disable' || value === 'delete' ? value : 'none',
      },
    });
  }, []);

  const parseIntegerInRange = useCallback(
    (value: string, label: string, min: number, max?: number) => {
      const parsed = Number(value.trim());
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) {
        throw new Error(
          max === undefined
            ? t('monitoring.account_inspection_settings_invalid_integer', { field: label, min })
            : t('monitoring.account_inspection_settings_invalid_integer_range', { field: label, min, max })
        );
      }
      return parsed;
    },
    [t]
  );

  const handleSaveSettings = useCallback(async () => {
    const targetType = settingsDraft.targetType.trim().toLowerCase();
    if (!targetType) {
      showNotification(t('monitoring.account_inspection_settings_target_type_required'), 'error');
      return;
    }

    try {
      const nextSettings = saveAccountInspectionConfigurableSettings({
        targetType,
        workers: parseIntegerInRange(
          settingsDraft.workers,
          t('monitoring.account_inspection_settings_workers_label'),
          WORKER_LIMITS.min,
          WORKER_LIMITS.max
        ),
        deleteWorkers: parseIntegerInRange(
          settingsDraft.deleteWorkers,
          t('monitoring.account_inspection_settings_delete_workers_label'),
          DELETE_WORKER_LIMITS.min,
          DELETE_WORKER_LIMITS.max
        ),
        timeout: parseIntegerInRange(
          settingsDraft.timeout,
          t('monitoring.account_inspection_settings_timeout_label'),
          TIMEOUT_LIMITS.min,
          TIMEOUT_LIMITS.max
        ),
        retries: parseIntegerInRange(
          settingsDraft.retries,
          t('monitoring.account_inspection_settings_retries_label'),
          RETRY_LIMITS.min,
          RETRY_LIMITS.max
        ),
        sampleSize: parseIntegerInRange(
          settingsDraft.sampleSize,
          t('monitoring.account_inspection_settings_sample_size_label'),
          SAMPLE_SIZE_LIMITS.min
        ),
        usedPercentThreshold: (() => {
          const parsed = Number(settingsDraft.usedPercentThreshold.trim());
          if (!Number.isFinite(parsed) || parsed < THRESHOLD_LIMITS.min || parsed > THRESHOLD_LIMITS.max) {
            throw new Error(
              t('monitoring.account_inspection_settings_invalid_threshold', {
                field: t('monitoring.account_inspection_settings_used_percent_threshold_label'),
              })
            );
          }
          return parsed;
        })(),
        autoExecuteQuotaLimitDisable: settingsDraft.autoExecuteQuotaLimitDisable,
        autoExecuteQuotaRecoveryEnable: settingsDraft.autoExecuteQuotaRecoveryEnable,
        autoExecuteAccountErrorAction: settingsDraft.autoExecuteAccountErrorAction,
      });

      const intervalMinutes = parseIntegerInRange(
        scheduleDraft.intervalMinutes,
        t('monitoring.account_inspection_schedule_interval_label'),
        SCHEDULE_INTERVAL_LIMITS.min
      );
      setScheduleLoading(true);
      const response = await accountInspectionApi.updateSchedule({
        enabled: scheduleDraft.enabled,
        intervalMinutes,
        nextRunAt: scheduleDraft.enabled
          ? (scheduleResponse?.schedule.nextRunAt ?? 0)
          : 0,
        settings: nextSettings,
      });
      applyBackendResponse(response);
      setIsSettingsModalOpen(false);
      showNotification(t('monitoring.account_inspection_settings_saved'), 'success');
    } catch (error) {
      showNotification(error instanceof Error ? error.message : String(error || t('common.unknown_error')), 'error');
    } finally {
      setScheduleLoading(false);
    }
  }, [applyBackendResponse, parseIntegerInRange, scheduleDraft.enabled, scheduleDraft.intervalMinutes, scheduleResponse?.schedule.nextRunAt, settingsDraft, showNotification, t]);

  const handleResetSettings = useCallback(() => {
    clearAccountInspectionConfigurableSettings();
    const nextSettings = saveAccountInspectionConfigurableSettings(DEFAULT_ACCOUNT_INSPECTION_SETTINGS);
    dispatchBackendState({ type: 'resetSettings', settings: nextSettings });
    showNotification(t('monitoring.account_inspection_settings_reset'), 'success');
  }, [showNotification, t]);

  return (
    <div className={styles.page}>
      <Card className={styles.heroCard}>
        <div className={styles.heroHeader}>
          <div className={styles.heroCopy}>
            <h1 className={styles.heroTitle}>{t('monitoring.account_inspection_title')}</h1>
            <p className={styles.heroSubtitle}>{t('monitoring.account_inspection_desc')}</p>
          </div>
          <div className={styles.heroActions}>
            <Button
              variant="secondary"
              className={styles.heroActionButton}
              onClick={handleExportAuthFiles}
              loading={exportingAuthFiles}
              disabled={exportingAuthFiles || connectionStatus !== 'connected'}
            >
              {t('monitoring.account_inspection_auth_files_export')}
            </Button>
          </div>
        </div>

        <div className={styles.assetOverviewGrid}>
          <div className={styles.assetKpiGrid}>
            {accountAssetCards.map((card, index) => (
              <Card
                key={card.key}
                className={[styles.professionalMetricCard, styles[`professionalMetricCard${index + 1}`], summaryToneClass[card.tone ?? 'neutral']]
                  .filter(Boolean)
                  .join(' ')}
              >
                <div className={styles.professionalMetricHeader}>
                  <span className={styles.professionalMetricIcon} aria-hidden="true" />
                  <strong>{card.label}</strong>
                </div>
                <div className={styles.professionalMetricBody}>
                  <span>{card.description}</span>
                  <strong>{card.value}</strong>
                </div>
              </Card>
            ))}
          </div>

          <Card className={styles.providerDistributionCard}>
            <div className={styles.providerDistributionHeader}>
              <div>
                <h3>{t('monitoring.account_inspection_provider_distribution_title', { defaultValue: 'Provider Distribution' })}</h3>
                <p>{authFilesLoaded ? t('monitoring.account_inspection_provider_distribution_desc', { defaultValue: '{{count}} providers detected', count: authFileStats.providerCount }) : t('common.loading')}</p>
              </div>
              <span>{selectedAssetLabel}</span>
            </div>
            <div className={styles.providerSelectorList}>
              <button
                type="button"
                className={[styles.providerSelectorRow, selectedAssetProvider === 'all' ? styles.providerSelectorRowActive : '']
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => setSelectedAssetProvider('all')}
              >
                <div>
                  <span className={styles.providerSelectorTitle}>
                    <span className={styles.providerLogoFallback} aria-hidden="true">Σ</span>
                    <strong>{t('monitoring.account_inspection_account_summary_title')}</strong>
                  </span>
                  <span>{`${authFileStats.total} ${t('monitoring.account_inspection_account_total')}`}</span>
                </div>
                <span aria-hidden="true">
                  <i style={{ '--bar-width': authFileStats.total > 0 ? '100%' : '0%', '--bar-color': DONUT_COLORS[0] } as CSSProperties} />
                </span>
              </button>
              {authFileStats.providers.length > 0 ? authFileStats.providers.map((provider, index) => {
                const share = authFileStats.total > 0 ? provider.total / authFileStats.total : 0;
                return (
                  <button
                    type="button"
                    key={provider.provider}
                    className={[styles.providerSelectorRow, selectedAssetProvider === provider.provider ? styles.providerSelectorRowActive : '']
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => setSelectedAssetProvider(provider.provider)}
                  >
                    <div>
                      <span className={styles.providerSelectorTitle}>
                        {getAuthFileIcon(provider.provider, resolvedTheme) ? (
                          <img src={getAuthFileIcon(provider.provider, resolvedTheme) ?? ''} alt="" aria-hidden="true" />
                        ) : (
                          <span className={styles.providerLogoFallback} aria-hidden="true">{getProviderInitial(resolveProviderDisplayLabel(provider.provider))}</span>
                        )}
                        <strong>{resolveProviderDisplayLabel(provider.provider)}</strong>
                      </span>
                      <span>{`${provider.total} ${t('monitoring.account_inspection_account_total')} · ${provider.highAvailable} ${t('monitoring.account_inspection_high_available', { defaultValue: 'High availability' })}`}</span>
                    </div>
                    <span aria-hidden="true">
                      <i style={{ '--bar-width': `${Math.min(Math.max(share * 100, provider.total > 0 ? 1 : 0), 100)}%`, '--bar-color': DONUT_COLORS[index % DONUT_COLORS.length] } as CSSProperties} />
                    </span>
                  </button>
                );
              }) : <div className={styles.emptyBlockSmall}>{authFilesLoaded ? t('monitoring.account_inspection_empty') : t('common.loading')}</div>}
            </div>
          </Card>
        </div>
      </Card>

      <section className={styles.operationSection}>
        <div className={styles.operationModuleHeader}>
          <div>
            <h2>{t('monitoring.account_inspection_control_title')}</h2>
            <p>{t('monitoring.account_inspection_control_desc')}</p>
          </div>
          {result ? (
            <div className={styles.cockpitStatusPills}>
              <span>{`${t('monitoring.last_sync')}: ${formatTimestamp(result.finishedAt, i18n.language)}`}</span>
              <span>{`${t('monitoring.account_inspection_pending_actions')}: ${pendingActionCount}`}</span>
            </div>
          ) : null}
        </div>
        <div className={styles.inspectionOperationGrid}>
          <div className={styles.operationMainColumn}>
            <div className={styles.operationMainStack}>
              <Card className={styles.inspectionStatusCard}>
                <div className={styles.inspectionProgressHero}>
                  <div className={styles.progressRing} style={{ '--progress': `${Math.max(0, Math.min(100, progress.percent))}%` } as CSSProperties}>
                    <strong>{`${progress.percent}%`}</strong>
                  </div>
                  <div className={styles.inspectionStatusCopy}>
                    <strong>{operationPhase}</strong>
                    <span>{progress.percent >= 100 ? t('monitoring.account_inspection_phase_completed', { defaultValue: 'Inspection completed' }) : progressLabel}</span>
                    <small>{`${t('monitoring.last_sync')}: ${result?.finishedAt ? formatTimestamp(result.finishedAt, i18n.language) : '--'}`}</small>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={openSettingsModal}
                    disabled={(runStatus === 'running' || runStatus === 'paused') || executing}
                  >
                    {t('monitoring.account_inspection_settings_button')}
                  </Button>
                </div>
                <div className={styles.inspectionConfigGrid}>
                  <span>
                    <small>{t('monitoring.account_inspection_detection_scope', { defaultValue: 'Detection Scope' })}</small>
                    <strong>{inspectionScopeLabel}</strong>
                  </span>
                  <span>
                    <small>{t('monitoring.account_inspection_quota_threshold_short', { defaultValue: 'Quota Threshold' })}</small>
                    <strong>{`${inspectionSettings.usedPercentThreshold}%`}</strong>
                  </span>
                  <span>
                    <small>{t('monitoring.account_inspection_sample_size')}</small>
                    <strong>{inspectionSettings.sampleSize || t('monitoring.account_inspection_all_accounts', { defaultValue: 'All' })}</strong>
                  </span>
                  <span>
                    <small>{t('monitoring.account_inspection_scheduled_inspection_short', { defaultValue: 'Scheduled Inspection' })}</small>
                    <strong>{scheduleStatusLabel}</strong>
                  </span>
                  <span>
                    <small>{t('monitoring.account_inspection_quota_limit_disable_short', { defaultValue: 'Quota Limit Disable' })}</small>
                    <strong>{quotaLimitAutoLabel}</strong>
                  </span>
                  <span>
                    <small>{t('monitoring.account_inspection_quota_recovery_enable_short', { defaultValue: 'Quota Recovery Enable' })}</small>
                    <strong>{quotaRecoveryAutoLabel}</strong>
                  </span>
                  <span>
                    <small>{t('monitoring.account_inspection_account_error_action_short', { defaultValue: 'Account Error Action' })}</small>
                    <strong>{accountErrorActionLabel}</strong>
                  </span>
                  <span>
                    <small>{t('monitoring.account_inspection_next_execution_short', { defaultValue: 'Next Execution' })}</small>
                    <strong>{scheduleResponse?.schedule.enabled && scheduleResponse.schedule.nextRunAt ? formatTimestamp(scheduleResponse.schedule.nextRunAt, i18n.language) : '--'}</strong>
                  </span>
                </div>
              </Card>

              <Card className={styles.inspectionControlCard}>
                <h3>{t('monitoring.account_inspection_control_title')}</h3>
                <div className={styles.inspectionControlActions}>
                  <Button
                    variant="primary"
                    onClick={handleRunInspection}
                    loading={runStatus === 'running'}
                    disabled={runStatus === 'running' || executing || connectionStatus !== 'connected'}
                  >
                    {formatRunInspectionButtonLabel(runStatus, t)}
                  </Button>
                  <Button variant="secondary" onClick={handlePauseInspection} disabled={runStatus !== 'running' || executing}>
                    {t('monitoring.account_inspection_pause')}
                  </Button>
                  <Button variant="danger" onClick={handleStopInspection} disabled={(runStatus !== 'running' && runStatus !== 'paused') || executing}>
                    {t('monitoring.account_inspection_stop')}
                  </Button>
                </div>
              </Card>
            </div>
          </div>

          <Card className={styles.actionStudioCard}>
            <div className={styles.resultOverviewSection}>
              <h3>{t('monitoring.account_inspection_inspection_summary_title')}</h3>
              <div className={styles.resultOverviewGrid}>
                <span className={styles.resultOverviewGood}>
                  <small>{t('monitoring.account_inspection_auto_processed_count', { defaultValue: 'Auto processed' })}</small>
                  <strong>{actionStats.autoTotal}</strong>
                </span>
                <span className={styles.resultOverviewWarn}>
                  <small>{t('monitoring.account_inspection_manual_pending_count', { defaultValue: 'Manual pending' })}</small>
                  <strong>{actionStats.manualTotal}</strong>
                </span>
                <span>
                  <small>{t('monitoring.account_inspection_keep_count')}</small>
                  <strong>{actionStats.keep}</strong>
                </span>
                <span className={styles.resultOverviewBad}>
                  <small>{t('monitoring.account_inspection_error_count', { defaultValue: 'Errors' })}</small>
                  <strong>{actionStats.error}</strong>
                </span>
              </div>
            </div>

            {hasAutoExecutionPolicy ? (
              <div className={styles.strategyResultSection}>
                <div className={styles.strategySectionHeader}>
                  <h3>{t('monitoring.account_inspection_auto_execution_breakdown', { defaultValue: 'Automatic policy execution' })}</h3>
                  <button type="button" onClick={() => showInspectionResults('processed')}>{t('monitoring.view_all', { defaultValue: 'View All' })}</button>
                </div>
                <div className={styles.strategyTotalsRow}>
                  <span>{`${t('monitoring.account_inspection_action_enable')} ${actionStats.autoEnable}`}</span>
                  <span>{`${t('monitoring.account_inspection_action_disable')} ${actionStats.autoDisable}`}</span>
                  <span>{`${t('monitoring.account_inspection_action_delete')} ${actionStats.autoDelete}`}</span>
                  <span>{`${t('monitoring.account_inspection_action_keep')} ${actionStats.keep}`}</span>
                </div>
                <div className={styles.strategyActivityRow}>
                  <span className={styles.strategyActivityIcon} aria-hidden="true" />
                  <span>{result?.finishedAt ? formatTimestamp(result.finishedAt, i18n.language) : '--'}</span>
                  <strong>{autoExecutionResultLabel}</strong>
                </div>
              </div>
            ) : (
              <div className={styles.manualPendingSection}>
                <h3>{`${t('monitoring.account_inspection_manual_execution_breakdown', { defaultValue: 'Manual review queue' })} (${actionStats.manualTotal})`}</h3>
                {actionStats.manualTotal > 0 ? (
                  <div className={styles.manualPendingList}>
                    <span>{`${t('monitoring.account_inspection_action_delete')}: ${actionStats.manualDelete}`}</span>
                    <span>{`${t('monitoring.account_inspection_action_disable')}: ${actionStats.manualDisable}`}</span>
                    <span>{`${t('monitoring.account_inspection_action_enable')}: ${actionStats.manualEnable}`}</span>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={handleExecutePlanned}
                      loading={executing}
                      disabled={!result || runStatus === 'running' || executing || pendingActionCount === 0}
                    >
                      {executing ? t('monitoring.account_inspection_executing') : t('monitoring.account_inspection_execute_now')}
                    </Button>
                  </div>
                ) : (
                  <div className={styles.manualPendingEmpty}>
                    <span aria-hidden="true">✓</span>
                    <strong>{t('monitoring.account_inspection_no_pending_actions')}</strong>
                    <small>{t('monitoring.account_inspection_auto_execute_no_actions')}</small>
                  </div>
                )}
              </div>
            )}
          </Card>
        </div>
      </section>

      <div ref={resultsPanelRef}>
        <Card className={styles.panel}>
        <div className={styles.panelHeader}>
          <div>
            <h2 className={styles.panelTitle}>{t('monitoring.account_inspection_results_title')}</h2>
            <p className={styles.panelSubtitle}>{t('monitoring.account_inspection_results_desc')}</p>
          </div>
        </div>

        {result ? (
          <>
            <div className={styles.filterTabs}>
              {resultFilterTabs.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  className={[styles.filterTab, resultFilterWithFallback === tab.key ? styles.filterTabActive : '']
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => setResultFilter(tab.key)}
                >
                  <span>{tab.label}</span>
                  <strong>{tab.count}</strong>
                </button>
              ))}
            </div>

            <div className={styles.resultCards}>
              {filteredResults.length > 0 ? filteredResults.map((item) => {
                const healthStatus = resolveResultHealthStatus(item);
                const manualActions = getManualActions(item);
                return (
                  <article key={item.key} className={styles.resultCard}>
                    <div className={styles.resultCardHeader}>
                      <div className={styles.primaryCell}>
                        <span>{item.fileName}</span>
                        <small>{item.provider}</small>
                      </div>
                      <span className={`${styles.healthBadge} ${healthToneClass[healthStatus]}`}>{t(healthLabelKey[healthStatus])}</span>
                    </div>
                    <div className={styles.resultCardGrid}>
                      <span>{t('monitoring.account_inspection_current_state')}</span><strong>{formatCurrentStateLabel(item, t)}</strong>
                      <span>{t('monitoring.account_inspection_http_status')}</span><strong>{item.statusCode === null ? '--' : item.statusCode}</strong>
                      <span>{t('monitoring.account_inspection_used_percent')}</span><strong>{formatPercent(item.usedPercent)}</strong>
                      <span>{t('monitoring.account_inspection_next_action')}</span><strong>{formatActionLabel(item.action, t)}</strong>
                    </div>
                    <p>{item.actionReason}</p>
                    {item.error ? <p className={styles.errorText}>{item.error}</p> : null}
                    <div className={styles.operationActions}>
                      <Button size="sm" variant="secondary" onClick={() => void handleRecheckSingle(item)} loading={recheckingKey === item.key} disabled={runStatus === 'running' || executing || recheckingKey !== null}>
                        {t('monitoring.account_inspection_recheck_account', { defaultValue: 'Recheck' })}
                      </Button>
                      {manualActions.length > 0 ? manualActions.map((action) => (
                        <Button key={action} size="sm" variant={action === 'delete' ? 'danger' : 'secondary'} onClick={() => handleExecuteSingle(item, action)} disabled={runStatus === 'running' || executing || recheckingKey !== null}>
                          {formatActionLabel(action, t)}
                        </Button>
                      )) : null}
                    </div>
                  </article>
                );
              }) : <div className={styles.emptyBlockSmall}>{t('monitoring.account_inspection_no_filtered_results')}</div>}
            </div>

            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <colgroup>
                  <col className={styles.accountColumn} />
                  <col className={styles.healthColumn} />
                  <col className={styles.stateColumn} />
                  <col className={styles.httpColumn} />
                  <col className={styles.usageColumn} />
                  <col className={styles.actionColumn} />
                  <col className={styles.reasonColumn} />
                  <col className={styles.errorColumn} />
                  <col className={styles.operationColumn} />
                </colgroup>
                <thead>
                  <tr>
                    <th>{t('monitoring.account_label')}</th>
                    <th>{t('monitoring.account_inspection_health_status')}</th>
                    <th>{t('monitoring.account_inspection_current_state')}</th>
                    <th>{t('monitoring.account_inspection_http_status')}</th>
                    <th>{t('monitoring.account_inspection_used_percent')}</th>
                    <th>{t('monitoring.account_inspection_next_action')}</th>
                    <th>{t('monitoring.account_inspection_reason')}</th>
                    <th>{t('monitoring.account_inspection_error')}</th>
                    <th>{t('common.action')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredResults.length > 0 ? (
                    filteredResults.map((item) => {
                      const healthStatus = resolveResultHealthStatus(item);
                      const manualActions = getManualActions(item);
                      return (
                        <tr key={item.key}>
                          <td><div className={styles.primaryCell}><span>{item.fileName}</span><small>{item.provider}</small></div></td>
                          <td><span className={`${styles.healthBadge} ${healthToneClass[healthStatus]}`}>{t(healthLabelKey[healthStatus])}</span></td>
                          <td>{formatCurrentStateLabel(item, t)}</td>
                          <td>{item.statusCode === null ? '--' : item.statusCode}</td>
                          <td>{formatPercent(item.usedPercent)}</td>
                          <td><span className={`${styles.actionBadge} ${actionToneClass[item.action]}`}>{formatActionLabel(item.action, t)}</span></td>
                          <td>{item.actionReason}</td>
                          <td className={item.error ? styles.errorText : styles.mutedText}>{item.error || '--'}</td>
                          <td>
                            <div className={styles.operationActions}>
                              <Button size="sm" variant="secondary" onClick={() => void handleRecheckSingle(item)} loading={recheckingKey === item.key} disabled={runStatus === 'running' || executing || recheckingKey !== null}>
                                {t('monitoring.account_inspection_recheck_account', { defaultValue: 'Recheck' })}
                              </Button>
                              {manualActions.map((action) => (
                                <Button key={action} size="sm" variant={action === 'delete' ? 'danger' : 'secondary'} onClick={() => handleExecuteSingle(item, action)} disabled={runStatus === 'running' || executing || recheckingKey !== null}>
                                  {formatActionLabel(action, t)}
                                </Button>
                              ))}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr><td colSpan={9}><div className={styles.emptyBlockSmall}>{t('monitoring.account_inspection_no_filtered_results')}</div></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className={styles.emptyState}>
            <strong>{resultEmptyMessage}</strong>
            <span>{connectionStatus === 'connected' ? t('monitoring.account_inspection_empty_hint', { defaultValue: 'Start an inspection to generate account health and suggested actions.' }) : t('notification.connection_required')}</span>
            <Button variant="primary" onClick={handleRunInspection} disabled={connectionStatus !== 'connected'}>
              {t('monitoring.account_inspection_run')}
            </Button>
          </div>
        )}
        </Card>
      </div>

      <Card className={styles.panel}>
        <div className={styles.panelHeader}>
          <div>
            <h2 className={styles.panelTitle}>{t('monitoring.account_inspection_logs_title')}</h2>
            <p className={styles.panelSubtitle}>{t('monitoring.account_inspection_logs_desc')}</p>
          </div>
          <div className={styles.panelActions}>
            <div className={styles.logLevelTabs}>
              {logLevelOptions.map((option) => (
                <button key={option.key} type="button" className={[styles.logLevelTab, logLevelFilter === option.key ? styles.logLevelTabActive : ''].filter(Boolean).join(' ')} onClick={() => setLogLevelFilter(option.key)}>
                  {option.label}
                </button>
              ))}
            </div>
            <button type="button" className={styles.foldButton} onClick={() => setLogsCollapsed((previous) => !previous)} disabled={logs.length === 0}>
              {logsCollapsed ? <IconChevronDown size={16} /> : <IconChevronUp size={16} />}
              <span>{logsCollapsed ? t('monitoring.account_inspection_expand_logs') : t('monitoring.account_inspection_fold_logs')}</span>
            </button>
          </div>
        </div>

        {!logsCollapsed ? (
          <div ref={logListRef} className={styles.logList}>
            {filteredLogs.length > 0 ? filteredLogs.map((entry) => (
              <div key={entry.id} className={`${styles.logRow} ${levelClassMap[entry.level]}`}>
                <span className={styles.logTime}>{formatTimestamp(entry.timestamp, i18n.language)}</span>
                <span className={styles.logMessage}>{entry.message}</span>
              </div>
            )) : <div className={styles.emptyBlock}>{t('monitoring.account_inspection_logs_empty')}</div>}
          </div>
        ) : (
          <div className={styles.logCollapsedBar}><span>{t('monitoring.account_inspection_logs_collapsed', { count: filteredLogs.length })}</span></div>
        )}
      </Card>

      <Modal
        open={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        title={t('monitoring.account_inspection_settings_title')}
        width={920}
        className={styles.settingsModal}
      >
        <div className={styles.settingsIntro}>
          <strong>{t('monitoring.account_inspection_settings_title')}</strong>
          <span>{t('monitoring.account_inspection_settings_desc')}</span>
        </div>

        <section className={styles.settingsSection}>
          <div className={styles.settingsSectionHeader}>
            <div>
              <strong>{t('monitoring.account_inspection_schedule_section_title')}</strong>
              <span>{t('monitoring.account_inspection_schedule_section_desc')}</span>
            </div>
            <ToggleSwitch
              checked={scheduleDraft.enabled}
              onChange={(value) => dispatchBackendState({ type: 'updateScheduleDraft', values: { enabled: value } })}
              ariaLabel={t('monitoring.account_inspection_schedule_enabled_label')}
            />
          </div>
          <div className={styles.settingsGrid}>
            <div className={styles.settingsField}>
              <Input
                label={t('monitoring.account_inspection_schedule_interval_label')}
                type="number"
                value={scheduleDraft.intervalMinutes}
                onChange={(event) => dispatchBackendState({ type: 'updateScheduleDraft', values: { intervalMinutes: event.target.value } })}
                min={SCHEDULE_INTERVAL_LIMITS.min}
                step={1}
              />
              <div className={styles.settingsHint}>{t('monitoring.account_inspection_schedule_interval_hint')}</div>
            </div>
            <div className={styles.settingsFieldWide}>
              <div className={styles.settingsHint}>
                {`${t('monitoring.account_inspection_schedule_next_run')}: ${
                  scheduleResponse?.schedule.nextRunAt ? formatTimestamp(scheduleResponse.schedule.nextRunAt, i18n.language) : '--'
                }`}
              </div>
            </div>
          </div>
        </section>

        <section className={styles.settingsSection}>
          <div className={styles.settingsSectionHeader}>
            <div>
              <strong>{t('monitoring.account_inspection_settings_basic_section_title')}</strong>
              <span>{t('monitoring.account_inspection_settings_basic_section_desc')}</span>
            </div>
          </div>
          <div className={styles.settingsGrid}>
            <div className={styles.settingsField}>
              <label className={styles.settingsLabel}>{t('monitoring.account_inspection_settings_target_type_label')}</label>
              <Select
                value={settingsDraft.targetType}
                options={INSPECTION_TARGET_OPTIONS}
                onChange={(value) => handleSettingsDraftChange('targetType', value)}
                ariaLabel={t('monitoring.account_inspection_settings_target_type_label')}
              />
              <div className={styles.settingsHint}>{t('monitoring.account_inspection_settings_target_type_hint')}</div>
            </div>
            <div className={styles.settingsField}>
              <Input
                label={t('monitoring.account_inspection_settings_workers_label')}
                hint={t('monitoring.account_inspection_settings_workers_hint', {
                  min: WORKER_LIMITS.min,
                  max: WORKER_LIMITS.max,
                })}
                type="number"
                value={settingsDraft.workers}
                onChange={(event) => handleSettingsDraftChange('workers', event.target.value)}
                min={WORKER_LIMITS.min}
                max={WORKER_LIMITS.max}
                step={1}
              />
            </div>
            <div className={styles.settingsField}>
              <Input
                label={t('monitoring.account_inspection_settings_delete_workers_label')}
                hint={t('monitoring.account_inspection_settings_delete_workers_hint', {
                  min: DELETE_WORKER_LIMITS.min,
                  max: DELETE_WORKER_LIMITS.max,
                })}
                type="number"
                value={settingsDraft.deleteWorkers}
                onChange={(event) => handleSettingsDraftChange('deleteWorkers', event.target.value)}
                min={DELETE_WORKER_LIMITS.min}
                max={DELETE_WORKER_LIMITS.max}
                step={1}
              />
            </div>
            <div className={styles.settingsField}>
              <Input
                label={t('monitoring.account_inspection_settings_timeout_label')}
                hint={t('monitoring.account_inspection_settings_timeout_hint', {
                  min: TIMEOUT_LIMITS.min,
                  max: TIMEOUT_LIMITS.max,
                })}
                type="number"
                value={settingsDraft.timeout}
                onChange={(event) => handleSettingsDraftChange('timeout', event.target.value)}
                min={TIMEOUT_LIMITS.min}
                max={TIMEOUT_LIMITS.max}
                step={TIMEOUT_LIMITS.step}
              />
            </div>
            <div className={styles.settingsField}>
              <Input
                label={t('monitoring.account_inspection_settings_retries_label')}
                hint={t('monitoring.account_inspection_settings_retries_hint', {
                  min: RETRY_LIMITS.min,
                  max: RETRY_LIMITS.max,
                })}
                type="number"
                value={settingsDraft.retries}
                onChange={(event) => handleSettingsDraftChange('retries', event.target.value)}
                min={RETRY_LIMITS.min}
                max={RETRY_LIMITS.max}
                step={1}
              />
            </div>
            <div className={styles.settingsField}>
              <Input
                label={t('monitoring.account_inspection_settings_used_percent_threshold_label')}
                hint={t('monitoring.account_inspection_settings_threshold_hint')}
                type="number"
                value={settingsDraft.usedPercentThreshold}
                onChange={(event) => handleSettingsDraftChange('usedPercentThreshold', event.target.value)}
                min={THRESHOLD_LIMITS.min}
                max={THRESHOLD_LIMITS.max}
                step={0.1}
              />
            </div>
            <div className={styles.settingsField}>
              <Input
                label={t('monitoring.account_inspection_settings_sample_size_label')}
                hint={t('monitoring.account_inspection_settings_sample_size_hint')}
                type="number"
                value={settingsDraft.sampleSize}
                onChange={(event) => handleSettingsDraftChange('sampleSize', event.target.value)}
                min={SAMPLE_SIZE_LIMITS.min}
                step={1}
              />
            </div>
          </div>
        </section>

        <section className={styles.settingsSection}>
          <div className={styles.settingsSectionHeader}>
            <div>
              <strong>{t('monitoring.account_inspection_settings_auto_section_title')}</strong>
              <span>{t('monitoring.account_inspection_settings_auto_section_desc')}</span>
            </div>
          </div>
          <div className={styles.settingsPolicyGrid}>
            <div className={styles.settingsPolicyCard}>
              <div className={styles.settingsPolicyControl}>
                <ToggleSwitch
                  checked={settingsDraft.autoExecuteQuotaLimitDisable}
                  onChange={handleAutoExecuteQuotaLimitChange}
                  label={t('monitoring.account_inspection_settings_auto_execute_quota_limit_disable_label')}
                  ariaLabel={t('monitoring.account_inspection_settings_auto_execute_quota_limit_disable_label')}
                  labelPosition="left"
                />
              </div>
              <span className={styles.settingsHint}>
                {t('monitoring.account_inspection_settings_auto_execute_quota_limit_disable_hint')}
              </span>
            </div>
            <div className={styles.settingsPolicyCard}>
              <div className={styles.settingsPolicyControl}>
                <ToggleSwitch
                  checked={settingsDraft.autoExecuteQuotaRecoveryEnable}
                  onChange={handleAutoExecuteQuotaRecoveryChange}
                  label={t('monitoring.account_inspection_settings_auto_execute_quota_recovery_enable_label')}
                  ariaLabel={t('monitoring.account_inspection_settings_auto_execute_quota_recovery_enable_label')}
                  labelPosition="left"
                />
              </div>
              <span className={styles.settingsHint}>
                {t('monitoring.account_inspection_settings_auto_execute_quota_recovery_enable_hint')}
              </span>
            </div>
            <div className={styles.settingsPolicyCard}>
              <label className={styles.settingsLabel}>
                {t('monitoring.account_inspection_settings_auto_execute_account_error_action_label')}
              </label>
              <Select
                value={settingsDraft.autoExecuteAccountErrorAction}
                options={AUTO_ERROR_ACTION_OPTIONS.map((option) => ({
                  value: option.value,
                  label: t(option.labelKey),
                }))}
                onChange={handleAutoExecuteAccountErrorActionChange}
                ariaLabel={t('monitoring.account_inspection_settings_auto_execute_account_error_action_label')}
              />
              <span className={styles.settingsHint}>
                {t('monitoring.account_inspection_settings_auto_execute_account_error_action_hint')}
              </span>
            </div>
          </div>
        </section>

        <div className={styles.settingsActionsBar}>
          <Button variant="secondary" onClick={handleResetSettings}>
            {t('monitoring.account_inspection_settings_reset_button')}
          </Button>
          <Button variant="secondary" onClick={() => setIsSettingsModalOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void handleSaveSettings()} loading={scheduleLoading}>
            {t('common.save')}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
