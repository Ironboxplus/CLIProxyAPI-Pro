import type { Config, AuthFileItem } from '@/types';
import { isDisabledAuthFile, normalizeNumberValue, resolveAuthProvider, resolveCodexChatgptAccountId } from '@/utils/quota';
import { normalizeAuthIndex } from '@/utils/usage';

export type AccountInspectionLogLevel = 'info' | 'success' | 'warning' | 'error';
export type AccountInspectionAction = 'keep' | 'delete' | 'disable' | 'enable';
export type AccountInspectionExecutionAction = Exclude<AccountInspectionAction, 'keep'>;
export type AccountInspectionProgressStatus = 'idle' | 'running' | 'paused' | 'stopped' | 'completed';
export type AccountInspectionAutoErrorAction = 'none' | 'disable' | 'delete';

export interface AccountInspectionSettings {
  baseUrl: string;
  token: string;
  targetType: string;
  workers: number;
  deleteWorkers: number;
  timeout: number;
  retries: number;
  usedPercentThreshold: number;
  sampleSize: number;
}

export interface AccountInspectionConfigurableSettings {
  targetType: string;
  workers: number;
  deleteWorkers: number;
  timeout: number;
  retries: number;
  usedPercentThreshold: number;
  sampleSize: number;
  autoExecuteQuotaLimitDisable: boolean;
  autoExecuteQuotaRecoveryEnable: boolean;
  autoExecuteAccountErrorAction: AccountInspectionAutoErrorAction;
}

export interface AccountInspectionAccount {
  key: string;
  fileName: string;
  displayAccount: string;
  email?: string;
  name?: string;
  authIndex: string | null;
  accountId: string | null;
  provider: string;
  disabled: boolean;
  status: string;
  state: string;
  raw: AuthFileItem;
}

export interface AccountInspectionResultItem extends AccountInspectionAccount {
  action: AccountInspectionAction;
  actionReason: string;
  statusCode: number | null;
  usedPercent: number | null;
  isQuota: boolean;
  error: string;
}

export interface AccountInspectionSummary {
  totalFiles: number;
  probeSetCount: number;
  sampledCount: number;
  disabledCount: number;
  enabledCount: number;
  deleteCount: number;
  disableCount: number;
  enableCount: number;
  keepCount: number;
  errorCount: number;
  usedPercentThreshold: number;
  sampled: boolean;
  plannedActionPreview: string[];
}

export interface AccountInspectionProgressSummary {
  totalFiles: number;
  probeSetCount: number;
  sampledCount: number;
  disabledCount: number;
  enabledCount: number;
  deleteCount: number;
  disableCount: number;
  enableCount: number;
  keepCount: number;
  errorCount: number;
}

export interface AccountInspectionRunResult {
  settings: AccountInspectionSettings;
  files: AuthFileItem[];
  results: AccountInspectionResultItem[];
  summary: AccountInspectionSummary;
  startedAt: number;
  finishedAt: number;
}

export interface AccountInspectionProgressSnapshot {
  total: number;
  completed: number;
  inFlight: number;
  pending: number;
  percent: number;
  status: AccountInspectionProgressStatus;
  summary: AccountInspectionProgressSummary;
  startedAt: number;
  updatedAt: number;
}

export interface AccountInspectionExecutionOutcome {
  action: AccountInspectionExecutionAction;
  fileName: string;
  displayAccount: string;
  email?: string;
  name?: string;
  provider: string;
  authIndex: string | null;
  success: boolean;
  error: string;
}

export interface AccountInspectionExecutionResult {
  outcomes: AccountInspectionExecutionOutcome[];
  refreshedFiles: AuthFileItem[];
  refreshError: string;
}

const ALL_INSPECTION_PROVIDER_TYPE = 'all';

export const ACCOUNT_INSPECTION_SETTING_LIMITS = {
  workers: { min: 1, max: 8 },
  deleteWorkers: { min: 1, max: 4 },
  timeout: { min: 3000, max: 30000, step: 1000 },
  retries: { min: 0, max: 1 },
  usedPercentThreshold: { min: 0, max: 100 },
  sampleSize: { min: 0 },
  scheduleIntervalMinutes: { min: 1 },
} as const;

