import type { AxiosRequestConfig } from 'axios';
import { ANTIGRAVITY_CONFIG, CLAUDE_CONFIG, CODEX_CONFIG, GEMINI_CLI_CONFIG, KIMI_CONFIG } from '@/components/quota/quotaConfigs';
import { authFilesApi } from '@/services/api/authFiles';
import { apiCallApi, getApiCallErrorMessage } from '@/services/api/apiCall';
import { useQuotaStore } from '@/stores';
import type {
  AntigravityQuotaState,
  AuthFileItem,
  ClaudeQuotaState,
  Config,
  CodexQuotaState,
  CodexQuotaWindow,
  CodexRateLimitInfo,
  CodexUsageWindow,
  GeminiCliQuotaState,
  KimiQuotaRow,
  KimiQuotaState,
} from '@/types';
import {
  CODEX_REQUEST_HEADERS,
  CODEX_USAGE_URL,
  isDisabledAuthFile,
  normalizeNumberValue,
  parseCodexUsagePayload,
  getStatusFromError,
  resolveAuthProvider,
  resolveCodexChatgptAccountId,
} from '@/utils/quota';
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
  usedPercentThreshold: number;
  sampled: boolean;
  plannedActionPreview: string[];
}

export interface AccountInspectionProgressSummary {
  totalFiles: number;
  probeSetCount: number;
  sampledCount: number;
  deleteCount: number;
  disableCount: number;
  enableCount: number;
  keepCount: number;
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

type LogHandler = (level: AccountInspectionLogLevel, message: string) => void;
type ProgressHandler = (progress: AccountInspectionProgressSnapshot) => void;

type InspectAccountsOptions = {
  config: Config | null;
  apiBase: string;
  managementKey: string;
  settings?: Partial<AccountInspectionConfigurableSettings> | null;
  onLog?: LogHandler;
  onProgress?: ProgressHandler;
};

type ExecuteAccountInspectionActionsOptions = {
  settings: AccountInspectionSettings;
  items: AccountInspectionResultItem[];
  previousFiles: AuthFileItem[];
  onLog?: LogHandler;
};

type CreateAccountInspectionSessionOptions = InspectAccountsOptions;

type AccountInspectionSessionPromiseState = {
  promise: Promise<AccountInspectionRunResult>;
  resolve: (value: AccountInspectionRunResult) => void;
  reject: (reason?: unknown) => void;
};

export interface AccountInspectionSession {
  id: string;
  start: () => Promise<AccountInspectionRunResult>;
  resume: () => void;
  pause: () => void;
  stop: () => void;
  getProgress: () => AccountInspectionProgressSnapshot;
}

const SUPPORTED_INSPECTION_PROVIDER_TYPES = ['antigravity', 'claude', 'codex', 'gemini-cli', 'kimi'] as const;
type SupportedInspectionProviderType = (typeof SUPPORTED_INSPECTION_PROVIDER_TYPES)[number];
const ALL_INSPECTION_PROVIDER_TYPE = 'all';
const SUPPORTED_INSPECTION_PROVIDER_SET = new Set<string>(SUPPORTED_INSPECTION_PROVIDER_TYPES);
const ACCOUNT_ERROR_STATUS_CODES = new Set([400, 401, 403, 404]);
const isAccountErrorStatus = (statusCode: number | null | undefined): statusCode is number =>
  statusCode !== null && statusCode !== undefined && ACCOUNT_ERROR_STATUS_CODES.has(statusCode);
const QUOTA_BODY_PATTERNS = ['quota exhausted', 'limit reached', 'payment_required'];
const FIVE_HOUR_WINDOW_SECONDS = 18000;
const WEEK_WINDOW_SECONDS = 604800;

export class AccountInspectionStoppedError extends Error {
  constructor(message: string = '巡检已停止') {
    super(message);
    this.name = 'AccountInspectionStoppedError';
  }
}

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

const createDeferred = (): AccountInspectionSessionPromiseState => {
  let resolve: ((value: AccountInspectionRunResult) => void) | null = null;
  let reject: ((reason?: unknown) => void) | null = null;

  const promise = new Promise<AccountInspectionRunResult>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return {
    promise,
    resolve: (value) => resolve?.(value),
    reject: (reason) => reject?.(reason),
  };
};

const clampPositiveInteger = (value: number | undefined, fallback: number) => {
  if (!Number.isFinite(value) || !value || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
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
  item: Pick<AccountInspectionAccount, 'displayAccount' | 'provider' | 'fileName' | 'authIndex'>
) => {
  const authIndex = item.authIndex ? ` · auth ${item.authIndex}` : '';
  return `${item.displayAccount} [${item.provider} · ${item.fileName}${authIndex}]`;
};

const readAuthFileName = (file: AuthFileItem) => {
  const name = readString(file.name);
  if (name) return name;
  const id = readString(file.id);
  if (id) return id;
  const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
  return authIndex || 'unknown-auth-file';
};

const readDisplayAccount = (file: AuthFileItem) =>
  readString(file.account) ||
  readString(file.email) ||
  readString(file.label) ||
  readString(file.name) ||
  readString(file.id) ||
  normalizeAuthIndex(file['auth_index'] ?? file.authIndex) ||
  '-';

const toInspectionAccount = (file: AuthFileItem): AccountInspectionAccount => ({
  key: `${readAuthFileName(file)}::${normalizeAuthIndex(file['auth_index'] ?? file.authIndex) || '-'}`,
  fileName: readAuthFileName(file),
  displayAccount: readDisplayAccount(file),
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
  const retriesValue = normalizeNumberValue(merged.retries);
  const sampleSizeValue = normalizeNumberValue(merged.sampleSize);

  return {
    targetType: readString(merged.targetType).toLowerCase() || DEFAULT_ACCOUNT_INSPECTION_SETTINGS.targetType,
    workers: clampPositiveInteger(normalizeNumberValue(merged.workers) ?? undefined, DEFAULT_ACCOUNT_INSPECTION_SETTINGS.workers),
    deleteWorkers: clampPositiveInteger(
      normalizeNumberValue(merged.deleteWorkers) ?? undefined,
      clampPositiveInteger(normalizeNumberValue(merged.workers) ?? undefined, DEFAULT_ACCOUNT_INSPECTION_SETTINGS.workers)
    ),
    timeout: clampPositiveInteger(normalizeNumberValue(merged.timeout) ?? undefined, DEFAULT_ACCOUNT_INSPECTION_SETTINGS.timeout),
    retries:
      retriesValue === null ? DEFAULT_ACCOUNT_INSPECTION_SETTINGS.retries : Math.max(0, Math.floor(retriesValue)),
    usedPercentThreshold: Number.isFinite(threshold)
      ? Math.max(0, Math.min(100, threshold))
      : DEFAULT_ACCOUNT_INSPECTION_SETTINGS.usedPercentThreshold,
    sampleSize:
      sampleSizeValue === null ? DEFAULT_ACCOUNT_INSPECTION_SETTINGS.sampleSize : Math.max(0, Math.floor(sampleSizeValue)),
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

const pickSample = <T,>(items: T[], sampleSize: number): T[] => {
  if (sampleSize <= 0 || sampleSize >= items.length) return [...items];

  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled.slice(0, sampleSize);
};

const withRetry = async <T,>(retries: number, task: () => Promise<T>): Promise<T> => {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
};

const runConcurrently = async <T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
  if (items.length === 0) return [];

  const size = clampPositiveInteger(limit, 1);
  const results = new Array<R>(items.length);
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await task(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(size, items.length) }, () => worker()));
  return results;
};

const getWindowUsedPercent = (window?: CodexUsageWindow | null) =>
  normalizeNumberValue(window?.used_percent ?? window?.usedPercent);

const getWindowSeconds = (window?: CodexUsageWindow | null) =>
  normalizeNumberValue(window?.limit_window_seconds ?? window?.limitWindowSeconds);

const getLimitWindows = (rateLimit?: CodexRateLimitInfo | null) => [
  rateLimit?.primary_window ?? rateLimit?.primaryWindow ?? null,
  rateLimit?.secondary_window ?? rateLimit?.secondaryWindow ?? null,
];

const pickClassifiedWindows = (
  rateLimit?: CodexRateLimitInfo | null
): { fiveHourWindow: CodexUsageWindow | null; weeklyWindow: CodexUsageWindow | null } => {
  const primaryWindow = rateLimit?.primary_window ?? rateLimit?.primaryWindow ?? null;
  const secondaryWindow = rateLimit?.secondary_window ?? rateLimit?.secondaryWindow ?? null;
  const rawWindows = [primaryWindow, secondaryWindow];

  let fiveHourWindow: CodexUsageWindow | null = null;
  let weeklyWindow: CodexUsageWindow | null = null;

  rawWindows.forEach((window) => {
    if (!window) return;
    const seconds = getWindowSeconds(window);
    if (seconds === FIVE_HOUR_WINDOW_SECONDS && !fiveHourWindow) {
      fiveHourWindow = window;
    } else if (seconds === WEEK_WINDOW_SECONDS && !weeklyWindow) {
      weeklyWindow = window;
    }
  });

  if (!fiveHourWindow) {
    fiveHourWindow = primaryWindow && primaryWindow !== weeklyWindow ? primaryWindow : null;
  }
  if (!weeklyWindow) {
    weeklyWindow = secondaryWindow && secondaryWindow !== fiveHourWindow ? secondaryWindow : null;
  }

  return { fiveHourWindow, weeklyWindow };
};

const deriveUsedPercent = (rateLimit?: CodexRateLimitInfo | null): number | null => {
  const values = getLimitWindows(rateLimit)
    .map((window) => getWindowUsedPercent(window))
    .filter((value): value is number => value !== null);
  if (!values.length) return null;
  return Math.max(...values);
};

const isRateLimitReached = (rateLimit?: CodexRateLimitInfo | null) => {
  if (!rateLimit) return false;
  if (rateLimit.allowed === false) return true;
  if (rateLimit.limit_reached === true || rateLimit.limitReached === true) return true;
  return getLimitWindows(rateLimit).some((window) => {
    const value = getWindowUsedPercent(window);
    return value !== null && value >= 100;
  });
};

type AccountInspectionDecision = Pick<
  AccountInspectionResultItem,
  'action' | 'actionReason' | 'usedPercent' | 'isQuota'
>;

type QuotaUsageSnapshot = {
  usedPercent: number | null;
  hasQuotaData: boolean;
};

type InspectionProviderAdapter = {
  inspect: (
    account: AccountInspectionAccount,
    settings: AccountInspectionSettings,
    onLog?: LogHandler
  ) => Promise<AccountInspectionResultItem>;
};

const isSupportedInspectionProvider = (provider: string): provider is SupportedInspectionProviderType =>
  SUPPORTED_INSPECTION_PROVIDER_SET.has(provider);

const shouldInspectProvider = (provider: string, targetType: string) =>
  targetType === ALL_INSPECTION_PROVIDER_TYPE
    ? isSupportedInspectionProvider(provider)
    : provider === targetType && isSupportedInspectionProvider(provider);

const getQuotaAction = (
  account: AccountInspectionAccount,
  snapshot: QuotaUsageSnapshot,
  threshold: number
): AccountInspectionDecision => {
  const overThreshold = snapshot.usedPercent !== null && snapshot.usedPercent >= threshold;

  if ((overThreshold || !snapshot.hasQuotaData) && account.disabled) {
    return {
      action: 'keep',
      actionReason: overThreshold ? '额度达到阈值，但账号已禁用' : '未获取到可判断额度，保留账号',
      usedPercent: snapshot.usedPercent,
      isQuota: overThreshold,
    };
  }

  if (overThreshold) {
    return {
      action: 'disable',
      actionReason: '额度达到阈值，建议禁用账号',
      usedPercent: snapshot.usedPercent,
      isQuota: true,
    };
  }

  if (!snapshot.hasQuotaData) {
    return {
      action: 'keep',
      actionReason: '未获取到可判断额度，保留账号',
      usedPercent: snapshot.usedPercent,
      isQuota: false,
    };
  }

  if (account.disabled) {
    return {
      action: 'enable',
      actionReason: '额度可用，建议重新启用账号',
      usedPercent: snapshot.usedPercent,
      isQuota: false,
    };
  }

  return {
    action: 'keep',
    actionReason: '额度可用，无需处理',
    usedPercent: snapshot.usedPercent,
    isQuota: false,
  };
};

const buildQuotaInspectionResult = (
  account: AccountInspectionAccount,
  providerLabel: string,
  decision: AccountInspectionDecision,
  onLog?: LogHandler
): AccountInspectionResultItem => {
  const level = decision.action === 'disable' ? 'warning' : decision.action === 'enable' ? 'success' : 'info';
  const percentText = decision.usedPercent === null ? '--' : `${decision.usedPercent.toFixed(1)}%`;
  onLog?.(level, `${formatAccountInspectionIdentity(account)} -> ${decision.action} (${providerLabel} · 已用 ${percentText})`);

  return {
    ...account,
    action: decision.action,
    actionReason: decision.actionReason,
    statusCode: null,
    usedPercent: decision.usedPercent,
    isQuota: decision.isQuota,
    error: '',
  };
};
const buildKeepResult = (
  account: AccountInspectionAccount,
  actionReason: string,
  error: string = '',
  statusCode: number | null = null,
  usedPercent: number | null = null,
  isQuota: boolean = false
): AccountInspectionResultItem => ({
  ...account,
  action: 'keep',
  actionReason,
  statusCode,
  usedPercent,
  isQuota,
  error,
});

const buildMissingAuthIndexResult = (account: AccountInspectionAccount, onLog?: LogHandler) => {
  onLog?.('warning', `${formatAccountInspectionIdentity(account)} 缺少 auth_index，跳过探测`);
  return buildKeepResult(account, '缺少 auth_index，保留账号', '缺少 auth_index');
};

const buildInspectionErrorResult = (account: AccountInspectionAccount, error: unknown, onLog?: LogHandler) => {
  const errorMessage = error instanceof Error ? error.message : String(error || '探测失败');
  onLog?.('warning', `${formatAccountInspectionIdentity(account)} 探测异常，保留账号：${errorMessage}`);
  return buildKeepResult(account, '探测异常，保留账号', errorMessage);
};

const resolveLegacyProbeAction = (
  account: AccountInspectionAccount,
  statusCode: number,
  usedPercent: number | null,
  isQuota: boolean,
  threshold: number
): AccountInspectionDecision => {
  const overThreshold = usedPercent !== null && usedPercent >= threshold;
  if (isAccountErrorStatus(statusCode)) {
    return {
      action: statusCode === 401 ? 'delete' : account.disabled ? 'keep' : 'disable',
      actionReason:
        statusCode === 401
          ? '接口返回 401，建议删除失效账号'
          : account.disabled
            ? `接口返回 ${statusCode}，但账号已禁用`
            : `接口返回 ${statusCode}，建议禁用账号`,
      usedPercent,
      isQuota: false,
    };
  }
  if (isQuota || overThreshold) {
    if (account.disabled) {
      return {
        action: 'keep',
        actionReason: overThreshold ? '额度超阈值，但账号已禁用' : '额度已耗尽，但账号已禁用',
        usedPercent,
        isQuota,
      };
    }
    return {
      action: 'disable',
      actionReason: overThreshold ? '额度超阈值，建议禁用账号' : '额度已耗尽，建议禁用账号',
      usedPercent,
      isQuota,
    };
  }
  if (statusCode === 200 && account.disabled) {
    return {
      action: 'enable',
      actionReason: '账号恢复健康，建议重新启用',
      usedPercent,
      isQuota: false,
    };
  }
  return {
    action: 'keep',
    actionReason: '无需处理',
    usedPercent,
    isQuota: false,
  };
};

const resolveWindowAwareProbeAction = (
  account: AccountInspectionAccount,
  statusCode: number,
  rateLimit: CodexRateLimitInfo | null,
  threshold: number
): AccountInspectionDecision | null => {
  if (!rateLimit) return null;

  const { fiveHourWindow, weeklyWindow } = pickClassifiedWindows(rateLimit);
  const weeklyUsedPercent = getWindowUsedPercent(weeklyWindow);
  if (!weeklyWindow || weeklyUsedPercent === null) return null;

  const fiveHourUsedPercent = getWindowUsedPercent(fiveHourWindow);
  const weeklyOverThreshold = weeklyUsedPercent >= threshold;
  const fiveHourOverThreshold = fiveHourUsedPercent !== null && fiveHourUsedPercent >= threshold;

  if (isAccountErrorStatus(statusCode)) {
    return {
      action: statusCode === 401 ? 'delete' : account.disabled ? 'keep' : 'disable',
      actionReason:
        statusCode === 401
          ? '接口返回 401，建议删除失效账号'
          : account.disabled
            ? `接口返回 ${statusCode}，但账号已禁用`
            : `接口返回 ${statusCode}，建议禁用账号`,
      usedPercent: weeklyUsedPercent,
      isQuota: false,
    };
  }

  if (weeklyOverThreshold) {
    if (account.disabled) {
      return {
        action: 'keep',
        actionReason: '周额度达到阈值，但账号已禁用',
        usedPercent: weeklyUsedPercent,
        isQuota: true,
      };
    }
    return {
      action: 'disable',
      actionReason: '周额度达到阈值，建议禁用账号',
      usedPercent: weeklyUsedPercent,
      isQuota: true,
    };
  }

  if (account.disabled) {
    return {
      action: 'enable',
      actionReason: fiveHourOverThreshold
        ? '5 小时额度达到阈值，但周额度仍可用，建议立即启用账号'
        : '周额度仍可用，建议立即启用账号',
      usedPercent: weeklyUsedPercent,
      isQuota: false,
    };
  }

  if (fiveHourOverThreshold) {
    return {
      action: 'keep',
      actionReason: '5 小时额度达到阈值，但周额度仍可用，暂不禁用账号',
      usedPercent: weeklyUsedPercent,
      isQuota: false,
    };
  }

  return {
    action: 'keep',
    actionReason: '周额度仍可用，无需处理',
    usedPercent: weeklyUsedPercent,
    isQuota: false,
  };
};

const resolveProbeAction = (
  account: AccountInspectionAccount,
  statusCode: number,
  rateLimit: CodexRateLimitInfo | null,
  usedPercent: number | null,
  isQuota: boolean,
  threshold: number
): AccountInspectionDecision => {
  const windowAwareDecision = resolveWindowAwareProbeAction(account, statusCode, rateLimit, threshold);
  if (windowAwareDecision) return windowAwareDecision;
  return resolveLegacyProbeAction(account, statusCode, usedPercent, isQuota, threshold);
};

const toCodexQuotaWindow = (window: CodexUsageWindow | null): CodexQuotaWindow | null => {
  if (!window) return null;
  return {
    ...window,
    usedPercent: normalizeNumberValue(window.used_percent ?? window.usedPercent),
  } as CodexQuotaWindow;
};

const persistCodexQuotaSnapshot = (account: AccountInspectionAccount, payload: ReturnType<typeof parseCodexUsagePayload>) => {
  if (!payload || !account.fileName || account.provider !== 'codex') return;
  const rateLimit = payload.rate_limit ?? payload.rateLimit ?? null;
  const windows = getLimitWindows(rateLimit)
    .map(toCodexQuotaWindow)
    .filter((window): window is CodexQuotaWindow => window !== null);
  if (windows.length === 0) return;
  const quotaState = CODEX_CONFIG.buildSuccessState({
    planType: payload.plan_type ?? payload.planType ?? null,
    windows,
  });
  useQuotaStore.getState().setCodexQuota((previous: Record<string, CodexQuotaState>) => ({
    ...previous,
    [account.fileName]: quotaState,
  }));
};

const inspectCodexAccount = async (
  account: AccountInspectionAccount,
  settings: AccountInspectionSettings,
  onLog?: LogHandler
): Promise<AccountInspectionResultItem> => {
  if (!account.authIndex) {
    return buildMissingAuthIndexResult(account, onLog);
  }

  const requestConfig: AxiosRequestConfig = settings.timeout > 0 ? { timeout: settings.timeout } : {};
  const headers = {
    ...CODEX_REQUEST_HEADERS,
    ...(account.accountId ? { 'Chatgpt-Account-Id': account.accountId } : {}),
  };

  try {
    const result = await withRetry(settings.retries, () =>
      apiCallApi.request(
        {
          authIndex: account.authIndex ?? undefined,
          method: 'GET',
          url: CODEX_USAGE_URL,
          header: headers,
        },
        requestConfig
      )
    );

    if (!result.hasStatusCode) {
      onLog?.('warning', `${formatAccountInspectionIdentity(account)} 探测未返回 status_code，保留账号`);
      return buildKeepResult(account, '探测响应缺少 status_code，保留账号', '响应缺少 status_code');
    }

    const payload = parseCodexUsagePayload(result.body ?? result.bodyText);
    persistCodexQuotaSnapshot(account, payload);
    const rateLimit = payload?.rate_limit ?? payload?.rateLimit ?? null;
    const usedPercent = deriveUsedPercent(rateLimit);
    const bodyText = result.bodyText.toLowerCase();
    const isQuota =
      result.statusCode === 402 ||
      QUOTA_BODY_PATTERNS.some((pattern) => bodyText.includes(pattern)) ||
      isRateLimitReached(rateLimit) ||
      (usedPercent !== null && usedPercent >= settings.usedPercentThreshold);
    const decision = resolveProbeAction(
      account,
      result.statusCode,
      rateLimit,
      usedPercent,
      isQuota,
      settings.usedPercentThreshold
    );

    const successLevel =
      decision.action === 'delete'
        ? 'error'
        : decision.action === 'disable'
          ? 'warning'
          : decision.action === 'enable'
            ? 'success'
            : 'info';
    const percentText = decision.usedPercent === null ? '--' : `${decision.usedPercent.toFixed(1)}%`;
    onLog?.(
      successLevel,
      `${formatAccountInspectionIdentity(account)} -> ${decision.action} (HTTP ${result.statusCode} · 已用 ${percentText})`
    );

    return {
      ...account,
      action: decision.action,
      actionReason: decision.actionReason,
      statusCode: result.statusCode,
      usedPercent: decision.usedPercent,
      isQuota: decision.isQuota,
      error: '',
    };
  } catch (error) {
    return buildInspectionErrorResult(account, error, onLog);
  }
};

const persistAntigravityQuotaSnapshot = (account: AccountInspectionAccount, groups: Parameters<typeof ANTIGRAVITY_CONFIG.buildSuccessState>[0]) => {
  if (!account.fileName || account.provider !== 'antigravity') return;
  const quotaState = ANTIGRAVITY_CONFIG.buildSuccessState(groups);
  useQuotaStore.getState().setAntigravityQuota((previous: Record<string, AntigravityQuotaState>) => ({
    ...previous,
    [account.fileName]: quotaState,
  }));
};

const getAntigravityUsedPercent = (groups: Parameters<typeof ANTIGRAVITY_CONFIG.buildSuccessState>[0]) => {
  const claudeGptGroup = groups.find((group) => group.id === 'claude-gpt');
  if (!claudeGptGroup) return null;
  const remainingFraction = normalizeNumberValue(claudeGptGroup.remainingFraction);
  if (remainingFraction === null) return null;
  return Math.max(0, Math.min(100, (1 - remainingFraction) * 100));
};

const getMaxUsedPercent = (values: Array<number | null>) => {
  const normalized = values.filter((value): value is number => value !== null);
  if (normalized.length === 0) return null;
  return Math.max(...normalized);
};

const getClaudeQuotaSnapshot = (data: Parameters<typeof CLAUDE_CONFIG.buildSuccessState>[0]): QuotaUsageSnapshot => {
  const usedPercent = getMaxUsedPercent(data.windows.map((window) => normalizeNumberValue(window.usedPercent)));
  return {
    usedPercent,
    hasQuotaData: data.windows.length > 0,
  };
};

const getGeminiCliQuotaSnapshot = (data: Parameters<typeof GEMINI_CLI_CONFIG.buildSuccessState>[0]): QuotaUsageSnapshot => {
  const usedPercent = getMaxUsedPercent(
    data.buckets.map((bucket) => {
      const remainingFraction = normalizeNumberValue(bucket.remainingFraction);
      return remainingFraction === null ? null : Math.max(0, Math.min(100, (1 - remainingFraction) * 100));
    })
  );
  return {
    usedPercent,
    hasQuotaData: data.buckets.length > 0,
  };
};

const getKimiQuotaSnapshot = (rows: KimiQuotaRow[]): QuotaUsageSnapshot => {
  const usedPercent = getMaxUsedPercent(
    rows.map((row) => {
      if (row.limit <= 0) return null;
      return Math.max(0, Math.min(100, (row.used / row.limit) * 100));
    })
  );
  return {
    usedPercent,
    hasQuotaData: rows.length > 0,
  };
};

const translateKey = ((key: string) => key) as Parameters<typeof CODEX_CONFIG.fetchQuota>[1];

const resolveAuthErrorAction = (
  account: AccountInspectionAccount,
  statusCode: number
): AccountInspectionDecision => {
  if (account.disabled) {
    return {
      action: 'keep',
      actionReason: `接口返回 ${statusCode}，但账号已禁用`,
      usedPercent: null,
      isQuota: false,
    };
  }

  return {
    action: 'disable',
    actionReason: `接口返回 ${statusCode}，建议禁用账号`,
    usedPercent: null,
    isQuota: false,
  };
};

const inspectAntigravityAccount = async (
  account: AccountInspectionAccount,
  settings: AccountInspectionSettings,
  onLog?: LogHandler
): Promise<AccountInspectionResultItem> => {
  if (!account.authIndex) {
    return buildMissingAuthIndexResult(account, onLog);
  }

  try {
    const groups = await withRetry(settings.retries, () => ANTIGRAVITY_CONFIG.fetchQuota(account.raw, translateKey));
    persistAntigravityQuotaSnapshot(account, groups);

    const usedPercent = getAntigravityUsedPercent(groups);
    const decision = getQuotaAction(
      account,
      { usedPercent, hasQuotaData: usedPercent !== null },
      settings.usedPercentThreshold
    );

    return buildQuotaInspectionResult(account, 'Antigravity', decision, onLog);
  } catch (error) {
    const statusCode = getStatusFromError(error) ?? null;
    if (isAccountErrorStatus(statusCode)) {
      const decision = resolveAuthErrorAction(account, statusCode);
      onLog?.('warning', `${formatAccountInspectionIdentity(account)} -> ${decision.action} (Antigravity · HTTP ${statusCode})`);
      return {
        ...account,
        action: decision.action,
        actionReason: decision.actionReason,
        statusCode,
        usedPercent: null,
        isQuota: false,
        error: error instanceof Error ? error.message : String(error || '探测失败'),
      };
    }

    return buildInspectionErrorResult(account, error, onLog);
  }
};

const persistClaudeQuotaSnapshot = (account: AccountInspectionAccount, data: Parameters<typeof CLAUDE_CONFIG.buildSuccessState>[0]) => {
  if (!account.fileName || account.provider !== 'claude') return;
  const quotaState = CLAUDE_CONFIG.buildSuccessState(data);
  useQuotaStore.getState().setClaudeQuota((previous: Record<string, ClaudeQuotaState>) => ({
    ...previous,
    [account.fileName]: quotaState,
  }));
};

const inspectClaudeAccount = async (
  account: AccountInspectionAccount,
  settings: AccountInspectionSettings,
  onLog?: LogHandler
): Promise<AccountInspectionResultItem> => {
  if (!account.authIndex) {
    return buildMissingAuthIndexResult(account, onLog);
  }

  try {
    const data = await withRetry(settings.retries, () => CLAUDE_CONFIG.fetchQuota(account.raw, translateKey));
    persistClaudeQuotaSnapshot(account, data);
    const decision = getQuotaAction(account, getClaudeQuotaSnapshot(data), settings.usedPercentThreshold);
    return buildQuotaInspectionResult(account, 'Claude', decision, onLog);
  } catch (error) {
    const statusCode = getStatusFromError(error) ?? null;
    if (isAccountErrorStatus(statusCode)) {
      const decision = resolveAuthErrorAction(account, statusCode);
      onLog?.('warning', `${formatAccountInspectionIdentity(account)} -> ${decision.action} (Claude · HTTP ${statusCode})`);
      return {
        ...account,
        action: decision.action,
        actionReason: decision.actionReason,
        statusCode,
        usedPercent: null,
        isQuota: false,
        error: error instanceof Error ? error.message : String(error || '探测失败'),
      };
    }

    return buildInspectionErrorResult(account, error, onLog);
  }
};

const persistGeminiCliQuotaSnapshot = (account: AccountInspectionAccount, data: Parameters<typeof GEMINI_CLI_CONFIG.buildSuccessState>[0]) => {
  if (!account.fileName || account.provider !== 'gemini-cli') return;
  const quotaState = GEMINI_CLI_CONFIG.buildSuccessState(data);
  useQuotaStore.getState().setGeminiCliQuota((previous: Record<string, GeminiCliQuotaState>) => ({
    ...previous,
    [account.fileName]: quotaState,
  }));
};

const inspectGeminiCliAccount = async (
  account: AccountInspectionAccount,
  settings: AccountInspectionSettings,
  onLog?: LogHandler
): Promise<AccountInspectionResultItem> => {
  if (!account.authIndex) {
    return buildMissingAuthIndexResult(account, onLog);
  }

  try {
    const data = await withRetry(settings.retries, () => GEMINI_CLI_CONFIG.fetchQuota(account.raw, translateKey));
    persistGeminiCliQuotaSnapshot(account, data);
    const decision = getQuotaAction(account, getGeminiCliQuotaSnapshot(data), settings.usedPercentThreshold);
    return buildQuotaInspectionResult(account, 'Gemini CLI', decision, onLog);
  } catch (error) {
    const statusCode = getStatusFromError(error) ?? null;
    if (isAccountErrorStatus(statusCode)) {
      const decision = resolveAuthErrorAction(account, statusCode);
      onLog?.('warning', `${formatAccountInspectionIdentity(account)} -> ${decision.action} (Gemini CLI · HTTP ${statusCode})`);
      return {
        ...account,
        action: decision.action,
        actionReason: decision.actionReason,
        statusCode,
        usedPercent: null,
        isQuota: false,
        error: error instanceof Error ? error.message : String(error || '探测失败'),
      };
    }

    return buildInspectionErrorResult(account, error, onLog);
  }
};

const persistKimiQuotaSnapshot = (account: AccountInspectionAccount, rows: Parameters<typeof KIMI_CONFIG.buildSuccessState>[0]) => {
  if (!account.fileName || account.provider !== 'kimi') return;
  const quotaState = KIMI_CONFIG.buildSuccessState(rows);
  useQuotaStore.getState().setKimiQuota((previous: Record<string, KimiQuotaState>) => ({
    ...previous,
    [account.fileName]: quotaState,
  }));
};

const inspectKimiAccount = async (
  account: AccountInspectionAccount,
  settings: AccountInspectionSettings,
  onLog?: LogHandler
): Promise<AccountInspectionResultItem> => {
  if (!account.authIndex) {
    return buildMissingAuthIndexResult(account, onLog);
  }

  try {
    const rows = await withRetry(settings.retries, () => KIMI_CONFIG.fetchQuota(account.raw, translateKey));
    persistKimiQuotaSnapshot(account, rows);
    const decision = getQuotaAction(account, getKimiQuotaSnapshot(rows), settings.usedPercentThreshold);
    return buildQuotaInspectionResult(account, 'Kimi', decision, onLog);
  } catch (error) {
    const statusCode = getStatusFromError(error) ?? null;
    if (isAccountErrorStatus(statusCode)) {
      const decision = resolveAuthErrorAction(account, statusCode);
      onLog?.('warning', `${formatAccountInspectionIdentity(account)} -> ${decision.action} (Kimi · HTTP ${statusCode})`);
      return {
        ...account,
        action: decision.action,
        actionReason: decision.actionReason,
        statusCode,
        usedPercent: null,
        isQuota: false,
        error: error instanceof Error ? error.message : String(error || '探测失败'),
      };
    }

    return buildInspectionErrorResult(account, error, onLog);
  }
};

const INSPECTION_PROVIDER_ADAPTERS: Record<string, InspectionProviderAdapter> = {
  antigravity: {
    inspect: inspectAntigravityAccount,
  },
  claude: {
    inspect: inspectClaudeAccount,
  },
  codex: {
    inspect: inspectCodexAccount,
  },
  'gemini-cli': {
    inspect: inspectGeminiCliAccount,
  },
  kimi: {
    inspect: inspectKimiAccount,
  },
};

const inspectSingleAccount = async (
  account: AccountInspectionAccount,
  settings: AccountInspectionSettings,
  onLog?: LogHandler
): Promise<AccountInspectionResultItem> => {
  const adapter = INSPECTION_PROVIDER_ADAPTERS[account.provider];
  if (!adapter) {
    onLog?.('warning', `${formatAccountInspectionIdentity(account)} 暂不支持 ${account.provider} 巡检，保留账号`);
    return buildKeepResult(account, `暂不支持 ${account.provider} 巡检`, `unsupported provider: ${account.provider}`);
  }

  return adapter.inspect(account, settings, onLog);
};


const sortResults = (items: AccountInspectionResultItem[]) =>
  [...items].sort(
    (left, right) =>
      left.fileName.localeCompare(right.fileName) ||
      left.displayAccount.localeCompare(right.displayAccount) ||
      left.key.localeCompare(right.key)
  );

const createEmptyProgressSummary = (): AccountInspectionProgressSummary => ({
  totalFiles: 0,
  probeSetCount: 0,
  sampledCount: 0,
  deleteCount: 0,
  disableCount: 0,
  enableCount: 0,
  keepCount: 0,
});

const buildProgressSummary = (
  files: AuthFileItem[],
  probeSet: AccountInspectionAccount[],
  sampledAccounts: AccountInspectionAccount[],
  results: AccountInspectionResultItem[]
): AccountInspectionProgressSummary => {
  const deleteCount = results.filter((item) => item.action === 'delete').length;
  const disableCount = results.filter((item) => item.action === 'disable').length;
  const enableCount = results.filter((item) => item.action === 'enable').length;
  const keepCount = results.length - deleteCount - disableCount - enableCount;

  return {
    totalFiles: files.length,
    probeSetCount: probeSet.length,
    sampledCount: sampledAccounts.length,
    deleteCount,
    disableCount,
    enableCount,
    keepCount,
  };
};

const createProgressSnapshot = (
  total: number,
  completed: number,
  inFlight: number,
  status: AccountInspectionProgressStatus,
  startedAt: number,
  updatedAt: number = Date.now(),
  summary: AccountInspectionProgressSummary = createEmptyProgressSummary()
): AccountInspectionProgressSnapshot => {
  const pending = Math.max(0, total - completed - inFlight);

  return {
    total,
    completed,
    inFlight,
    pending,
    percent: total <= 0 ? 0 : Math.round((Math.min(total, completed) / total) * 100),
    status,
    summary,
    startedAt,
    updatedAt,
  };
};

const buildSummary = (
  files: AuthFileItem[],
  sampledAccounts: AccountInspectionAccount[],
  results: AccountInspectionResultItem[],
  settings: AccountInspectionSettings
): AccountInspectionSummary => {
  const deleteCount = results.filter((item) => item.action === 'delete').length;
  const disableCount = results.filter((item) => item.action === 'disable').length;
  const enableCount = results.filter((item) => item.action === 'enable').length;
  const keepCount = results.length - deleteCount - disableCount - enableCount;
  const preview = results
    .filter((item) => item.action !== 'keep')
    .slice(0, 10)
    .map((item) => `${formatAccountInspectionIdentity(item)} -> ${item.action}`);

  return {
    totalFiles: files.length,
    probeSetCount: sampledAccounts.length,
    sampledCount: results.length,
    disabledCount: sampledAccounts.filter((item) => item.disabled).length,
    enabledCount: sampledAccounts.filter((item) => !item.disabled).length,
    deleteCount,
    disableCount,
    enableCount,
    keepCount,
    usedPercentThreshold: settings.usedPercentThreshold,
    sampled: settings.sampleSize > 0 && settings.sampleSize < sampledAccounts.length,
    plannedActionPreview: preview,
  };
};

export const resolveAccountInspectionSettings = (
  config: Config | null,
  apiBase: string,
  managementKey: string,
  settingsOverride?: Partial<AccountInspectionConfigurableSettings> | null
): AccountInspectionSettings => {
  const clean = config?.clean ?? null;
  const configurable = normalizeConfigurableSettings({
    ...readConfigurableSettingsFromConfig(config),
    ...(settingsOverride ?? {}),
  });

  return {
    baseUrl: readString(apiBase) || readString(clean?.baseUrl),
    token: readString(managementKey) || readString(clean?.token),
    targetType: configurable.targetType,
    workers: configurable.workers,
    deleteWorkers: configurable.deleteWorkers,
    timeout: configurable.timeout,
    retries: configurable.retries,
    usedPercentThreshold: configurable.usedPercentThreshold,
    sampleSize: configurable.sampleSize,
  };
};

export const createAccountInspectionSession = ({
  config,
  apiBase,
  managementKey,
  settings,
  onLog,
  onProgress,
}: CreateAccountInspectionSessionOptions): AccountInspectionSession => {
  const resolvedSettings = resolveAccountInspectionSettings(config, apiBase, managementKey, settings);
  const sessionId = `account-inspection-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  let status: AccountInspectionProgressStatus = 'idle';
  let startedAt = 0;
  let finishedAt = 0;
  let files: AuthFileItem[] = [];
  let probeSet: AccountInspectionAccount[] = [];
  let sampledAccounts: AccountInspectionAccount[] = [];
  let cursor = 0;
  let inFlight = 0;
  let finalResult: AccountInspectionRunResult | null = null;
  let deferred: AccountInspectionSessionPromiseState | null = null;
  const resultMap = new Map<string, AccountInspectionResultItem>();

  const emitProgress = () => {
    const baseTime = startedAt || Date.now();
    const summary = buildProgressSummary(files, probeSet, sampledAccounts, Array.from(resultMap.values()));
    onProgress?.(createProgressSnapshot(sampledAccounts.length, resultMap.size, inFlight, status, baseTime, Date.now(), summary));
  };

  const buildFinalResult = (finishedTime: number): AccountInspectionRunResult => {
    const results = sortResults(Array.from(resultMap.values()));
    const summary = buildSummary(files, probeSet, results, resolvedSettings);
    return {
      settings: resolvedSettings,
      files,
      results,
      summary,
      startedAt,
      finishedAt: finishedTime,
    };
  };

  const settleStopped = () => {
    if (!deferred) return;
    const currentDeferred = deferred;
    deferred = null;
    currentDeferred.reject(new AccountInspectionStoppedError());
  };

  const settleCompleted = () => {
    if (!deferred) return;
    const currentDeferred = deferred;
    deferred = null;
    finishedAt = Date.now();
    finalResult = buildFinalResult(finishedAt);
    status = 'completed';
    emitProgress();
    onLog?.(
      'success',
      `巡检完成：删除 ${finalResult.summary.deleteCount}、禁用 ${finalResult.summary.disableCount}、启用 ${finalResult.summary.enableCount}、保留 ${finalResult.summary.keepCount}`
    );
    currentDeferred.resolve(finalResult);
  };

  const maybeSettle = () => {
    if (status === 'stopped') {
      if (inFlight === 0) {
        settleStopped();
      }
      return;
    }

    if (cursor >= sampledAccounts.length && inFlight === 0) {
      settleCompleted();
    }
  };

  const pump = () => {
    if (status !== 'running') {
      maybeSettle();
      return;
    }

    while (status === 'running' && inFlight < resolvedSettings.workers && cursor < sampledAccounts.length) {
      const account = sampledAccounts[cursor];
      cursor += 1;
      inFlight += 1;
      emitProgress();

      void inspectSingleAccount(account, resolvedSettings, onLog)
        .then((inspectionResult) => {
          resultMap.set(inspectionResult.key, inspectionResult);
        })
        .catch((error) => {
          resultMap.set(account.key, {
            ...account,
            action: 'keep',
            actionReason: '探测异常，保留账号',
            statusCode: null,
            usedPercent: null,
            isQuota: false,
            error: error instanceof Error ? error.message : String(error || '探测失败'),
          });
        })
        .finally(() => {
          inFlight = Math.max(0, inFlight - 1);
          emitProgress();
          pump();
        });
    }

    maybeSettle();
  };

  const ensureStarted = () => {
    if (startedAt <= 0) {
      startedAt = Date.now();
    }
    if (!deferred) {
      deferred = createDeferred();
    }
    return deferred;
  };

  const initialize = async () => {
    onLog?.('info', `加载认证文件列表，目标类型：${resolvedSettings.targetType}`);

    const authFilesResponse = await authFilesApi.list();
    files = Array.isArray(authFilesResponse.files) ? authFilesResponse.files : [];
    const accounts = files.map(toInspectionAccount);
    probeSet = accounts.filter((item) => shouldInspectProvider(item.provider, resolvedSettings.targetType));
    sampledAccounts =
      resolvedSettings.sampleSize > 0
        ? pickSample(probeSet, Math.min(resolvedSettings.sampleSize, probeSet.length))
        : probeSet;

    onLog?.(
      'info',
      `巡检集合 ${probeSet.length} 个账号，本次探测 ${sampledAccounts.length} 个账号`
    );
    emitProgress();
  };

  const start = () => {
    if (finalResult) {
      return Promise.resolve(finalResult);
    }

    if (status === 'completed') {
      return Promise.reject(new Error('巡检已结束，请重新开始'));
    }

    if (status === 'running') {
      return ensureStarted().promise;
    }

    if (status === 'paused') {
      status = 'running';
      onLog?.('info', '继续巡检');
      emitProgress();
      pump();
      return ensureStarted().promise;
    }

    if (status === 'stopped') {
      return Promise.reject(new AccountInspectionStoppedError('巡检已停止，请重新开始'));
    }

    const currentDeferred = ensureStarted();
    status = 'running';
    emitProgress();

    void initialize()
      .then(() => {
        pump();
      })
      .catch((error) => {
        status = 'completed';
        emitProgress();
        const activeDeferred = deferred;
        deferred = null;
        activeDeferred?.reject(error);
      });

    return currentDeferred.promise;
  };

  const resume = () => {
    if (status !== 'paused') return;
    status = 'running';
    onLog?.('info', '继续巡检');
    emitProgress();
    pump();
  };

  const pause = () => {
    if (status !== 'running') return;
    status = 'paused';
    onLog?.(
      'info',
      inFlight > 0 ? `巡检已暂停，等待 ${inFlight} 个进行中的探测完成` : '巡检已暂停'
    );
    emitProgress();
    maybeSettle();
  };

  const stop = () => {
    if (status === 'completed' || status === 'stopped' || status === 'idle') return;
    status = 'stopped';
    onLog?.(
      'warning',
      inFlight > 0 ? `巡检已停止，等待 ${inFlight} 个进行中的探测完成` : '巡检已停止'
    );
    emitProgress();
    maybeSettle();
  };

  return {
    id: sessionId,
    start,
    resume,
    pause,
    stop,
    getProgress: () =>
      createProgressSnapshot(
        sampledAccounts.length,
        resultMap.size,
        inFlight,
        status,
        startedAt || Date.now(),
        Date.now(),
        buildProgressSummary(files, probeSet, sampledAccounts, Array.from(resultMap.values()))
      ),
  };
};

export const inspectAccounts = async ({
  config,
  apiBase,
  managementKey,
  settings,
  onLog,
  onProgress,
}: InspectAccountsOptions): Promise<AccountInspectionRunResult> => {
  const session = createAccountInspectionSession({
    config,
    apiBase,
    managementKey,
    settings,
    onLog,
    onProgress,
  });

  return session.start();
};

const dedupeExecutionItems = (items: AccountInspectionResultItem[]) => {
  const map = new Map<string, AccountInspectionResultItem>();
  items.forEach((item) => {
    if (item.action === 'keep') return;
    if (!item.fileName) return;
    if (!map.has(item.fileName)) {
      map.set(item.fileName, item);
    }
  });
  return Array.from(map.values()).sort((left, right) => left.fileName.localeCompare(right.fileName));
};

const executeDelete = async (item: AccountInspectionResultItem): Promise<AccountInspectionExecutionOutcome> => {
  try {
    const result = await authFilesApi.deleteFileByName(item.fileName);
    const failed = result.failed[0];
    if (failed) {
      return {
        action: 'delete',
        fileName: item.fileName,
        displayAccount: item.displayAccount,
        provider: item.provider,
        authIndex: item.authIndex,
        success: false,
        error: failed.error || '删除失败',
      };
    }
    return {
      action: 'delete',
      fileName: item.fileName,
      displayAccount: item.displayAccount,
      provider: item.provider,
      authIndex: item.authIndex,
      success: true,
      error: '',
    };
  } catch (error) {
    return {
      action: 'delete',
      fileName: item.fileName,
      displayAccount: item.displayAccount,
      provider: item.provider,
      authIndex: item.authIndex,
      success: false,
      error: error instanceof Error ? error.message : String(error || '删除失败'),
    };
  }
};

const executeStatusChange = async (
  item: AccountInspectionResultItem,
  disabled: boolean
): Promise<AccountInspectionExecutionOutcome> => {
  try {
    await authFilesApi.setStatusWithFallback(item.fileName, disabled);
    return {
      action: disabled ? 'disable' : 'enable',
      fileName: item.fileName,
      displayAccount: item.displayAccount,
      provider: item.provider,
      authIndex: item.authIndex,
      success: true,
      error: '',
    };
  } catch (error) {
    return {
      action: disabled ? 'disable' : 'enable',
      fileName: item.fileName,
      displayAccount: item.displayAccount,
      provider: item.provider,
      authIndex: item.authIndex,
      success: false,
      error: error instanceof Error ? error.message : String(error || '状态更新失败'),
    };
  }
};

export const executeAccountInspectionActions = async ({
  settings,
  items,
  previousFiles,
  onLog,
}: ExecuteAccountInspectionActionsOptions): Promise<AccountInspectionExecutionResult> => {
  const dedupedItems = dedupeExecutionItems(items);
  const deleteItems = dedupedItems.filter((item) => item.action === 'delete');
  const disableItems = dedupedItems.filter((item) => item.action === 'disable');
  const enableItems = dedupedItems.filter((item) => item.action === 'enable');
  const outcomes: AccountInspectionExecutionOutcome[] = [];

  if (deleteItems.length > 0) {
    onLog?.('info', `开始删除 ${deleteItems.length} 个账号`);
    const deleteOutcomes = await runConcurrently(deleteItems, settings.deleteWorkers, executeDelete);
    deleteOutcomes.forEach((outcome) => {
      onLog?.(
        outcome.success ? 'success' : 'error',
        `${formatAccountInspectionIdentity(outcome)} 删除${outcome.success ? '成功' : `失败：${outcome.error}`}`
      );
    });
    outcomes.push(...deleteOutcomes);
  }

  if (disableItems.length > 0) {
    onLog?.('info', `开始禁用 ${disableItems.length} 个账号`);
    const disableOutcomes = await runConcurrently(disableItems, settings.workers, (item) =>
      executeStatusChange(item, true)
    );
    disableOutcomes.forEach((outcome) => {
      onLog?.(
        outcome.success ? 'success' : 'error',
        `${formatAccountInspectionIdentity(outcome)} 禁用${outcome.success ? '成功' : `失败：${outcome.error}`}`
      );
    });
    outcomes.push(...disableOutcomes);
  }

  if (enableItems.length > 0) {
    onLog?.('info', `开始启用 ${enableItems.length} 个账号`);
    const enableOutcomes = await runConcurrently(enableItems, settings.workers, (item) =>
      executeStatusChange(item, false)
    );
    enableOutcomes.forEach((outcome) => {
      onLog?.(
        outcome.success ? 'success' : 'error',
        `${formatAccountInspectionIdentity(outcome)} 启用${outcome.success ? '成功' : `失败：${outcome.error}`}`
      );
    });
    outcomes.push(...enableOutcomes);
  }

  let refreshedFiles = previousFiles;
  let refreshError = '';
  try {
    const response = await authFilesApi.list();
    refreshedFiles = Array.isArray(response.files) ? response.files : previousFiles;
  } catch (error) {
    refreshError = error instanceof Error ? error.message : String(error || '刷新账号列表失败');
    onLog?.('warning', `执行后刷新账号列表失败，已回退旧快照：${refreshError}`);
  }

  return {
    outcomes,
    refreshedFiles,
    refreshError,
  };
};

export const buildAccountInspectionError = (message: string) => message;

export const buildExecutionFailureMessage = (outcome: AccountInspectionExecutionOutcome) =>
  `${formatAccountInspectionIdentity(outcome)}：${outcome.error || '执行失败'}`;

export const isSuggestedAction = (item: AccountInspectionResultItem) => item.action !== 'keep';

const isAccountErrorAction = (item: AccountInspectionResultItem) =>
  isAccountErrorStatus(item.statusCode) || (!item.isQuota && item.statusCode !== null && item.statusCode >= 400);

export const hasAccountInspectionAutoExecutePolicies = (settings: AccountInspectionConfigurableSettings) =>
  settings.autoExecuteQuotaLimitDisable ||
  settings.autoExecuteQuotaRecoveryEnable ||
  settings.autoExecuteAccountErrorAction !== 'none';

export const getAutoExecutableAccountInspectionItems = (
  items: AccountInspectionResultItem[],
  settings: AccountInspectionConfigurableSettings
): AccountInspectionResultItem[] =>
  items.reduce<AccountInspectionResultItem[]>((nextItems, item) => {
    if (isAccountErrorAction(item)) {
      if (settings.autoExecuteAccountErrorAction === 'delete') {
        nextItems.push({
          ...item,
          action: 'delete',
          actionReason: '账号错误，按自动执行策略删除账号',
        });
      } else if (settings.autoExecuteAccountErrorAction === 'disable' && !item.disabled) {
        nextItems.push({
          ...item,
          action: 'disable',
          actionReason: '账号错误，按自动执行策略禁用账号',
        });
      }
      return nextItems;
    }

    if (!isSuggestedAction(item)) return nextItems;

    if (item.action === 'disable' && item.isQuota && settings.autoExecuteQuotaLimitDisable) {
      nextItems.push(item);
      return nextItems;
    }

    if (item.action === 'enable' && settings.autoExecuteQuotaRecoveryEnable) {
      nextItems.push(item);
    }

    return nextItems;
  }, []);

export const isAccountInspectionStoppedError = (error: unknown): error is AccountInspectionStoppedError =>
  error instanceof AccountInspectionStoppedError;

export const applyAccountInspectionExecutionResult = (
  previousResult: AccountInspectionRunResult,
  execution: AccountInspectionExecutionResult
): AccountInspectionRunResult => {
  const successfulOutcomes = new Map(
    execution.outcomes.filter((item) => item.success).map((item) => [item.fileName, item] as const)
  );
  const refreshedAccounts = new Map(
    execution.refreshedFiles.map((file) => {
      const account = toInspectionAccount(file);
      return [account.fileName, account] as const;
    })
  );

  const nextResults = sortResults(
    previousResult.results.map((item) => {
      const refreshedAccount = refreshedAccounts.get(item.fileName);
      const baseItem: AccountInspectionResultItem = refreshedAccount
        ? {
            ...item,
            ...refreshedAccount,
            raw: refreshedAccount.raw,
          }
        : item;
      const outcome = successfulOutcomes.get(item.fileName);

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

  const deleteCount = nextResults.filter((item) => item.action === 'delete').length;
  const disableCount = nextResults.filter((item) => item.action === 'disable').length;
  const enableCount = nextResults.filter((item) => item.action === 'enable').length;
  const keepCount = nextResults.length - deleteCount - disableCount - enableCount;
  const plannedActionPreview = nextResults
    .filter((item) => item.action !== 'keep')
    .slice(0, 10)
    .map((item) => `${formatAccountInspectionIdentity(item)} -> ${item.action}`);

  return {
    ...previousResult,
    files: execution.refreshedFiles,
    results: nextResults,
    summary: {
      ...previousResult.summary,
      totalFiles: execution.refreshedFiles.length,
      disabledCount: nextResults.filter((item) => item.disabled).length,
      enabledCount: nextResults.filter((item) => !item.disabled).length,
      deleteCount,
      disableCount,
      enableCount,
      keepCount,
      plannedActionPreview,
    },
    finishedAt: Date.now(),
  };
};

export const buildSuggestedActionCountLabel = (summary: AccountInspectionSummary) =>
  summary.deleteCount + summary.disableCount + summary.enableCount;

export const getProbeFailureMessage = (result: AccountInspectionResultItem) =>
  result.error || getApiCallErrorMessage({ statusCode: result.statusCode || 0, hasStatusCode: true, header: {}, bodyText: '', body: null });