export const ACCOUNT_INSPECTION_SETTINGS_STORAGE_KEY = 'cli-proxy-account-inspection-settings-v1';

export const DEFAULT_ACCOUNT_INSPECTION_SETTINGS: AccountInspectionConfigurableSettings = {
  targetType: ALL_INSPECTION_PROVIDER_TYPE,
  workers: 4,
  deleteWorkers: 4,
  timeout: 15000,
  retries: 0,
  usedPercentThreshold: 100,
  sampleSize: 0,
  autoExecuteQuotaLimitDisable: false,
  autoExecuteQuotaRecoveryEnable: false,
  autoExecuteAccountErrorAction: 'none',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type IntegerBounds = {
  min: number;
  max?: number;
};

type ClampIntegerOptions = {
  clampBelowMin?: boolean;
};

const clampInteger = (
  value: number | undefined | null,
  fallback: number,
  bounds: IntegerBounds,
  options: ClampIntegerOptions = {}
) => {
  if (!Number.isFinite(value) || value === undefined || value === null) return fallback;
  const integer = Math.floor(value);
  if (integer < bounds.min) return options.clampBelowMin ? bounds.min : fallback;
  return Math.min(bounds.max ?? integer, integer);
};

const normalizeThreshold = (value: number | undefined) => {
  if (!Number.isFinite(value) || value === undefined || value < 0) return NaN;
  if (value > 0 && value <= 1) {
    return value * 100;
  }
  return value;
};

const readString = (value: unknown) => {
  if (value === undefined || value === null) return '';
  return String(value).trim();
};

const readBoolean = (value: unknown, fallback: boolean) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
};

const normalizeAutoErrorAction = (value: unknown): AccountInspectionAutoErrorAction => {
  const normalized = readString(value).toLowerCase();
  return normalized === 'disable' || normalized === 'delete' ? normalized : 'none';
};

export const formatAccountInspectionIdentity = (
  item: Pick<AccountInspectionAccount, 'displayAccount' | 'email' | 'name' | 'fileName'>
) => {
  const label = item.email || item.name || item.displayAccount;
  if (label && label !== '-') {
    return item.fileName ? `${label}[${item.fileName}]` : label;
  }
  return item.fileName;
};

const readAuthFileName = (file: AuthFileItem) => {
  const name = readString(file.name);
  if (name) return name;
  const id = readString(file.id);
  if (id) return id;
  const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
  return authIndex || 'unknown-auth-file';
};

const readAuthEmail = (file: AuthFileItem) => {
  const idToken = file.id_token;
  return readString(file.email) ||
    (typeof idToken === 'object' && idToken !== null ? readString((idToken as Record<string, unknown>).email) : '');
};

const readDisplayAccount = (file: AuthFileItem) =>
  readAuthEmail(file) ||
  readString(file.name) ||
  '-';

const toInspectionAccount = (file: AuthFileItem): AccountInspectionAccount => ({
  key: `${readAuthFileName(file)}::${normalizeAuthIndex(file['auth_index'] ?? file.authIndex) || '-'}`,
  fileName: readAuthFileName(file),
  displayAccount: readDisplayAccount(file),
  email: readAuthEmail(file) || undefined,
  name: readString(file.name) || undefined,
  authIndex: normalizeAuthIndex(file['auth_index'] ?? file.authIndex),
  accountId: resolveCodexChatgptAccountId(file),
  provider: resolveAuthProvider(file),
  disabled: isDisabledAuthFile(file),
  status: readString(file.status),
  state: readString(file.state),
  raw: file,
});

const readConfigurableSettingsFromConfig = (
  config?: Config | null
): Partial<AccountInspectionConfigurableSettings> => {
  const clean = config?.clean ?? null;
  return {
    targetType: readString(clean?.targetType),
    workers: normalizeNumberValue(clean?.workers) ?? undefined,
    deleteWorkers: normalizeNumberValue(clean?.deleteWorkers) ?? undefined,
    timeout: normalizeNumberValue(clean?.timeout) ?? undefined,
    retries: normalizeNumberValue(clean?.retries) ?? undefined,
    usedPercentThreshold: normalizeNumberValue(clean?.usedPercentThreshold) ?? undefined,
    sampleSize: normalizeNumberValue(clean?.sampleSize) ?? undefined,
    autoExecuteQuotaLimitDisable: undefined,
    autoExecuteQuotaRecoveryEnable: undefined,
    autoExecuteAccountErrorAction: undefined,
  };
};

const normalizeConfigurableSettings = (
  input?: Partial<AccountInspectionConfigurableSettings> | null
): AccountInspectionConfigurableSettings => {
  const merged = {
    ...DEFAULT_ACCOUNT_INSPECTION_SETTINGS,
    ...(input ?? {}),
  };

  const threshold = normalizeThreshold(merged.usedPercentThreshold);
  const workers = clampInteger(
    normalizeNumberValue(merged.workers),
    DEFAULT_ACCOUNT_INSPECTION_SETTINGS.workers,
    ACCOUNT_INSPECTION_SETTING_LIMITS.workers
  );

  return {
    targetType: readString(merged.targetType).toLowerCase() || DEFAULT_ACCOUNT_INSPECTION_SETTINGS.targetType,
    workers,
    deleteWorkers: clampInteger(
      normalizeNumberValue(merged.deleteWorkers),
      workers,
      ACCOUNT_INSPECTION_SETTING_LIMITS.deleteWorkers
    ),
    timeout: clampInteger(
      normalizeNumberValue(merged.timeout),
      DEFAULT_ACCOUNT_INSPECTION_SETTINGS.timeout,
      ACCOUNT_INSPECTION_SETTING_LIMITS.timeout,
      { clampBelowMin: true }
    ),
    retries: clampInteger(
      normalizeNumberValue(merged.retries),
      DEFAULT_ACCOUNT_INSPECTION_SETTINGS.retries,
      ACCOUNT_INSPECTION_SETTING_LIMITS.retries
    ),
    usedPercentThreshold: Number.isFinite(threshold)
      ? Math.max(
          ACCOUNT_INSPECTION_SETTING_LIMITS.usedPercentThreshold.min,
          Math.min(ACCOUNT_INSPECTION_SETTING_LIMITS.usedPercentThreshold.max, threshold)
        )
      : DEFAULT_ACCOUNT_INSPECTION_SETTINGS.usedPercentThreshold,
    sampleSize: clampInteger(
      normalizeNumberValue(merged.sampleSize),
      DEFAULT_ACCOUNT_INSPECTION_SETTINGS.sampleSize,
      ACCOUNT_INSPECTION_SETTING_LIMITS.sampleSize
    ),
    autoExecuteQuotaLimitDisable: readBoolean(
      merged.autoExecuteQuotaLimitDisable,
      DEFAULT_ACCOUNT_INSPECTION_SETTINGS.autoExecuteQuotaLimitDisable
    ),
    autoExecuteQuotaRecoveryEnable: readBoolean(
      merged.autoExecuteQuotaRecoveryEnable,
      DEFAULT_ACCOUNT_INSPECTION_SETTINGS.autoExecuteQuotaRecoveryEnable
    ),
    autoExecuteAccountErrorAction: normalizeAutoErrorAction(merged.autoExecuteAccountErrorAction),
  };
};

export const loadAccountInspectionConfigurableSettings = (
  config?: Config | null
): AccountInspectionConfigurableSettings => {
  const configSettings = readConfigurableSettingsFromConfig(config);

  try {
    if (typeof localStorage === 'undefined') {
      return normalizeConfigurableSettings(configSettings);
    }
    const raw = localStorage.getItem(ACCOUNT_INSPECTION_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return normalizeConfigurableSettings(configSettings);
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return normalizeConfigurableSettings(configSettings);
    }
    return normalizeConfigurableSettings({
      ...configSettings,
      ...parsed,
    });
  } catch {
    return normalizeConfigurableSettings(configSettings);
  }
};

export const saveAccountInspectionConfigurableSettings = (
  settings: Partial<AccountInspectionConfigurableSettings>
): AccountInspectionConfigurableSettings => {
  const normalized = normalizeConfigurableSettings(settings);

  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(ACCOUNT_INSPECTION_SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
    }
  } catch {
    console.warn('保存 账号巡检配置失败');
  }

  return normalized;
};

export const clearAccountInspectionConfigurableSettings = () => {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(ACCOUNT_INSPECTION_SETTINGS_STORAGE_KEY);
    }
  } catch {
    console.warn('清除 账号巡检配置失败');
  }
};

const accountInspectionItemKey = (item: Pick<AccountInspectionAccount, 'fileName' | 'authIndex'>) =>
  `${item.fileName}::${item.authIndex ?? '-'}`;

const sortResults = (items: AccountInspectionResultItem[]) =>
  [...items].sort(
    (left, right) =>
      left.fileName.localeCompare(right.fileName) ||
      left.displayAccount.localeCompare(right.displayAccount) ||
      left.key.localeCompare(right.key)
  );

const summarizeResults = (results: AccountInspectionResultItem[]) => {
  const deleteCount = results.filter((item) => item.action === 'delete').length;
  const disableCount = results.filter((item) => item.action === 'disable').length;
  const enableCount = results.filter((item) => item.action === 'enable').length;
  const errorCount = results.filter((item) => item.error).length;
  return {
    deleteCount,
    disableCount,
    enableCount,
    keepCount: results.length - deleteCount - disableCount - enableCount,
    errorCount,
    plannedActionPreview: results
      .filter((item) => item.action !== 'keep')
      .slice(0, 10)
      .map((item) => `${formatAccountInspectionIdentity(item)} -> ${item.action}`),
  };
};

export const buildExecutionFailureMessage = (outcome: AccountInspectionExecutionOutcome) =>
  `${formatAccountInspectionIdentity(outcome)}：${outcome.error || '执行失败'}`;

export const isSuggestedAction = (item: AccountInspectionResultItem) => item.action !== 'keep';

export const hasAccountInspectionAutoExecutePolicies = (settings: AccountInspectionConfigurableSettings) =>
  settings.autoExecuteQuotaLimitDisable ||
  settings.autoExecuteQuotaRecoveryEnable ||
  settings.autoExecuteAccountErrorAction !== 'none';

export const applyAccountInspectionExecutionResult = (
  previousResult: AccountInspectionRunResult,
  execution: AccountInspectionExecutionResult
): AccountInspectionRunResult => {
  const successfulOutcomes = new Map(
    execution.outcomes.filter((item) => item.success).map((item) => [accountInspectionItemKey(item), item] as const)
  );
  const refreshedAccounts = new Map(
    execution.refreshedFiles.map((file) => {
      const account = toInspectionAccount(file);
      return [accountInspectionItemKey(account), account] as const;
    })
  );

  const nextResults = sortResults(
    previousResult.results.map((item) => {
      const refreshedAccount = refreshedAccounts.get(accountInspectionItemKey(item));
      const baseItem: AccountInspectionResultItem = refreshedAccount
        ? {
            ...item,
            ...refreshedAccount,
            raw: refreshedAccount.raw,
          }
        : item;
      const outcome = successfulOutcomes.get(accountInspectionItemKey(baseItem));

      if (!outcome) {
        return baseItem;
      }

      return {
        ...baseItem,
        disabled: outcome.action === 'disable' ? true : outcome.action === 'enable' ? false : baseItem.disabled,
        action: 'keep',
        actionReason: '无需处理',
        error: '',
      };
    })
  );

  const files = execution.refreshedFiles.length > 0 ? execution.refreshedFiles : previousResult.files;
  const summary = summarizeResults(nextResults);

  return {
    ...previousResult,
    files,
    results: nextResults,
    summary: {
      ...previousResult.summary,
      totalFiles: files.length || previousResult.summary.totalFiles,
      disabledCount: nextResults.filter((item) => item.disabled).length,
      enabledCount: nextResults.filter((item) => !item.disabled).length,
      ...summary,
    },
    finishedAt: Date.now(),
  };
};

export const buildSuggestedActionCountLabel = (summary: AccountInspectionSummary) =>
  summary.deleteCount + summary.disableCount + summary.enableCount;
