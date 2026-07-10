import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type DragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import {
  IconChevronDown,
  IconChevronUp,
  IconRefreshCw,
  IconSearch,
  IconSlidersHorizontal,
} from '@/components/ui/icons';
import {
  buildAccountRowsByAccount,
  buildDayLabel,
  buildHourLabel,
  buildLocalDayKey,
  formatShortDateTime,
  getRangeStartMs,
  joinUnique,
  useMonitoringData,
  type MonitoringAccountRow,
  type MonitoringEventRow,
  type MonitoringSummary,
  type MonitoringStatusTone,
  type MonitoringTimeRange,
} from '@/features/monitoring/hooks/useMonitoringData';
import { useUsageData, type UsageEventPageFilters, type UsagePayload } from '@/features/monitoring/hooks/useUsageData';
import { useUsageAggregates, type UsageAggregateBucket } from '@/features/monitoring/hooks/useUsageAggregates';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { apiClient } from '@/services/api/client';
import { useAuthStore, useConfigStore, useNotificationStore, useQuotaStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { maskSensitiveText } from '@/utils/format';
import { getStatusFromError, isAntigravityFile, isClaudeFile, isCodexFile, isKimiFile, isXaiFile } from '@/utils/quota';
import { calculateCost, formatCompactNumber, formatDurationMs, formatUsd, normalizeAuthIndex, type ModelPrice } from '@/utils/usage';
import {
  ANTIGRAVITY_CONFIG,
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  KIMI_CONFIG,
  XAI_CONFIG,
  type QuotaConfig,
  type QuotaStore,
} from '@/components/quota/quotaConfigs';
import { QuotaProgressBar, type QuotaRenderHelpers, type QuotaStatusState } from '@/components/quota/QuotaCard';
import quotaStyles from '@/pages/QuotaPage.module.scss';
import styles from './MonitoringCenterPage.module.scss';

const TIME_RANGE_OPTIONS: Array<{ value: MonitoringTimeRange; labelKey: string }> = [
  { value: 'today', labelKey: 'monitoring.range_today' },
  { value: '7d', labelKey: 'monitoring.range_7d' },
  { value: '14d', labelKey: 'monitoring.range_14d' },
  { value: '30d', labelKey: 'monitoring.range_30d' },
  { value: 'all', labelKey: 'monitoring.range_all' },
];

type StatusFilter = 'all' | 'success' | 'failed';

type UsageMetricCard = {
  key: string;
  title: string;
  label: string;
  value: ReactNode;
  accent: 'blue' | 'purple' | 'green' | 'amber';
  footer: Array<{ label: string; value: ReactNode }>;
};

type RankingMetric = 'requests' | 'tokens' | 'cost';
type AccountSortMetric = 'recent' | RankingMetric;

const RANKING_METRIC_OPTIONS: Array<{ value: RankingMetric; labelKey: string }> = [
  { value: 'requests', labelKey: 'monitoring.ranking_metric_requests' },
  { value: 'tokens', labelKey: 'monitoring.ranking_metric_tokens' },
  { value: 'cost', labelKey: 'monitoring.ranking_metric_cost' },
];

const ACCOUNT_SORT_OPTIONS: Array<{ value: AccountSortMetric; labelKey: string }> = [
  { value: 'recent', labelKey: 'monitoring.account_sort_recent' },
  { value: 'requests', labelKey: 'monitoring.ranking_metric_requests' },
  { value: 'tokens', labelKey: 'monitoring.ranking_metric_tokens' },
  { value: 'cost', labelKey: 'monitoring.ranking_metric_cost' },
];

const ACCOUNT_STATUS_BLOCK_COUNT = 20;
const ACCOUNT_STATUS_BLOCK_DURATION_MS = 10 * 60 * 1000;
const ACCOUNT_STATS_ANALYTICS_ROW_LIMIT = 6000;
const REALTIME_LOG_PAGE_SIZE = 100;
const REALTIME_LOG_ENRICH_LIMIT = REALTIME_LOG_PAGE_SIZE;
const ACCOUNT_QUOTA_REQUEST_CONCURRENCY = 4;
const REALTIME_LOG_COLUMNS_STORAGE_KEY = 'cli-proxy-realtime-log-columns-v2';
const REALTIME_LOG_COLUMN_KEYS = [
  'type',
  'model',
  'apiKey',
  'recent',
  'status',
  'successRate',
  'calls',
  'ttft',
  'latency',
  'time',
  'usage',
  'cost',
] as const;
type RealtimeLogColumnKey = typeof REALTIME_LOG_COLUMN_KEYS[number];
type RealtimeLogColumnPreference = {
  key: RealtimeLogColumnKey;
  visible: boolean;
  width?: number;
};
type RealtimeLogColumnDefinition = {
  key: RealtimeLogColumnKey;
  label: string;
  colClassName: string;
  headerClassName?: string;
  cellClassName?: (row: RealtimeLogRow) => string | undefined;
  render: (row: RealtimeLogRow) => ReactNode;
  width: number;
};
const REALTIME_LOG_COLUMN_DEFAULT_WIDTHS: Record<RealtimeLogColumnKey, number> = {
  type: 170,
  model: 230,
  apiKey: 145,
  recent: 86,
  status: 180,
  successRate: 86,
  calls: 76,
  ttft: 92,
  latency: 96,
  time: 164,
  usage: 210,
  cost: 92,
};
const REALTIME_LOG_COLUMN_MIN_WIDTHS: Record<RealtimeLogColumnKey, number> = {
  type: 96,
  model: 132,
  apiKey: 104,
  recent: 76,
  status: 120,
  successRate: 76,
  calls: 68,
  ttft: 76,
  latency: 76,
  time: 116,
  usage: 122,
  cost: 76,
};
const REALTIME_LOG_COLUMN_MAX_WIDTH = 420;
const REALTIME_LOG_COLUMN_KEY_SET = new Set<RealtimeLogColumnKey>(REALTIME_LOG_COLUMN_KEYS);
const createDefaultRealtimeLogColumns = (): RealtimeLogColumnPreference[] => (
  REALTIME_LOG_COLUMN_KEYS.map((key) => ({ key, visible: true }))
);
const REALTIME_LOG_DEFAULT_COLUMNS = createDefaultRealtimeLogColumns();
const ACCOUNT_STATUS_COLOR_STOPS = [
  { r: 239, g: 68, b: 68 },
  { r: 250, g: 204, b: 21 },
  { r: 34, g: 197, b: 94 },
] as const;

const getAccountStatusColor = (rate: number) => {
  const value = Math.max(0, Math.min(1, rate));
  const segment = value < 0.5 ? 0 : 1;
  const localValue = segment === 0 ? value * 2 : (value - 0.5) * 2;
  const from = ACCOUNT_STATUS_COLOR_STOPS[segment];
  const to = ACCOUNT_STATUS_COLOR_STOPS[segment + 1];
  const r = Math.round(from.r + (to.r - from.r) * localValue);
  const g = Math.round(from.g + (to.g - from.g) * localValue);
  const b = Math.round(from.b + (to.b - from.b) * localValue);
  return `rgb(${r}, ${g}, ${b})`;
};

const formatStatusRate = (rate: number) => {
  const rounded = rate.toFixed(1);
  return `${rounded.endsWith('.0') ? rounded.slice(0, -2) : rounded}%`;
};

const isRealtimeLogColumnKey = (value: unknown): value is RealtimeLogColumnKey => (
  typeof value === 'string' && REALTIME_LOG_COLUMN_KEY_SET.has(value as RealtimeLogColumnKey)
);

const clampRealtimeLogColumnWidth = (key: RealtimeLogColumnKey, width: unknown) => {
  const numericWidth = typeof width === 'number' && Number.isFinite(width)
    ? width
    : REALTIME_LOG_COLUMN_DEFAULT_WIDTHS[key];
  return Math.min(REALTIME_LOG_COLUMN_MAX_WIDTH, Math.max(REALTIME_LOG_COLUMN_MIN_WIDTHS[key], Math.round(numericWidth)));
};

const normalizeRealtimeLogColumnWidth = (key: RealtimeLogColumnKey, width: unknown) => (
  typeof width === 'number' && Number.isFinite(width)
    ? clampRealtimeLogColumnWidth(key, width)
    : undefined
);

const normalizeRealtimeLogColumns = (value: unknown): RealtimeLogColumnPreference[] => {
  const next: RealtimeLogColumnPreference[] = [];
  const seen = new Set<RealtimeLogColumnKey>();

  if (Array.isArray(value)) {
    value.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      const key = (item as { key?: unknown }).key;
      if (!isRealtimeLogColumnKey(key) || seen.has(key)) return;
      next.push({
        key,
        visible: (item as { visible?: unknown }).visible !== false,
        width: normalizeRealtimeLogColumnWidth(key, (item as { width?: unknown }).width),
      });
      seen.add(key);
    });
  }

  REALTIME_LOG_DEFAULT_COLUMNS.forEach((item) => {
    if (!seen.has(item.key)) {
      next.push({ ...item });
    }
  });

  return next.some((item) => item.visible) ? next : createDefaultRealtimeLogColumns();
};

const loadRealtimeLogColumns = () => {
  if (typeof window === 'undefined') {
    return createDefaultRealtimeLogColumns();
  }
  try {
    return normalizeRealtimeLogColumns(JSON.parse(window.localStorage.getItem(REALTIME_LOG_COLUMNS_STORAGE_KEY) || 'null'));
  } catch {
    return createDefaultRealtimeLogColumns();
  }
};

const saveRealtimeLogColumns = (columns: RealtimeLogColumnPreference[]) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(REALTIME_LOG_COLUMNS_STORAGE_KEY, JSON.stringify(columns));
  } catch {
    // Column preferences are convenience state; storage failures should not break logs.
  }
};

const getRealtimeLogColumnContentTexts = (key: RealtimeLogColumnKey, row: RealtimeLogRow) => {
  switch (key) {
    case 'type':
      return [row.provider, row.account || row.authLabel || row.accountMasked || '-'];
    case 'model':
      return [row.model, row.modelAlias && row.modelAlias !== row.model ? row.modelAlias : buildRealtimeMetaText(row)];
    case 'apiKey':
      return [row.clientApiKey.masked];
    case 'recent':
      return ['||||||||||'];
    case 'status':
      return [buildRealtimeStatusLabel(row, row.failed ? 'Failed' : 'Success')];
    case 'successRate':
      return [formatPercent(row.successRate)];
    case 'calls':
      return [formatCompactNumber(row.requestCount)];
    case 'ttft':
      return [formatDurationMs(row.ttftMs)];
    case 'latency':
      return [formatDurationMs(row.latencyMs)];
    case 'time':
      return [new Date(row.timestampMs).toLocaleString()];
    case 'usage':
      return [
        formatCompactNumber(row.totalTokens),
        `I ${formatCompactNumber(row.inputTokens)} O ${formatCompactNumber(row.outputTokens)}`,
        `R ${formatCompactNumber(row.reasoningTokens)} C ${formatCompactNumber(row.cachedTokens)}`,
      ];
    case 'cost':
      return [formatUsd(row.totalCost)];
    default:
      return [];
  }
};

const estimateRealtimeLogColumnWidth = (
  key: RealtimeLogColumnKey,
  label: string,
  rows: RealtimeLogRow[]
) => {
  const maxTextLength = rows.reduce((maxLength, row) => {
    const rowMaxLength = getRealtimeLogColumnContentTexts(key, row)
      .reduce((innerMax, text) => Math.max(innerMax, text.length), 0);
    return Math.max(maxLength, rowMaxLength);
  }, label.length);
  const characterWidth = key === 'recent' ? 6 : key === 'usage' ? 8 : 7;
  const padding = key === 'status' ? 36 : key === 'usage' ? 34 : 28;
  return clampRealtimeLogColumnWidth(key, maxTextLength * characterWidth + padding);
};

const estimateRealtimeLogHeaderWidth = (key: RealtimeLogColumnKey, label: string) => {
  const textWidth = Array.from(label).reduce((total, char) => (
    total + (char.charCodeAt(0) > 255 ? 13 : 7)
  ), 0);
  return clampRealtimeLogColumnWidth(key, textWidth + 42);
};

const formatStatusWindowLabel = (startTime: number, endTime: number, locale: string) => {
  const start = new Date(startTime);
  const end = new Date(endTime);
  const sameDay = start.toDateString() === end.toDateString();
  const dateOptions: Intl.DateTimeFormatOptions = { month: 'numeric', day: 'numeric' };
  const timeOptions: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
  const startDateLabel = start.toLocaleDateString(locale, dateOptions);
  const endDateLabel = end.toLocaleDateString(locale, dateOptions);
  const startTimeLabel = start.toLocaleTimeString(locale, timeOptions);
  const endTimeLabel = end.toLocaleTimeString(locale, timeOptions);

  return sameDay
    ? `${startDateLabel} ${startTimeLabel} - ${endTimeLabel}`
    : `${startDateLabel} ${startTimeLabel} - ${endDateLabel} ${endTimeLabel}`;
};

const buildAccountStatusBlockAriaLabel = ({
  detail,
  timeRangeLabel,
  successRateValue,
  copy,
}: {
  detail: AccountStatusBlockDetail;
  timeRangeLabel: string;
  successRateValue: string;
  copy: {
    successLabel: string;
    failureLabel: string;
    noRequestsLabel: string;
    successRateLabel: string;
  };
}) => {
  const total = detail.success + detail.failure;
  if (total === 0) {
    return `${timeRangeLabel}，${copy.noRequestsLabel}`;
  }
  return `${timeRangeLabel}，${copy.successLabel} ${detail.success}，${copy.failureLabel} ${detail.failure}，${copy.successRateLabel} ${successRateValue}`;
};

const getNextAccountStatusBlockIndex = (currentIndex: number, key: string, count: number) => {
  if (count <= 0) return null;
  if (key === 'ArrowRight' || key === 'ArrowDown') return Math.min(currentIndex + 1, count - 1);
  if (key === 'ArrowLeft' || key === 'ArrowUp') return Math.max(currentIndex - 1, 0);
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
};

const formatAccountOverviewScopeText = (rangeLabel: string, t: TFunction) => t('monitoring.account_scope_text', { range: rangeLabel });

const buildAccountStatusRange = (rows: MonitoringAccountRow[], range: MonitoringTimeRange, nowMs = Date.now()): AccountStatusRange => {
  if (range !== 'all') {
    return {
      startTime: getRangeStartMs(range, nowMs),
      endTime: nowMs,
    };
  }

  let minTimestamp = Number.POSITIVE_INFINITY;
  rows.forEach((row) => {
    row.rows?.forEach((event) => {
      minTimestamp = Math.min(minTimestamp, event.timestampMs);
    });
  });
  return {
    startTime: Number.isFinite(minTimestamp) ? minTimestamp : nowMs - ACCOUNT_STATUS_BLOCK_COUNT * ACCOUNT_STATUS_BLOCK_DURATION_MS,
    endTime: nowMs,
  };
};

const buildAccountStatusData = (rows: MonitoringEventRow[], range: AccountStatusRange): AccountStatusData => {
  const duration = Math.max(range.endTime - range.startTime, ACCOUNT_STATUS_BLOCK_DURATION_MS);
  const blockDuration = duration / ACCOUNT_STATUS_BLOCK_COUNT;
  const blockDetails = Array.from({ length: ACCOUNT_STATUS_BLOCK_COUNT }, (_, index) => ({
    success: 0,
    failure: 0,
    rate: -1,
    startTime: range.startTime + index * blockDuration,
    endTime: index === ACCOUNT_STATUS_BLOCK_COUNT - 1 ? range.endTime : range.startTime + (index + 1) * blockDuration,
  }));
  let totalSuccess = 0;
  let totalFailure = 0;

  rows.forEach((row) => {
    if (row.timestampMs < range.startTime || row.timestampMs > range.endTime) return;
    const index = Math.min(
      ACCOUNT_STATUS_BLOCK_COUNT - 1,
      Math.max(0, Math.floor((row.timestampMs - range.startTime) / blockDuration))
    );
    if (row.failed) {
      blockDetails[index].failure += 1;
      totalFailure += 1;
    } else {
      blockDetails[index].success += 1;
      totalSuccess += 1;
    }
  });

  blockDetails.forEach((detail) => {
    const total = detail.success + detail.failure;
    detail.rate = total > 0 ? detail.success / total : -1;
  });
  const total = totalSuccess + totalFailure;

  return {
    blockDetails,
    successRate: total > 0 ? (totalSuccess / total) * 100 : 100,
    totalSuccess,
    totalFailure,
  };
};

const DONUT_COLORS = ['#2563eb', '#22c55e', '#f97316', '#8b5cf6', '#06b6d4', '#ec4899', '#14b8a6', '#eab308'];

const getDonutColor = (index: number) => DONUT_COLORS[index % DONUT_COLORS.length];

type TrendPoint = {
  key: string;
  label: string;
  requests: number;
  failures: number;
  tokens: number;
  cost: number;
};

type TokenDistributionPoint = {
  key: string;
  label: string;
  requests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalCost: number;
};

type RankingRowAccumulator = {
  id: string;
  group: 'apiKey' | 'model';
  model: string;
  apiKeyHash: string;
  apiKeyMasked: string;
  account: string;
  accountMasked: string;
  authLabels: Set<string>;
  authIndices: Set<string>;
  channels: Set<string>;
  providers: Set<string>;
  totalCalls: number;
  successCalls: number;
  failureCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  totalCost: number;
  latencySum: number;
  latencyCount: number;
  lastSeenAt: number;
};

type UsageTrendAnalytics = {
  apiKeyOptions: Array<{ value: string; label: string }>;
  trendPoints: TrendPoint[];
  tokenDistributionPoints: TokenDistributionPoint[];
  modelRows: MonitoringAccountRow[];
  apiKeyRows: MonitoringAccountRow[];
  scopedTotals: Record<RankingMetric, number>;
};

type AccountHealthTone = 'good' | 'warn' | 'bad';

type AccountStatusBlockDetail = {
  success: number;
  failure: number;
  rate: number;
  startTime: number;
  endTime: number;
};

type AccountStatusRange = {
  startTime: number;
  endTime: number;
};

type AccountStatusData = {
  blockDetails: AccountStatusBlockDetail[];
  successRate: number;
  totalSuccess: number;
  totalFailure: number;
};

type PriceDraft = {
  prompt: string;
  completion: string;
  cache: string;
};

type MonitoringSettings = {
  retentionDays: number;
  webdav: {
    enabled: boolean;
    intervalMinutes: number;
    retentionDays: number;
    url: string;
    username: string;
    password: string;
  };
};

type MonitoringSettingsDraft = {
  retentionDays: string;
  webdavEnabled: boolean;
  webdavIntervalMinutes: string;
  webdavRetentionDays: string;
  webdavUrl: string;
  webdavUsername: string;
  webdavPassword: string;
};

type RealtimeLogRow = MonitoringEventRow & {
  requestCount: number;
  successRate: number;
  streamKey: string;
  diagnosticText: string;
  errorCategoryKey: string;
  errorSummary: string;
  recentPattern: boolean[];
  recentSuccessCount: number;
  recentFailureCount: number;
};

type MonitoringSummaryAccumulator = {
  totalCalls: number;
  failureCalls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
  totalCost: number;
  latencySum: number;
  latencyCount: number;
  recentCalls: number;
  recentTokens: number;
  zeroTokenCalls: number;
  taskMap: Map<string, boolean>;
  activeDays: Set<string>;
  zeroTokenModels: Set<string>;
};

const createMonitoringSummaryAccumulator = (): MonitoringSummaryAccumulator => ({
  totalCalls: 0,
  failureCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedTokens: 0,
  totalTokens: 0,
  totalCost: 0,
  latencySum: 0,
  latencyCount: 0,
  recentCalls: 0,
  recentTokens: 0,
  zeroTokenCalls: 0,
  taskMap: new Map(),
  activeDays: new Set(),
  zeroTokenModels: new Set(),
});

const addMonitoringSummaryRow = (
  accumulator: MonitoringSummaryAccumulator,
  row: MonitoringEventRow,
  windowStartMs: number,
  nowMs: number
) => {
  accumulator.totalCalls += 1;
  if (row.failed) accumulator.failureCalls += 1;
  accumulator.inputTokens += row.inputTokens;
  accumulator.outputTokens += row.outputTokens;
  accumulator.reasoningTokens += row.reasoningTokens;
  accumulator.cachedTokens += row.cachedTokens;
  accumulator.totalTokens += row.totalTokens;
  accumulator.totalCost += row.totalCost;
  accumulator.activeDays.add(row.dayKey);

  if (row.latencyMs !== null) {
    accumulator.latencySum += row.latencyMs;
    accumulator.latencyCount += 1;
  }

  accumulator.taskMap.set(row.taskKey, (accumulator.taskMap.get(row.taskKey) ?? false) || row.failed);

  if (row.totalTokens === 0) {
    accumulator.zeroTokenCalls += 1;
    accumulator.zeroTokenModels.add(row.model);
  }

  if (row.timestampMs >= windowStartMs && row.timestampMs <= nowMs) {
    accumulator.recentCalls += 1;
    accumulator.recentTokens += row.totalTokens;
  }
};

const finalizeMonitoringSummary = (accumulator: MonitoringSummaryAccumulator): MonitoringSummary => {
  const successCalls = Math.max(accumulator.totalCalls - accumulator.failureCalls, 0);
  let approxTaskFailures = 0;
  accumulator.taskMap.forEach((failed) => {
    if (failed) approxTaskFailures += 1;
  });
  const activeDayCount = Math.max(accumulator.activeDays.size, 1);

  return {
    totalCalls: accumulator.totalCalls,
    successCalls,
    failureCalls: accumulator.failureCalls,
    successRate: accumulator.totalCalls > 0 ? successCalls / accumulator.totalCalls : 1,
    inputTokens: accumulator.inputTokens,
    outputTokens: accumulator.outputTokens,
    reasoningTokens: accumulator.reasoningTokens,
    cachedTokens: accumulator.cachedTokens,
    totalTokens: accumulator.totalTokens,
    totalCost: accumulator.totalCost,
    averageLatencyMs: accumulator.latencyCount > 0 ? accumulator.latencySum / accumulator.latencyCount : null,
    rpm30m: accumulator.recentCalls / 30,
    tpm30m: accumulator.recentTokens / 30,
    avgDailyRequests: accumulator.totalCalls / activeDayCount,
    avgDailyTokens: accumulator.totalTokens / activeDayCount,
    approxTasks: accumulator.taskMap.size,
    approxTaskFailures,
    approxTaskSuccessRate:
      accumulator.taskMap.size > 0
        ? Math.max(accumulator.taskMap.size - approxTaskFailures, 0) / accumulator.taskMap.size
        : 1,
    zeroTokenCalls: accumulator.zeroTokenCalls,
    zeroTokenModels: Array.from(accumulator.zeroTokenModels).sort(),
  };
};

type UsageImportResult = {
  added?: number;
  skipped?: number;
  total?: number;
  failed?: number;
  modelPrices?: number;
  modelPriceRecords?: number;
  quotaCache?: number;
  quotaCacheRecords?: number;
  accountInspectionSchedule?: boolean;
  accountInspectionScheduleRecords?: number;
  monitoringSettings?: boolean;
  monitoringSettingsRecords?: number;
};

const createMonitoringSettingsDraft = (settings?: MonitoringSettings): MonitoringSettingsDraft => ({
  retentionDays: String(settings?.retentionDays ?? 0),
  webdavEnabled: settings?.webdav.enabled ?? false,
  webdavIntervalMinutes: String(settings?.webdav.intervalMinutes ?? 1440),
  webdavRetentionDays: String(settings?.webdav.retentionDays ?? 0),
  webdavUrl: settings?.webdav.url ?? '',
  webdavUsername: settings?.webdav.username ?? '',
  webdavPassword: settings?.webdav.password ?? '',
});

const parseNonNegativeInteger = (value: string) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const parsePositiveInteger = (value: string, fallback: number) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const buildMonitoringSettingsFromDraft = (draft: MonitoringSettingsDraft): MonitoringSettings => ({
  retentionDays: parseNonNegativeInteger(draft.retentionDays),
  webdav: {
    enabled: draft.webdavEnabled,
    intervalMinutes: parsePositiveInteger(draft.webdavIntervalMinutes, 1440),
    retentionDays: parseNonNegativeInteger(draft.webdavRetentionDays),
    url: draft.webdavUrl.trim(),
    username: draft.webdavUsername.trim(),
    password: draft.webdavPassword,
  },
});


const SuccessFailureValue = ({ success, failure }: { success: number; failure: number }) => (
  <span className={styles.successFailureValue}>
    <span className={styles.goodText}>{formatCompactNumber(success)}</span>
    <span className={styles.badText}>({formatCompactNumber(failure)})</span>
  </span>
);

const getRankingMetricValue = (row: MonitoringAccountRow, metric: RankingMetric) => {
  if (metric === 'cost') return row.totalCost;
  if (metric === 'tokens') return row.totalTokens;
  return row.totalCalls;
};

const getAccountSortValue = (row: MonitoringAccountRow, metric: AccountSortMetric) => {
  if (metric === 'recent') return row.lastSeenAt;
  return getRankingMetricValue(row, metric);
};

const getRankingMetricLabel = (metric: RankingMetric, t: TFunction) => {
  if (metric === 'cost') return t('monitoring.ranking_metric_cost');
  if (metric === 'tokens') return t('monitoring.ranking_metric_tokens');
  return t('monitoring.ranking_metric_requests');
};

const getRankingSummaryLabel = (metric: RankingMetric, t: TFunction) => {
  if (metric === 'cost') return t('monitoring.ranking_summary_cost');
  if (metric === 'tokens') return t('monitoring.ranking_summary_tokens');
  return t('monitoring.ranking_summary_calls');
};

const formatRankingMetricValue = (value: number, metric: RankingMetric, hasPrices: boolean) => {
  if (metric === 'cost') return hasPrices ? formatUsd(value) : '--';
  return formatCompactNumber(value);
};

const getAccountHealthTone = (row: MonitoringAccountRow): AccountHealthTone => {
  if (row.successRate >= 0.95) return 'good';
  if (row.successRate >= 0.85) return 'warn';
  return 'bad';
};

const RankingMetricSwitch = ({
  value,
  onChange,
  disabledCost,
  t,
}: {
  value: RankingMetric;
  onChange: (value: RankingMetric) => void;
  disabledCost: boolean;
  t: TFunction;
}) => (
  <div className={styles.rankingMetricSwitch} role="group" aria-label={t('monitoring.ranking_metric_aria')}>
    {RANKING_METRIC_OPTIONS.map((option) => (
      <button
        key={option.value}
        type="button"
        className={`${styles.rankingMetricButton} ${value === option.value ? styles.rankingMetricButtonActive : ''}`}
        onClick={() => onChange(option.value)}
        disabled={option.value === 'cost' && disabledCost}
      >
        {t(option.labelKey)}
      </button>
    ))}
  </div>
);

const buildAccountCardFileName = (row: MonitoringAccountRow, quotaEntries: AccountQuotaEntry[] = []) => {
  const quotaFileNames = Array.from(new Set(quotaEntries.map((entry) => entry.fileName).filter(Boolean)));
  if (quotaFileNames.length > 0) return joinUnique(quotaFileNames, 1);

  const fileName = row.authLabels.find((label) => label && label !== '-' && label.endsWith('.json'));
  return fileName || row.authLabels.find((label) => label && label !== '-') || row.accountMasked || row.account;
};

const buildAccountCardProviderText = (row: MonitoringAccountRow) => {
  const providers = row.providers.filter((provider) => provider && provider !== '-');
  return providers.length > 0 ? joinUnique(providers, 2) : '-';
};

const sortAccountOverviewCardMetrics = (metrics: AccountSummaryMetric[], t: TFunction) => {
  const labels: Record<string, string> = {
    'total-tokens': t('monitoring.token_metric_total'),
    'input-tokens': t('monitoring.token_metric_input'),
    'output-tokens': t('monitoring.token_metric_output'),
    'cached-tokens': t('monitoring.token_metric_cached'),
  };
  const order = ['total-tokens', 'input-tokens', 'output-tokens', 'cached-tokens'];
  return order
    .map((key) => {
      const metric = metrics.find((item) => item.key === key);
      return metric ? { ...metric, label: labels[key] } : undefined;
    })
    .filter(Boolean) as AccountSummaryMetric[];
};

const buildAccountSummaryMetrics = (
  row: MonitoringAccountRow,
  hasPrices: boolean,
  locale: string,
  t: TFunction
): AccountSummaryMetric[] => [
  {
    key: 'total-calls',
    label: t('monitoring.total_calls'),
    value: formatCompactNumber(row.totalCalls),
  },
  {
    key: 'success-calls',
    label: t('monitoring.success_calls'),
    value: <SuccessFailureValue success={row.successCalls} failure={row.failureCalls} />,
  },
  {
    key: 'success-rate',
    label: t('monitoring.call_success_rate'),
    value: formatPercent(row.successRate),
    valueClassName:
      row.successRate >= 0.95
        ? styles.goodText
        : row.successRate >= 0.85
          ? styles.warnText
          : styles.badText,
  },
  {
    key: 'total-tokens',
    label: t('monitoring.total_tokens'),
    value: formatCompactNumber(row.totalTokens),
  },
  {
    key: 'input-tokens',
    label: t('monitoring.input_tokens'),
    value: formatCompactNumber(row.inputTokens),
  },
  {
    key: 'output-tokens',
    label: t('monitoring.output_tokens'),
    value: formatCompactNumber(row.outputTokens),
  },
  {
    key: 'cached-tokens',
    label: t('monitoring.cached_tokens'),
    value: formatCompactNumber(row.cachedTokens),
  },
  {
    key: 'estimated-cost',
    label: t('monitoring.estimated_cost'),
    value: hasPrices ? formatUsd(row.totalCost) : '--',
  },
  {
    key: 'latest-request-time',
    label: t('monitoring.latest_request_time'),
    value: new Date(row.lastSeenAt).toLocaleString(locale),
  },
];

type AnyQuotaConfig = QuotaConfig<any, any>;

type AccountQuotaTarget = {
  key: string;
  authIndex: string;
  authLabel: string;
  fileName: string;
  file: AuthFileItem;
  config: AnyQuotaConfig;
};

type AccountQuotaEntry = {
  key: string;
  authLabel: string;
  fileName: string;
  providerLabel: string;
  quota?: QuotaStatusState;
  config: AnyQuotaConfig;
};

type AccountQuotaState = {
  status: 'idle' | 'loading' | 'success' | 'error';
  targetKey: string;
  error?: string;
  lastRefreshedAt?: number;
};

type AccountQuotaSourceRow = Pick<MonitoringEventRow, 'authIndex' | 'account' | 'authLabel'>;

type AccountSummaryMetric = {
  key: string;
  label: string;
  value: ReactNode;
  valueClassName?: string;
};

const formatPercent = (value: number) => `${(value * 100).toFixed(1)}%`;

const getProgressWidth = (value: number) => {
  if (value <= 0) return '0%';
  return `${Math.max(value * 100, 1.5)}%`;
};

const getChartAxisLabels = <T extends { key: string; label: string }>(points: T[]) => {
  if (points.length <= 10) {
    return points.map((point, index) => ({ key: point.key, label: point.label, index }));
  }

  const step = Math.ceil((points.length - 1) / 8);
  const labels = points
    .map((point, index) => ({ key: point.key, label: point.label, index }))
    .filter((_, index) => index % step === 0);
  const last = points[points.length - 1];
  if (!labels.some((item) => item.key === last.key)) {
    labels.push({ key: last.key, label: last.label, index: points.length - 1 });
  }
  return labels;
};

const buildUsageTrendRangeLabel = (range: MonitoringTimeRange, t: TFunction) => {
  if (range === 'all') return t('monitoring.all_retained_logs');

  const nowMs = Date.now();
  return `${formatShortDateTime(getRangeStartMs(range, nowMs))} - ${formatShortDateTime(nowMs)}`;
};

const getEmptyTrendPoint = (key: string, label: string): TrendPoint => ({
  key,
  label,
  requests: 0,
  failures: 0,
  tokens: 0,
  cost: 0,
});

const buildFilledTrendBuckets = (range: MonitoringTimeRange, nowMs: number) => {
  if (range === 'all') return [];

  const startMs = getRangeStartMs(range, nowMs);
  const buckets: TrendPoint[] = [];
  const cursor = new Date(startMs);

  if (range === 'today') {
    const now = new Date(nowMs);
    cursor.setMinutes(0, 0, 0);
    while (cursor.getTime() <= now.getTime()) {
      const dayKey = buildLocalDayKey(cursor.getTime());
      const label = buildHourLabel(cursor.getTime());
      buckets.push(getEmptyTrendPoint(`${dayKey} ${label}`, label));
      cursor.setHours(cursor.getHours() + 1);
    }
    return buckets;
  }

  cursor.setHours(0, 0, 0, 0);
  const end = new Date(nowMs);
  end.setHours(0, 0, 0, 0);
  while (cursor.getTime() <= end.getTime()) {
    const key = buildLocalDayKey(cursor.getTime());
    buckets.push(getEmptyTrendPoint(key, buildDayLabel(key)));
    cursor.setDate(cursor.getDate() + 1);
  }
  return buckets;
};

const buildTimeBucketMeta = (range: MonitoringTimeRange) => {
  const useHourly = range === 'today';
  return {
    useHourly,
    getKey: (row: MonitoringEventRow) => (useHourly ? `${row.dayKey} ${row.hourLabel}` : row.dayKey),
    getLabel: (row: MonitoringEventRow) => (useHourly ? row.hourLabel : buildDayLabel(row.dayKey)),
  };
};

const createRankingRowAccumulator = (
  row: MonitoringEventRow,
  group: 'apiKey' | 'model'
): RankingRowAccumulator => {
  if (group === 'apiKey') {
    return {
      id: row.clientApiKey.id,
      group,
      model: '-',
      apiKeyHash: row.clientApiKey.hash,
      apiKeyMasked: row.clientApiKey.masked,
      account: row.clientApiKey.masked,
      accountMasked: row.clientApiKey.masked,
      authLabels: new Set(),
      authIndices: new Set(),
      channels: new Set(),
      providers: new Set(),
      totalCalls: 0,
      successCalls: 0,
      failureCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      latencySum: 0,
      latencyCount: 0,
      lastSeenAt: 0,
    };
  }

  return {
    id: `model:${row.model}`,
    group,
    model: row.model,
    apiKeyHash: '-',
    apiKeyMasked: '-',
    account: row.model,
    accountMasked: row.model,
    authLabels: new Set(),
    authIndices: new Set(),
    channels: new Set(),
    providers: new Set(),
    totalCalls: 0,
    successCalls: 0,
    failureCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    latencySum: 0,
    latencyCount: 0,
    lastSeenAt: 0,
  };
};

const addRankingRow = (accumulator: RankingRowAccumulator, row: MonitoringEventRow) => {
  accumulator.authLabels.add(row.authLabel);
  accumulator.authIndices.add(row.authIndexMasked);
  accumulator.channels.add(row.channel);
  accumulator.providers.add(row.provider);
  accumulator.totalCalls += 1;
  accumulator.successCalls += row.failed ? 0 : 1;
  accumulator.failureCalls += row.failed ? 1 : 0;
  accumulator.inputTokens += row.inputTokens;
  accumulator.outputTokens += row.outputTokens;
  accumulator.cachedTokens += row.cachedTokens;
  accumulator.totalTokens += row.totalTokens;
  accumulator.totalCost += row.totalCost;
  accumulator.lastSeenAt = Math.max(accumulator.lastSeenAt, row.timestampMs);

  if (row.latencyMs !== null) {
    accumulator.latencySum += row.latencyMs;
    accumulator.latencyCount += 1;
  }
};

const finalizeRankingRows = (grouped: Map<string, RankingRowAccumulator>): MonitoringAccountRow[] =>
  Array.from(grouped.values()).map((item) => ({
    id: item.id,
    group: item.group,
    model: item.model,
    apiKeyHash: item.apiKeyHash,
    apiKeyMasked: item.apiKeyMasked,
    account: item.account,
    accountMasked: item.accountMasked,
    authLabels: Array.from(item.authLabels).sort(),
    authIndices: Array.from(item.authIndices).sort(),
    channels: Array.from(item.channels).sort(),
    providers: Array.from(item.providers).sort(),
    totalCalls: item.totalCalls,
    successCalls: item.successCalls,
    failureCalls: item.failureCalls,
    successRate: item.totalCalls > 0 ? item.successCalls / item.totalCalls : 1,
    inputTokens: item.inputTokens,
    outputTokens: item.outputTokens,
    cachedTokens: item.cachedTokens,
    totalTokens: item.totalTokens,
    totalCost: item.totalCost,
    averageLatencyMs: item.latencyCount > 0 ? item.latencySum / item.latencyCount : null,
    lastSeenAt: item.lastSeenAt,
    recentPattern: [],
    models: [],
  }));

const buildUsageTrendAnalytics = (
  rows: MonitoringEventRow[],
  range: MonitoringTimeRange,
  apiKeyFilter: string,
  allApiKeyLabel: string
): UsageTrendAnalytics => {
  const nowMs = Date.now();
  const prefilled = buildFilledTrendBuckets(range, nowMs);
  const trendGrouped = new Map<string, TrendPoint>(prefilled.map((point) => [point.key, point]));
  const tokenGrouped = new Map<string, TokenDistributionPoint>();
  const modelGrouped = new Map<string, RankingRowAccumulator>();
  const apiKeyGrouped = new Map<string, RankingRowAccumulator>();
  const apiKeyLabels = new Map<string, string>();
  const { getKey, getLabel } = buildTimeBucketMeta(range);
  const scopedTotals: Record<RankingMetric, number> = {
    requests: 0,
    tokens: 0,
    cost: 0,
  };

  rows.forEach((row) => {
    const apiKeyHash = row.clientApiKey.hash;
    if (apiKeyHash && apiKeyHash !== '-') {
      apiKeyLabels.set(apiKeyHash, row.clientApiKey.masked);
    }

    const apiKeyAccumulator = apiKeyGrouped.get(row.clientApiKey.id) ?? createRankingRowAccumulator(row, 'apiKey');
    addRankingRow(apiKeyAccumulator, row);
    apiKeyGrouped.set(apiKeyAccumulator.id, apiKeyAccumulator);

    if (apiKeyFilter !== 'all' && apiKeyHash !== apiKeyFilter) {
      return;
    }

    const key = getKey(row);
    const label = getLabel(row);
    const trendPoint = trendGrouped.get(key) ?? {
      key,
      label,
      requests: 0,
      failures: 0,
      tokens: 0,
      cost: 0,
    };
    trendPoint.requests += 1;
    trendPoint.failures += row.failed ? 1 : 0;
    trendPoint.tokens += row.totalTokens;
    trendPoint.cost += row.totalCost;
    trendGrouped.set(key, trendPoint);

    const tokenPoint = tokenGrouped.get(key) ?? {
      key,
      label,
      requests: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      totalCost: 0,
    };
    tokenPoint.requests += 1;
    tokenPoint.totalTokens += row.totalTokens;
    tokenPoint.inputTokens += row.inputTokens;
    tokenPoint.outputTokens += row.outputTokens;
    tokenPoint.reasoningTokens += row.reasoningTokens;
    tokenPoint.cachedTokens += row.cachedTokens;
    tokenPoint.totalCost += row.totalCost;
    tokenGrouped.set(key, tokenPoint);

    const modelAccumulator = modelGrouped.get(row.model) ?? createRankingRowAccumulator(row, 'model');
    addRankingRow(modelAccumulator, row);
    modelGrouped.set(row.model, modelAccumulator);

    scopedTotals.requests += 1;
    scopedTotals.tokens += row.totalTokens;
    scopedTotals.cost += row.totalCost;
  });

  const apiKeyOptions = [
    { value: 'all', label: allApiKeyLabel },
    ...Array.from(apiKeyLabels.entries())
      .sort((left, right) => left[1].localeCompare(right[1]))
      .map(([value, label]) => ({ value, label })),
  ];

  return {
    apiKeyOptions,
    trendPoints: Array.from(trendGrouped.values()).sort((left, right) => left.key.localeCompare(right.key)).slice(-24),
    tokenDistributionPoints: Array.from(tokenGrouped.values()).sort((left, right) => left.key.localeCompare(right.key)).slice(-24),
    modelRows: finalizeRankingRows(modelGrouped),
    apiKeyRows: finalizeRankingRows(apiKeyGrouped),
    scopedTotals,
  };
};

const calculateAggregateCost = (
  item: Pick<UsageAggregateBucket, 'model' | 'inputTokens' | 'outputTokens' | 'cacheTokens'>,
  modelPrices: Record<string, ModelPrice>
) => calculateCost({
  __modelName: item.model || '',
  tokens: {
    input_tokens: item.inputTokens,
    output_tokens: item.outputTokens,
    cached_tokens: item.cacheTokens,
    cache_tokens: item.cacheTokens,
  },
}, modelPrices);

const createAggregateRankingRow = (
  item: UsageAggregateBucket,
  group: 'apiKey' | 'model',
  modelPrices: Record<string, ModelPrice>,
  apiKeyLabels: Map<string, string>
): MonitoringAccountRow => {
  const model = item.model || '-';
  const apiKeyHash = item.apiKeyHash || '-';
  const apiKeyMasked = apiKeyLabels.get(apiKeyHash) || maskSensitiveText(apiKeyHash);
  const totalCost = calculateAggregateCost(item, modelPrices);
  return {
    id: group === 'model' ? `model:${model}` : `clientApiKey:${apiKeyHash}`,
    group,
    model: group === 'model' ? model : '-',
    apiKeyHash: group === 'apiKey' ? apiKeyHash : '-',
    apiKeyMasked: group === 'apiKey' ? apiKeyMasked : '-',
    account: group === 'model' ? model : apiKeyMasked,
    accountMasked: group === 'model' ? model : apiKeyMasked,
    authLabels: [],
    authIndices: [],
    channels: [],
    providers: item.provider ? [item.provider] : [],
    totalCalls: item.totalRequests,
    successCalls: item.successCount,
    failureCalls: item.failureCount,
    successRate: item.totalRequests > 0 ? item.successCount / item.totalRequests : 1,
    inputTokens: item.inputTokens,
    outputTokens: item.outputTokens,
    cachedTokens: item.cacheTokens,
    totalTokens: item.totalTokens,
    totalCost,
    averageLatencyMs: item.avgLatencyMs ?? null,
    lastSeenAt: item.bucketStartMs,
    recentPattern: [],
    models: [],
  };
};

const buildServerUsageTrendAnalytics = (
  aggregates: ReturnType<typeof useUsageAggregates>['data'],
  range: MonitoringTimeRange,
  modelPrices: Record<string, ModelPrice>,
  apiKeyOptions: Array<{ value: string; label: string }>,
  apiKeyFilter: string
): UsageTrendAnalytics | null => {
  if (!aggregates) return null;
  const nowMs = Date.now();
  const prefilled = buildFilledTrendBuckets(range, nowMs);
  const trendGrouped = new Map<string, TrendPoint>(prefilled.map((point) => [point.key, point]));
  const tokenGrouped = new Map<string, TokenDistributionPoint>();
  const apiKeyLabels = new Map(apiKeyOptions.map((option) => [option.value, option.label]));
  aggregates.apiKeys.forEach((item) => {
    const apiKeyHash = item.apiKeyHash?.trim();
    if (apiKeyHash && !apiKeyLabels.has(apiKeyHash)) {
      apiKeyLabels.set(apiKeyHash, maskSensitiveText(apiKeyHash));
    }
  });
  const resolvedApiKeyOptions = [
    apiKeyOptions.find((option) => option.value === 'all') ?? { value: 'all', label: 'All' },
    ...Array.from(apiKeyLabels.entries())
      .filter(([value]) => value !== 'all')
      .sort((left, right) => left[1].localeCompare(right[1]))
      .map(([value, label]) => ({ value, label })),
  ];
  const modelRowMap = new Map<string, MonitoringAccountRow>();
  aggregates.models
    .filter((item) => apiKeyFilter === 'all' || item.apiKeyHash === apiKeyFilter)
    .forEach((item) => {
      const row = createAggregateRankingRow(item, 'model', modelPrices, apiKeyLabels);
      const current = modelRowMap.get(row.model);
      if (!current) {
        modelRowMap.set(row.model, row);
        return;
      }
      const previousCalls = current.totalCalls;
      current.totalCalls += row.totalCalls;
      current.successCalls += row.successCalls;
      current.failureCalls += row.failureCalls;
      current.inputTokens += row.inputTokens;
      current.outputTokens += row.outputTokens;
      current.cachedTokens += row.cachedTokens;
      current.totalTokens += row.totalTokens;
      current.totalCost += row.totalCost;
      current.lastSeenAt = Math.max(current.lastSeenAt, row.lastSeenAt);
      if (row.averageLatencyMs !== null) {
        const weightedCurrent = (current.averageLatencyMs ?? 0) * previousCalls;
        current.averageLatencyMs = (weightedCurrent + row.averageLatencyMs * row.totalCalls) / Math.max(current.totalCalls, 1);
      }
      current.successRate = current.totalCalls > 0 ? current.successCalls / current.totalCalls : 1;
    });
  const modelRows = Array.from(modelRowMap.values());
  const apiKeyRowMap = new Map<string, MonitoringAccountRow>();
  aggregates.apiKeys.filter((item) => item.apiKeyHash).forEach((item) => {
    const row = createAggregateRankingRow(item, 'apiKey', modelPrices, apiKeyLabels);
    const current = apiKeyRowMap.get(row.apiKeyHash);
    if (!current) {
      apiKeyRowMap.set(row.apiKeyHash, row);
      return;
    }
    current.totalCalls += row.totalCalls;
    current.successCalls += row.successCalls;
    current.failureCalls += row.failureCalls;
    current.inputTokens += row.inputTokens;
    current.outputTokens += row.outputTokens;
    current.cachedTokens += row.cachedTokens;
    current.totalTokens += row.totalTokens;
    current.totalCost += row.totalCost;
    current.lastSeenAt = Math.max(current.lastSeenAt, row.lastSeenAt);
    current.successRate = current.totalCalls > 0 ? current.successCalls / current.totalCalls : 1;
  });
  const apiKeyRows = Array.from(apiKeyRowMap.values());

  aggregates.trend.forEach((item) => {
    const timestampMs = Number(item.bucketStartMs) || Date.parse(item.bucketStart);
    const dayKey = buildLocalDayKey(timestampMs);
    const useHourly = range === 'today';
    const key = useHourly ? `${dayKey} ${buildHourLabel(timestampMs)}` : dayKey;
    const label = useHourly ? buildHourLabel(timestampMs) : buildDayLabel(dayKey);
    const cost = calculateAggregateCost(item, modelPrices);
    const trendPoint = trendGrouped.get(key) ?? getEmptyTrendPoint(key, label);
    trendPoint.requests += item.totalRequests;
    trendPoint.failures += item.failureCount;
    trendPoint.tokens += item.totalTokens;
    trendPoint.cost += cost;
    trendGrouped.set(key, trendPoint);

    const tokenPoint = tokenGrouped.get(key) ?? {
      key,
      label,
      requests: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      totalCost: 0,
    };
    tokenPoint.requests += item.totalRequests;
    tokenPoint.totalTokens += item.totalTokens;
    tokenPoint.inputTokens += item.inputTokens;
    tokenPoint.outputTokens += item.outputTokens;
    tokenPoint.reasoningTokens += item.reasoningTokens;
    tokenPoint.cachedTokens += item.cacheTokens;
    tokenPoint.totalCost += cost;
    tokenGrouped.set(key, tokenPoint);
  });

  const scopedTotals = modelRows.reduce<Record<RankingMetric, number>>((totals, row) => ({
    requests: totals.requests + row.totalCalls,
    tokens: totals.tokens + row.totalTokens,
    cost: totals.cost + row.totalCost,
  }), { requests: 0, tokens: 0, cost: 0 });

  return {
    apiKeyOptions: resolvedApiKeyOptions,
    trendPoints: Array.from(trendGrouped.values()).sort((left, right) => left.key.localeCompare(right.key)).slice(-24),
    tokenDistributionPoints: Array.from(tokenGrouped.values()).sort((left, right) => left.key.localeCompare(right.key)).slice(-24),
    modelRows,
    apiKeyRows,
    scopedTotals,
  };
};

const buildAggregateSummary = (
  buckets: UsageAggregateBucket[],
  modelPrices: Record<string, ModelPrice>
): MonitoringSummary => {
  let totalCalls = 0;
  let successCalls = 0;
  let failureCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cachedTokens = 0;
  let totalTokens = 0;
  let totalCost = 0;
  let weightedLatency = 0;
  let latencyCalls = 0;
  buckets.forEach((bucket) => {
    totalCalls += bucket.totalRequests;
    successCalls += bucket.successCount;
    failureCalls += bucket.failureCount;
    inputTokens += bucket.inputTokens;
    outputTokens += bucket.outputTokens;
    reasoningTokens += bucket.reasoningTokens;
    cachedTokens += bucket.cacheTokens;
    totalTokens += bucket.totalTokens;
    totalCost += calculateAggregateCost(bucket, modelPrices);
    if (typeof bucket.avgLatencyMs === 'number' && bucket.totalRequests > 0) {
      weightedLatency += bucket.avgLatencyMs * bucket.totalRequests;
      latencyCalls += bucket.totalRequests;
    }
  });
  return {
    totalCalls,
    successCalls,
    failureCalls,
    successRate: totalCalls > 0 ? successCalls / totalCalls : 1,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedTokens,
    totalTokens,
    totalCost,
    averageLatencyMs: latencyCalls > 0 ? weightedLatency / latencyCalls : null,
    rpm30m: 0,
    tpm30m: 0,
    avgDailyRequests: 0,
    avgDailyTokens: 0,
    approxTasks: 0,
    approxTaskFailures: 0,
    approxTaskSuccessRate: 1,
    zeroTokenCalls: 0,
    zeroTokenModels: [],
  };
};

const buildServerAccountRows = (
  buckets: UsageAggregateBucket[],
  realtimeRows: MonitoringEventRow[],
  authFilesByAuthIndex: Map<string, AuthFileItem>,
  modelPrices: Record<string, ModelPrice>,
  deletedCredentialLabel: string
): MonitoringAccountRow[] => {
  const metadataByAuthIndex = new Map<string, MonitoringEventRow>();
  const realtimeRowsByAuthIndex = new Map<string, MonitoringEventRow[]>();
  realtimeRows.forEach((row) => {
    if (row.authIndex !== '-' && !metadataByAuthIndex.has(row.authIndex)) {
      metadataByAuthIndex.set(row.authIndex, row);
    }
    if (row.authIndex !== '-') {
      const items = realtimeRowsByAuthIndex.get(row.authIndex) ?? [];
      items.push(row);
      realtimeRowsByAuthIndex.set(row.authIndex, items);
    }
  });
  const grouped = new Map<string, MonitoringAccountRow>();
  buckets.forEach((bucket) => {
    const authIndex = normalizeAuthIndex(bucket.authIndex) ?? '-';
    const metadata = metadataByAuthIndex.get(authIndex);
    const authFile = authFilesByAuthIndex.get(authIndex);
    const authFileLabel = authFile
      ? [authFile.email, authFile.account, authFile.label, authFile.name]
          .map((value) => typeof value === 'string' ? value.trim() : '')
          .find(Boolean) || ''
      : '';
    const fallbackAccount = authIndex === '-' ? deletedCredentialLabel : maskSensitiveText(authIndex);
    const account = metadata?.account || metadata?.authLabel || authFileLabel || fallbackAccount;
    const accountMasked = metadata?.accountMasked || metadata?.authIndexMasked || maskSensitiveText(account);
    const provider = bucket.provider || metadata?.provider || '-';
    const channel = metadata?.channel || provider;
    const id = `account:${account}::${channel}`;
    const current = grouped.get(id) ?? {
      id,
      group: 'account',
      model: '-',
      apiKeyHash: '-',
      apiKeyMasked: '-',
      account,
      accountMasked,
      authLabels: [],
      authIndices: [],
      channels: [],
      providers: [],
      totalCalls: 0,
      successCalls: 0,
      failureCalls: 0,
      successRate: 1,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      averageLatencyMs: null,
      lastSeenAt: 0,
      recentPattern: [],
      rows: [],
      models: [],
    } satisfies MonitoringAccountRow;
    current.totalCalls += bucket.totalRequests;
    current.successCalls += bucket.successCount;
    current.failureCalls += bucket.failureCount;
    current.inputTokens += bucket.inputTokens;
    current.outputTokens += bucket.outputTokens;
    current.cachedTokens += bucket.cacheTokens;
    current.totalTokens += bucket.totalTokens;
    current.totalCost += calculateAggregateCost(bucket, modelPrices);
    current.lastSeenAt = Math.max(current.lastSeenAt, Number(bucket.lastSeenAtMs) || bucket.bucketStartMs || 0);
    current.successRate = current.totalCalls > 0 ? current.successCalls / current.totalCalls : 1;
    current.authLabels = Array.from(new Set([...current.authLabels, metadata?.authLabel || account]));
    current.authIndices = Array.from(new Set([...current.authIndices, metadata?.authIndexMasked || maskSensitiveText(authIndex)]));
    current.channels = Array.from(new Set([...current.channels, channel]));
    current.providers = Array.from(new Set([...current.providers, provider]));
    current.rows = Array.from(new Map([
      ...(current.rows ?? []).map((row) => [row.id, row] as const),
      ...(realtimeRowsByAuthIndex.get(authIndex) ?? []).map((row) => [row.id, row] as const),
    ]).values());
    current.recentPattern = (current.rows ?? []).slice(0, 10).reverse().map((row) => !row.failed);
    const existingModel = current.models.find((item) => item.model === (bucket.model || '-'));
    const modelCost = calculateAggregateCost(bucket, modelPrices);
    if (existingModel) {
      existingModel.totalCalls += bucket.totalRequests;
      existingModel.successCalls += bucket.successCount;
      existingModel.failureCalls += bucket.failureCount;
      existingModel.inputTokens += bucket.inputTokens;
      existingModel.outputTokens += bucket.outputTokens;
      existingModel.cachedTokens += bucket.cacheTokens;
      existingModel.totalTokens += bucket.totalTokens;
      existingModel.totalCost += modelCost;
      existingModel.lastSeenAt = Math.max(existingModel.lastSeenAt, Number(bucket.lastSeenAtMs) || 0);
      existingModel.successRate = existingModel.totalCalls > 0 ? existingModel.successCalls / existingModel.totalCalls : 1;
    } else {
      current.models.push({
        model: bucket.model || '-',
        totalCalls: bucket.totalRequests,
        successCalls: bucket.successCount,
        failureCalls: bucket.failureCount,
        successRate: bucket.totalRequests > 0 ? bucket.successCount / bucket.totalRequests : 1,
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        cachedTokens: bucket.cacheTokens,
        totalTokens: bucket.totalTokens,
        totalCost: modelCost,
        lastSeenAt: Number(bucket.lastSeenAtMs) || 0,
      });
    }
    grouped.set(id, current);
  });
  return Array.from(grouped.values()).map((row) => ({
    ...row,
    models: [...row.models].sort((left, right) => right.totalCost - left.totalCost || right.totalCalls - left.totalCalls),
  }));
};

const roundCurrency = (value: number) => Math.round(value * 100) / 100;

const formatDeltaPercent = (current: number, previous: number) => {
  const roundedCurrent = roundCurrency(current);
  const roundedPrevious = roundCurrency(previous);
  if (roundedPrevious <= 0) return roundedCurrent > 0 ? '+100.0%' : '0.0%';
  const delta = (roundedCurrent - roundedPrevious) / roundedPrevious;
  return `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}%`;
};

const createPriceDraft = (price?: ModelPrice): PriceDraft => ({
  prompt: price ? String(price.prompt) : '',
  completion: price ? String(price.completion) : '',
  cache: price ? String(price.cache) : '',
});

const parsePriceValue = (value: string) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const formatPriceUnit = (value: number) => `$${value.toFixed(4)}/1M`;

const buildRealtimeMetaText = (row: MonitoringEventRow) => {
  const parts = [`${row.endpointMethod} ${row.endpointPath}`.trim()];
  const text = parts.filter(Boolean).join(' · ');
  return maskSensitiveText(text || '-');
};

const buildRealtimeDiagnosticText = (row: MonitoringEventRow) => {
  const parts: string[] = [];
  if (row.statusCode !== null && row.statusCode >= 400) {
    parts.push(`HTTP ${row.statusCode}`);
  }
  if (row.errorCode) parts.push(row.errorCode);
  if (row.retryAfter) parts.push(`Retry ${row.retryAfter}`);
  return maskSensitiveText(parts.join(' · '));
};

const buildRealtimeStatusCodeText = (row: Pick<MonitoringEventRow, 'statusCode' | 'errorCode'>) => {
  if (row.statusCode !== null && row.statusCode >= 400) return String(row.statusCode);
  return row.errorCode ? maskSensitiveText(row.errorCode) : '';
};

const buildRealtimeStatusLabel = (
  row: Pick<MonitoringEventRow, 'failed' | 'statusCode' | 'errorCode'>,
  label: string
) => {
  if (!row.failed) return label;
  const codeText = buildRealtimeStatusCodeText(row);
  return codeText ? `${label} · ${codeText}` : label;
};

const compactRealtimeErrorMessage = (message: string, maxLength = 220) => {
  const masked = maskSensitiveText(message.replace(/\s+/g, ' ').trim());
  return masked.length > maxLength ? `${masked.slice(0, maxLength - 1)}...` : masked;
};

const resolveRealtimeErrorCategoryKey = (row: MonitoringEventRow) => {
  const code = row.errorCode.toLowerCase();
  const message = row.errorMessage.toLowerCase();
  const status = row.statusCode;
  const combined = `${code} ${message}`;

  if (status === 401 || status === 403 || /\b(auth|unauthorized|forbidden|invalid[_ -]?key|permission)\b/.test(combined)) {
    return 'monitoring.error_category_auth';
  }
  if (status === 429 || /\b(rate[_ -]?limit|too many requests|quota|insufficient_quota)\b/.test(combined)) {
    return 'monitoring.error_category_rate_limit';
  }
  if (status === 400 || /\b(bad[_ -]?request|invalid[_ -]?request|validation)\b/.test(combined)) {
    return 'monitoring.error_category_bad_request';
  }
  if (status === 404 || /\b(model.*not.*found|not[_ -]?found|404)\b/.test(combined)) {
    return 'monitoring.error_category_not_found';
  }
  if (/\b(timeout|deadline|context canceled|connection reset|econnreset|network)\b/.test(combined)) {
    return 'monitoring.error_category_network';
  }
  if (status !== null && status >= 500) {
    return 'monitoring.error_category_upstream';
  }
  return row.failed ? 'monitoring.error_category_unknown' : 'monitoring.error_category_none';
};

const REALTIME_ERROR_TEXT_FALLBACKS = {
  en: {
    error_details: 'Error Details',
    error_details_click_hint: 'Click to view error details',
    error_details_modal_desc: 'Only fields directly related to the failed request are shown here.',
    error_category: 'Error Category',
    error_category_none: 'No Error',
    error_category_auth: 'Auth / Permission',
    error_category_rate_limit: 'Rate Limit / Quota',
    error_category_bad_request: 'Bad Request',
    error_category_not_found: 'Not Found',
    error_category_network: 'Network / Timeout',
    error_category_upstream: 'Upstream Error',
    error_category_unknown: 'Unknown Error',
    http_status: 'HTTP Status',
    error_code: 'Error Code',
    error_message: 'Error Message',
    upstream_request_id: 'Upstream Request ID',
    retry_after: 'Retry After',
    copy_diagnostic: 'Copy Diagnostic',
    copy_diagnostic_success: 'Diagnostic copied',
    copy_diagnostic_failed: 'Unable to copy diagnostic',
    request_status: 'Request Status',
    filter_provider: 'Provider',
    column_model: 'Model',
  },
  ru: {
    error_details: 'Детали ошибки',
    error_details_click_hint: 'Нажмите, чтобы посмотреть детали ошибки',
    error_details_modal_desc: 'Здесь показаны только поля, напрямую связанные с ошибкой запроса.',
    error_category: 'Категория ошибки',
    error_category_none: 'Нет ошибки',
    error_category_auth: 'Авторизация / права',
    error_category_rate_limit: 'Лимит / квота',
    error_category_bad_request: 'Некорректный запрос',
    error_category_not_found: 'Не найдено',
    error_category_network: 'Сеть / тайм-аут',
    error_category_upstream: 'Ошибка upstream',
    error_category_unknown: 'Неизвестная ошибка',
    http_status: 'HTTP статус',
    error_code: 'Код ошибки',
    error_message: 'Сообщение ошибки',
    upstream_request_id: 'Upstream request ID',
    retry_after: 'Повторить после',
    copy_diagnostic: 'Скопировать диагностику',
    copy_diagnostic_success: 'Диагностика скопирована',
    copy_diagnostic_failed: 'Не удалось скопировать диагностику',
    request_status: 'Статус запроса',
    filter_provider: 'Провайдер',
    column_model: 'Модель',
  },
  zhCN: {
    error_details: '错误详情',
    error_details_click_hint: '点击查看错误详情',
    error_details_modal_desc: '这里只显示和本次请求失败直接相关的字段。',
    error_category: '错误类别',
    error_category_none: '无错误',
    error_category_auth: '鉴权 / 权限',
    error_category_rate_limit: '限流 / 配额',
    error_category_bad_request: '请求参数错误',
    error_category_not_found: '资源不存在',
    error_category_network: '网络 / 超时',
    error_category_upstream: '上游错误',
    error_category_unknown: '未知错误',
    http_status: 'HTTP 状态',
    error_code: '错误码',
    error_message: '错误信息',
    upstream_request_id: '上游请求 ID',
    retry_after: '重试等待',
    copy_diagnostic: '复制诊断',
    copy_diagnostic_success: '诊断信息已复制',
    copy_diagnostic_failed: '无法复制诊断信息',
    request_status: '请求状态',
    filter_provider: '提供商',
    column_model: '模型',
  },
  zhTW: {
    error_details: '錯誤詳情',
    error_details_click_hint: '點擊查看錯誤詳情',
    error_details_modal_desc: '這裡只顯示與本次請求失敗直接相關的欄位。',
    error_category: '錯誤類別',
    error_category_none: '無錯誤',
    error_category_auth: '驗證 / 權限',
    error_category_rate_limit: '限流 / 配額',
    error_category_bad_request: '請求參數錯誤',
    error_category_not_found: '資源不存在',
    error_category_network: '網路 / 逾時',
    error_category_upstream: '上游錯誤',
    error_category_unknown: '未知錯誤',
    http_status: 'HTTP 狀態',
    error_code: '錯誤碼',
    error_message: '錯誤訊息',
    upstream_request_id: '上游請求 ID',
    retry_after: '重試等待',
    copy_diagnostic: '複製診斷',
    copy_diagnostic_success: '診斷資訊已複製',
    copy_diagnostic_failed: '無法複製診斷資訊',
    request_status: '請求狀態',
    filter_provider: '提供商',
    column_model: '模型',
  },
} as const;

type RealtimeErrorTextKey = keyof typeof REALTIME_ERROR_TEXT_FALLBACKS.en;

const resolveRealtimeErrorFallbackLocale = (language?: string) => {
  const normalized = language?.toLowerCase() ?? '';
  if (normalized.startsWith('zh-tw') || normalized.startsWith('zh-hk') || normalized.startsWith('zh-mo')) return 'zhTW';
  if (normalized.startsWith('zh')) return 'zhCN';
  if (normalized.startsWith('ru')) return 'ru';
  return 'en';
};

const translateRealtimeErrorText = (
  key: RealtimeErrorTextKey,
  t: ReturnType<typeof useTranslation>['t'],
  language?: string
) => {
  const fallbackLocale = resolveRealtimeErrorFallbackLocale(language);
  const fallback = REALTIME_ERROR_TEXT_FALLBACKS[fallbackLocale][key] ?? REALTIME_ERROR_TEXT_FALLBACKS.en[key];
  return t(`monitoring.${key}`, { defaultValue: fallback });
};

const translateRealtimeErrorCategory = (
  key: string,
  t: ReturnType<typeof useTranslation>['t'],
  language?: string
) => {
  switch (key) {
    case 'monitoring.error_category_auth':
      return translateRealtimeErrorText('error_category_auth', t, language);
    case 'monitoring.error_category_rate_limit':
      return translateRealtimeErrorText('error_category_rate_limit', t, language);
    case 'monitoring.error_category_bad_request':
      return translateRealtimeErrorText('error_category_bad_request', t, language);
    case 'monitoring.error_category_not_found':
      return translateRealtimeErrorText('error_category_not_found', t, language);
    case 'monitoring.error_category_network':
      return translateRealtimeErrorText('error_category_network', t, language);
    case 'monitoring.error_category_upstream':
      return translateRealtimeErrorText('error_category_upstream', t, language);
    case 'monitoring.error_category_none':
      return translateRealtimeErrorText('error_category_none', t, language);
    case 'monitoring.error_category_unknown':
    default:
      return translateRealtimeErrorText('error_category_unknown', t, language);
  }
};

const buildRealtimeErrorSummary = (row: MonitoringEventRow) => {
  if (!row.failed) return '';
  const parts: string[] = [];
  if (row.errorMessage) parts.push(compactRealtimeErrorMessage(row.errorMessage));
  if (!row.errorMessage && row.errorCode) parts.push(maskSensitiveText(row.errorCode));
  if (row.upstreamRequestId) parts.push(`RID ${maskSensitiveText(row.upstreamRequestId)}`);
  if (row.retryAfter) parts.push(`Retry ${maskSensitiveText(row.retryAfter)}`);
  return parts.join(' · ');
};

const buildRealtimeDiagnosticClipboardText = (
  row: RealtimeLogRow,
  t: ReturnType<typeof useTranslation>['t'],
  language?: string
) => {
  const fields: Array<[string, string | number | null | undefined]> = [
    [translateRealtimeErrorText('request_status', t, language), row.failed ? t('monitoring.result_failed') : t('monitoring.result_success')],
    [translateRealtimeErrorText('error_category', t, language), translateRealtimeErrorCategory(row.errorCategoryKey, t, language)],
    [translateRealtimeErrorText('http_status', t, language), row.statusCode ?? '-'],
    [translateRealtimeErrorText('error_code', t, language), row.errorCode || '-'],
    [translateRealtimeErrorText('error_message', t, language), row.errorMessage ? compactRealtimeErrorMessage(row.errorMessage, 800) : '-'],
    [translateRealtimeErrorText('upstream_request_id', t, language), row.upstreamRequestId || '-'],
    [translateRealtimeErrorText('retry_after', t, language), row.retryAfter || '-'],
    [translateRealtimeErrorText('filter_provider', t, language), row.provider || '-'],
    [translateRealtimeErrorText('column_model', t, language), row.model || '-'],
  ];
  return fields.map(([label, value]) => `${label}: ${maskSensitiveText(String(value ?? '-'))}`).join('\n');
};

const QUOTA_RENDER_HELPERS: QuotaRenderHelpers = {
  styles: quotaStyles,
  QuotaProgressBar,
};

const getQuotaProviderLabel = (config: AnyQuotaConfig, t: TFunction) => {
  const titleKey = `${config.i18nPrefix}.title`;
  const translated = t(titleKey);
  if (translated !== titleKey) return translated;
  return config.type;
};

const getAccountQuotaConfig = (file: AuthFileItem): AnyQuotaConfig | undefined => {
  if (isAntigravityFile(file)) return ANTIGRAVITY_CONFIG;
  if (isClaudeFile(file)) return CLAUDE_CONFIG;
  if (isCodexFile(file)) return CODEX_CONFIG;
  if (isKimiFile(file)) return KIMI_CONFIG;
  if (isXaiFile(file)) return XAI_CONFIG;
  return undefined;
};

const resolveQuotaErrorMessage = (t: TFunction, quota?: QuotaStatusState): string => {
  if (!quota) return t('common.unknown_error');
  if (quota.errorStatus === 404) return t('common.quota_update_required');
  if (quota.errorStatus === 403) return t('common.quota_check_credential');
  return quota.error || t('common.unknown_error');
};

const hasUsableQuotaContent = (quota?: QuotaStatusState) => {
  if (!quota || quota.status !== 'success') return false;
  const record = quota as unknown as Record<string, unknown>;
  const billing = record.billing;
  return ['groups', 'windows', 'buckets', 'rows'].some((key) => {
    const value = record[key];
    return Array.isArray(value) && value.length > 0;
  }) || Boolean(
    record.planType
    || record.tierLabel
    || record.creditBalance !== undefined
    || (billing && typeof billing === 'object' && !Array.isArray(billing))
  );
};

const getQuotaForTarget = (store: QuotaStore, target: AccountQuotaTarget): QuotaStatusState | undefined => {
  return target.config.storeSelector(store)[target.fileName] as QuotaStatusState | undefined;
};

const requestAccountQuota = async (
  target: AccountQuotaTarget,
  t: TFunction
): Promise<QuotaStatusState> => {
  try {
    const data = await target.config.fetchQuota(target.file, t);
    return target.config.buildSuccessState(data) as QuotaStatusState;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : t('common.unknown_error');
    return target.config.buildErrorState(message, getStatusFromError(err)) as QuotaStatusState;
  }
};

const settleWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<Array<PromiseSettledResult<R>>> => {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }));
  return results;
};

const buildAccountQuotaTargetsByAccount = (
  rows: AccountQuotaSourceRow[],
  authFilesByAuthIndex: Map<string, AuthFileItem>
) => {
  const grouped = new Map<string, Map<string, AccountQuotaTarget>>();

  rows.forEach((row) => {
    const authIndex = normalizeAuthIndex(row.authIndex);
    if (!authIndex || !row.account) return;

    const file = authFilesByAuthIndex.get(authIndex);
    if (!file) return;

    const quotaConfig = getAccountQuotaConfig(file);
    if (!quotaConfig) return;

    const dedupeKey = `${quotaConfig.type}::${authIndex}::${file.name}`;
    const bucket = grouped.get(row.account) ?? new Map<string, AccountQuotaTarget>();
    if (!bucket.has(dedupeKey)) {
      bucket.set(dedupeKey, {
        key: dedupeKey,
        authIndex,
        authLabel: row.authLabel || file.name || authIndex,
        fileName: file.name,
        file,
        config: quotaConfig,
      });
    }
    grouped.set(row.account, bucket);
  });

  return new Map(
    Array.from(grouped.entries()).map(([account, bucket]) => [
      account,
      Array.from(bucket.values()).sort((left, right) => left.authLabel.localeCompare(right.authLabel)),
    ])
  );
};

const buildAccountQuotaEntriesByAccount = (
  targetsByAccount: Map<string, AccountQuotaTarget[]>,
  quotaStore: QuotaStore,
  t: TFunction
) => new Map(
  Array.from(targetsByAccount.entries()).map(([account, targets]) => [
    account,
    targets.map((target) => ({
      key: target.key,
      authLabel: target.authLabel,
      fileName: target.fileName,
      providerLabel: getQuotaProviderLabel(target.config, t),
      quota: getQuotaForTarget(quotaStore, target),
      config: target.config,
    } satisfies AccountQuotaEntry)),
  ])
);

const buildRealtimeLogPageRows = (
  rows: MonitoringEventRow[],
  page: number,
  pageSize: number
): { total: number; rows: RealtimeLogRow[] } => {
  const candidateRows = rows.length > REALTIME_LOG_ENRICH_LIMIT
    ? rows.slice(0, REALTIME_LOG_ENRICH_LIMIT)
    : rows;
  const metricsByStream = new Map<string, { total: number; success: number; pattern: boolean[] }>();
  const normalizedPage = Math.max(1, page);
  const pageStart = (normalizedPage - 1) * pageSize;
  const pageEnd = Math.min(pageStart + pageSize, candidateRows.length);
  const enriched = new Array<RealtimeLogRow>(Math.max(pageEnd - pageStart, 0));

  for (let index = candidateRows.length - 1; index >= 0; index -= 1) {
    const row = candidateRows[index];
    const streamKey = [row.account, row.provider, row.model, row.modelAlias, row.channel].join('::');
    const previous = metricsByStream.get(streamKey) ?? { total: 0, success: 0, pattern: [] };
    const nextPattern = [...previous.pattern, !row.failed].slice(-10);
    const next = {
      total: previous.total + (row.statsIncluded ? 1 : 0),
      success: previous.success + (row.statsIncluded && !row.failed ? 1 : 0),
      pattern: nextPattern,
    };
    metricsByStream.set(streamKey, next);

    if (index >= pageStart && index < pageEnd) {
      let recentSuccessCount = 0;
      nextPattern.forEach((item) => {
        if (item) recentSuccessCount += 1;
      });
      enriched[index - pageStart] = {
        ...row,
        streamKey,
        diagnosticText: buildRealtimeDiagnosticText(row),
        errorCategoryKey: resolveRealtimeErrorCategoryKey(row),
        errorSummary: buildRealtimeErrorSummary(row),
        requestCount: next.total,
        successRate: next.total > 0 ? next.success / next.total : 1,
        recentPattern: nextPattern,
        recentSuccessCount,
        recentFailureCount: nextPattern.length - recentSuccessCount,
      };
    }
  }

  return { total: candidateRows.length, rows: enriched };
};

const getClientPaginationRange = (page: number, pageSize: number, total: number, visibleCount: number) => {
  const normalizedPage = Math.max(1, page);
  const totalPages = total > 0 ? Math.ceil(total / pageSize) : 0;
  const from = total > 0 && visibleCount > 0 ? (normalizedPage - 1) * pageSize + 1 : 0;
  return {
    page: normalizedPage,
    total,
    totalPages,
    from,
    to: visibleCount > 0 ? Math.min(total, from + visibleCount - 1) : 0,
    hasPrevious: normalizedPage > 1,
    hasNext: normalizedPage < totalPages,
  };
};

function UsageTrendHeader({
  range,
  totalCalls,
  apiKeyFilter,
  apiKeyOptions,
  onRangeChange,
  onApiKeyFilterChange,
  onHide,
  t,
}: {
  range: MonitoringTimeRange;
  totalCalls: number;
  apiKeyFilter: string;
  apiKeyOptions: Array<{ value: string; label: string }>;
  onRangeChange: (range: MonitoringTimeRange) => void;
  onApiKeyFilterChange: (value: string) => void;
  onHide: () => void;
  t: TFunction;
}) {
  return (
    <div className={styles.usageTrendHeader}>
      <div className={styles.usageTrendCopy}>
        <h2>{t('monitoring.usage_stats_title')}</h2>
        <p>{t('monitoring.usage_stats_desc', { value: formatCompactNumber(totalCalls) })}</p>
      </div>
      <button type="button" className={`${styles.rankingMetricButton} ${styles.usageTrendHideButton} ${styles.mobileHeaderHideButton}`} onClick={onHide}>
        {t('monitoring.hide_analysis')}
      </button>
      <div className={styles.usageTrendActions}>
        <div className={`${styles.rankingMetricSwitch} ${styles.timeRangeControl}`}>
          {TIME_RANGE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`${styles.rankingMetricButton} ${styles.timeRangeButton} ${range === option.value ? styles.rankingMetricButtonActive : ''}`}
              onClick={() => onRangeChange(option.value)}
            >
              {t(option.labelKey)}
            </button>
          ))}
        </div>
        <Select
          className={styles.usageTrendApiKeySelect}
          value={apiKeyFilter}
          options={apiKeyOptions}
          onChange={onApiKeyFilterChange}
          ariaLabel={t('monitoring.filter_usage_trend_api_key')}
          fullWidth={false}
        />
        <button type="button" className={`${styles.rankingMetricButton} ${styles.usageTrendHideButton}`} onClick={onHide}>
          {t('monitoring.hide_analysis')}
        </button>
      </div>
    </div>
  );
}

function TopUsageStats({ cards }: { cards: UsageMetricCard[] }) {
  return (
    <section className={styles.usageStatsGrid} aria-label="Usage statistics">
      {cards.map((card) => (
        <Card key={card.key} className={`${styles.usageStatsCard} ${card.key === 'tokens' ? styles.usageStatsCardTokens : ''}`}>
          <div className={styles.usageStatsCardHeader}>
            <span className={`${styles.usageStatsIcon} ${styles[`usageStatsIcon${card.accent}`]}`} aria-hidden="true" />
            <strong>{card.title}</strong>
          </div>
          <div className={styles.usageStatsBody}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
          </div>
          <div className={styles.usageStatsFooter}>
            {card.footer.map((item) => (
              <div key={item.label}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </section>
  );
}

function UsageTrendPanel({
  points,
  hasPrices,
  emptyText,
  t,
}: {
  points: TrendPoint[];
  hasPrices: boolean;
  emptyText: string;
  t: TFunction;
}) {
  const chartPoints = points.slice(-30);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const chartViewBoxHeight = 310;
  const [chartViewBoxWidth, setChartViewBoxWidth] = useState(700);
  const rightLabelX = chartViewBoxWidth - 8;
  const plot = {
    left: 36,
    top: 38,
    right: rightLabelX - 144,
    costAxis: rightLabelX - 88,
    tokenAxis: rightLabelX - 42,
    tokenLabel: rightLabelX,
    bottom: 278,
  };
  const requestMax = Math.max(...chartPoints.map((point) => point.requests), 0);
  const tokenMax = Math.max(...chartPoints.map((point) => point.tokens), 0);
  const costMax = Math.max(...chartPoints.map((point) => point.cost), 0);
  const requestAxisMax = Math.max(10, Math.ceil(requestMax * 1.1));
  const tokenAxisMax = Math.max(1000, Math.ceil(tokenMax * 1.1));
  const costAxisMax = Math.max(0.1, costMax * 1.1);
  const series = [
    {
      key: 'tokens',
      label: t('monitoring.ranking_metric_tokens'),
      color: '#7c3aed',
      axis: 'tokens',
      getValue: (point: TrendPoint) => point.tokens,
      format: (value: number) => formatCompactNumber(value),
    },
    {
      key: 'requests',
      label: t('monitoring.ranking_metric_requests'),
      color: '#2563eb',
      axis: 'requests',
      getValue: (point: TrendPoint) => point.requests,
      format: (value: number) => formatCompactNumber(value),
    },
    {
      key: 'cost',
      label: t('monitoring.ranking_metric_cost'),
      color: '#047857',
      axis: 'cost',
      getValue: (point: TrendPoint) => point.cost,
      format: (value: number) => (hasPrices ? formatUsd(value) : '--'),
    },
  ] as const;
  const visibleSeries = hasPrices ? series : series.filter((item) => item.key !== 'cost');
  const totals = chartPoints.reduce(
    (sum, point) => ({
      requests: sum.requests + point.requests,
      failures: sum.failures + point.failures,
      tokens: sum.tokens + point.tokens,
      cost: sum.cost + point.cost,
    }),
    { requests: 0, failures: 0, tokens: 0, cost: 0 }
  );
  const peakTokenPoint = chartPoints.reduce<TrendPoint | null>(
    (peak, point) => (!peak || point.tokens > peak.tokens ? point : peak),
    null
  );
  const summaryItems = [
    { key: 'requests', label: t('monitoring.total_requests_label'), value: formatCompactNumber(totals.requests), color: '#2563eb' },
    { key: 'tokens', label: t('monitoring.total_tokens_label'), value: formatCompactNumber(totals.tokens), color: '#7c3aed' },
    ...(hasPrices ? [{ key: 'cost', label: t('monitoring.total_cost_label'), value: formatUsd(totals.cost), color: '#059669' }] : []),
    { key: 'peak', label: t('monitoring.peak_period'), value: peakTokenPoint?.label ?? '--', color: '#f97316' },
  ];
  const trendMinutes = Math.max(chartPoints.length * 60, 1);
  const headerStats = [
    { key: 'rpm', label: 'RPM', value: (totals.requests / trendMinutes).toFixed(2) },
    { key: 'tpm', label: 'TPM', value: formatCompactNumber(totals.tokens / trendMinutes) },
    { key: 'errorRate', label: t('monitoring.error_rate'), value: formatPercent(totals.requests > 0 ? totals.failures / totals.requests : 0) },
  ];
  const axisTicks = [0, 0.25, 0.5, 0.75, 1];
  const getAxisMax = (axis: typeof series[number]['axis']) => {
    if (axis === 'tokens') return tokenAxisMax;
    if (axis === 'cost') return costAxisMax;
    return requestAxisMax;
  };
  const getX = (index: number) => chartPoints.length <= 1
    ? (plot.left + plot.right) / 2
    : plot.left + (index / (chartPoints.length - 1)) * (plot.right - plot.left);
  const getY = (value: number, axis: typeof series[number]['axis']) => {
    const max = getAxisMax(axis);
    return plot.bottom - Math.max(Math.min(value / max, 1), 0) * (plot.bottom - plot.top);
  };
  const buildPath = (item: typeof series[number]) => {
    const coords = chartPoints.map((point, index) => ({
      x: getX(index),
      y: getY(item.getValue(point), item.axis),
    }));
    if (coords.length === 0) return '';
    if (coords.length === 1) return `M ${coords[0].x} ${coords[0].y}`;
    return coords.slice(1).reduce((path, point, index) => {
      const previous = coords[index];
      const midX = (previous.x + point.x) / 2;
      return `${path} C ${midX} ${previous.y}, ${midX} ${point.y}, ${point.x} ${point.y}`;
    }, `M ${coords[0].x} ${coords[0].y}`);
  };
  const buildAreaPath = (item: typeof series[number]) => {
    const path = buildPath(item);
    return path ? `${path} L ${getX(chartPoints.length - 1)} ${plot.bottom} L ${getX(0)} ${plot.bottom} Z` : '';
  };
  const labels = getChartAxisLabels(chartPoints);
  const hoveredPoint = hoveredIndex === null ? null : chartPoints[hoveredIndex];
  const hoveredX = hoveredIndex === null ? 0 : getX(hoveredIndex);
  const tooltipX = Math.min(Math.max(hoveredX - 84, plot.left + 8), plot.right - 168);
  const formatCostAxisValue = (value: number) => `$${formatCompactNumber(value)}`;

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const updateViewBoxWidth = () => {
      const rect = svg.getBoundingClientRect();
      const nextWidth = Math.max(700, Math.round((rect.width / Math.max(rect.height, 1)) * chartViewBoxHeight));
      setChartViewBoxWidth((current) => current === nextWidth ? current : nextWidth);
    };

    updateViewBoxWidth();
    const observer = new ResizeObserver(updateViewBoxWidth);
    observer.observe(svg);
    return () => observer.disconnect();
  }, [chartViewBoxHeight]);

  return (
    <Card className={`${styles.usageTrendChartCard} ${styles.usageTrendLineCard}`}>
      <div className={styles.trendCardHeader}>
        <div>
          <h3>{t('monitoring.usage_trend_chart_title')}</h3>
          <p>{t('monitoring.usage_trend_chart_desc')}</p>
        </div>
        <div className={styles.trendHeaderStats}>
          {headerStats.map((item) => (
            <div key={item.key}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>
      </div>
      {chartPoints.length > 0 ? (
        <div className={styles.professionalChartShell}>
          <div className={styles.trendSummaryStrip}>
            {summaryItems.map((item) => (
              <div key={item.key} className={styles.trendSummaryItem} style={{ '--series-color': item.color } as CSSProperties}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>
          <svg ref={svgRef} className={styles.usageTrendSvg} viewBox={`0 0 ${chartViewBoxWidth} ${chartViewBoxHeight}`} role="img" aria-label={t('monitoring.usage_trend_chart_aria')}>
            <defs>
              <linearGradient id="usageTrendTokensFill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="5%" stopColor="#7c3aed" stopOpacity="0.24" />
                <stop offset="95%" stopColor="#7c3aed" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="usageTrendRequestsFill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="5%" stopColor="#2563eb" stopOpacity="0.16" />
                <stop offset="95%" stopColor="#2563eb" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="usageTrendCostFill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="5%" stopColor="#047857" stopOpacity="0.24" />
                <stop offset="95%" stopColor="#047857" stopOpacity="0" />
              </linearGradient>
            </defs>
            {axisTicks.map((tick) => {
              const y = plot.bottom - tick * (plot.bottom - plot.top);
              return (
                <g key={tick}>
                  {tick > 0 ? <line className={styles.chartGridLine} x1={plot.left} x2={plot.costAxis} y1={y} y2={y} /> : null}
                  <text className={`${styles.chartAxisLabel} ${styles.chartAxisLabelRequests}`} x={plot.left - 12} y={y + 4}>
                    {formatCompactNumber(requestAxisMax * tick)}
                  </text>
                  {hasPrices ? (
                    <text className={`${styles.chartAxisLabel} ${styles.chartAxisLabelCost}`} x={plot.costAxis - 12} y={y + 4}>
                      {formatCostAxisValue(costAxisMax * tick)}
                    </text>
                  ) : null}
                  <text className={`${styles.chartAxisLabel} ${styles.chartAxisLabelTokens}`} x={plot.tokenLabel} y={y + 4}>
                    {formatCompactNumber(tokenAxisMax * tick)}
                  </text>
                </g>
              );
            })}
            <line className={styles.chartAxisBase} x1={plot.left} x2={plot.costAxis} y1={plot.bottom} y2={plot.bottom} />
            <line className={styles.chartYAxisRequests} x1={plot.left} x2={plot.left} y1={plot.top} y2={plot.bottom} />
            {hasPrices ? <line className={styles.chartYAxisCost} x1={plot.costAxis} x2={plot.costAxis} y1={plot.top} y2={plot.bottom} /> : null}
            <line className={styles.chartYAxisTokens} x1={plot.tokenAxis} x2={plot.tokenAxis} y1={plot.top} y2={plot.bottom} />
            {visibleSeries.map((item) => {
              const path = buildPath(item);
              const area = buildAreaPath(item);
              return (
                <g key={item.key}>
                  {area ? <path className={styles.trendAreaFill} d={area} fill={`url(#usageTrend${item.key[0].toUpperCase()}${item.key.slice(1)}Fill)`} /> : null}
                  <path className={styles.trendSeriesLine} d={path} stroke={item.color} />
                </g>
              );
            })}
            {labels.map((item) => (
              <g key={item.key}>
                <line className={styles.chartXAxisTick} x1={getX(item.index)} x2={getX(item.index)} y1={plot.bottom} y2={plot.bottom + 7} />
                <text className={styles.chartXAxisLabel} x={getX(item.index)} y="300">{item.label}</text>
              </g>
            ))}
            {chartPoints.map((point, index) => {
              const x = getX(index);
              const isHovered = hoveredIndex === index;
              return (
                <g
                  key={point.key}
                  className={styles.trendHoverTarget}
                  onMouseEnter={() => setHoveredIndex(index)}
                  onMouseLeave={() => setHoveredIndex(null)}
                  onFocus={() => setHoveredIndex(index)}
                  onBlur={() => setHoveredIndex(null)}
                  tabIndex={0}
                >
                  <rect x={Math.max(plot.left, x - 14)} y={plot.top - 10} width="28" height={plot.bottom - plot.top + 26} fill="transparent" />
                  {isHovered ? <line className={styles.trendHoverGuide} x1={x} x2={x} y1={plot.top} y2={plot.bottom} /> : null}
                  {isHovered ? visibleSeries.map((item) => (
                    <circle
                      key={item.key}
                      className={styles.trendSeriesDot}
                      cx={x}
                      cy={getY(item.getValue(point), item.axis)}
                      r={4.5}
                      stroke={item.color}
                    />
                  )) : null}
                </g>
              );
            })}
            {hoveredPoint ? (
              <g className={styles.trendTooltipLayer}>
                <rect x={tooltipX} y="82" width="168" height={hasPrices ? 118 : 92} rx="12" />
                <text className={styles.trendTooltipTitle} x={tooltipX + 16} y="108">{hoveredPoint.label}</text>
                {visibleSeries.map((item, index) => (
                  <text key={item.key} className={styles.trendTooltipMetric} x={tooltipX + 16} y={136 + index * 25} fill={item.color}>
                    {`${item.label}：${item.format(item.getValue(hoveredPoint))}`}
                  </text>
                ))}
              </g>
            ) : null}
          </svg>
          <div className={styles.trendChartLegend}>
            {visibleSeries.map((item) => (
              <span key={item.key} style={{ '--series-color': item.color } as CSSProperties}>
                {item.label}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <div className={styles.emptyBlockSmall}>{emptyText}</div>
      )}
    </Card>
  );
}

function TokenDistributionPanel({
  points,
  emptyText,
  hasPrices,
  t,
}: {
  points: TokenDistributionPoint[];
  emptyText: string;
  hasPrices: boolean;
  t: TFunction;
}) {
  const totals = points.reduce(
    (sum, point) => ({
      requests: sum.requests + point.requests,
      totalTokens: sum.totalTokens + point.totalTokens,
      inputTokens: sum.inputTokens + point.inputTokens,
      outputTokens: sum.outputTokens + point.outputTokens,
      reasoningTokens: sum.reasoningTokens + point.reasoningTokens,
      cachedTokens: sum.cachedTokens + point.cachedTokens,
      totalCost: sum.totalCost + point.totalCost,
    }),
    { requests: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, totalCost: 0 }
  );
  const tokenMinutes = Math.max(points.length * 60, 1);
  const rpm = totals.requests / tokenMinutes;
  const tpm = totals.totalTokens / tokenMinutes;
  const rows = [
    { key: 'rpm', label: 'RPM', value: rpm, displayValue: rpm.toFixed(2), base: 0, accent: 'Purple', showShare: false },
    { key: 'tpm', label: 'TPM', value: tpm, displayValue: formatCompactNumber(tpm), base: 0, accent: 'Blue', showShare: false },
    { key: 'requests', label: t('monitoring.request_count'), value: totals.requests, displayValue: formatCompactNumber(totals.requests), base: 0, accent: 'Cyan', showShare: false },
    { key: 'total', label: t('monitoring.total_tokens_label'), value: totals.totalTokens, displayValue: formatCompactNumber(totals.totalTokens), base: 0, accent: 'Green', showShare: false },
    { key: 'input', label: t('monitoring.token_metric_input'), value: totals.inputTokens, displayValue: formatCompactNumber(totals.inputTokens), base: totals.totalTokens, accent: 'Amber', showShare: true },
    { key: 'output', label: t('monitoring.token_metric_output'), value: totals.outputTokens, displayValue: formatCompactNumber(totals.outputTokens), base: totals.totalTokens, accent: 'Rose', showShare: true },
    { key: 'reasoning', label: t('monitoring.token_metric_reasoning'), value: totals.reasoningTokens, displayValue: formatCompactNumber(totals.reasoningTokens), base: totals.totalTokens, accent: 'Indigo', showShare: true },
    { key: 'cached', label: t('monitoring.token_metric_cached'), value: totals.cachedTokens, displayValue: formatCompactNumber(totals.cachedTokens), base: totals.totalTokens, accent: 'Slate', showShare: true },
  ];
  const hasData = rows.some((row) => row.value > 0);

  return (
    <Card className={`${styles.usageTrendChartCard} ${styles.tokenDistributionCard}`}>
      <div className={`${styles.trendCardHeader} ${styles.tokenDistributionHeader}`}>
        <div>
          <h3>{t('monitoring.token_stats_title')}</h3>
          <p>{t('monitoring.token_stats_desc')}</p>
        </div>
        <div className={styles.tokenCostBadge}>
          <span>{t('monitoring.token_cost')}</span>
          <strong>{hasPrices ? formatUsd(totals.totalCost) : '--'}</strong>
        </div>
      </div>
      {hasData ? (
        <div className={styles.tokenStatCardList}>
          {rows.map((row) => {
            const share = row.base > 0 ? row.value / row.base : 0;
            return (
              <div key={row.key} className={`${styles.tokenStatCard} ${styles[`tokenStatCard${row.accent}`]}`}>
                <div className={styles.tokenStatCardHeader}>
                  <span>{row.label}</span>
                  {row.showShare ? <strong>{formatPercent(share)}</strong> : null}
                </div>
                <div className={styles.tokenStatCardValue}>{row.displayValue}</div>
                {row.showShare ? (
                  <div className={styles.tokenStatProgressTrack} aria-hidden="true">
                    <span style={{ '--token-stat-width': `${Math.min(Math.max(share * 100, row.value > 0 ? 1 : 0), 100)}%` } as CSSProperties} />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className={styles.emptyBlockSmall}>{emptyText}</div>
      )}
    </Card>
  );
}

function ModelStatsPanel({
  title,
  subtitle,
  rows,
  metric,
  metricTotal,
  onMetricChange,
  emptyText,
  hasPrices,
  t,
}: {
  title: string;
  subtitle: string;
  rows: MonitoringAccountRow[];
  metric: RankingMetric;
  metricTotal: number;
  onMetricChange: (metric: RankingMetric) => void;
  emptyText: string;
  hasPrices: boolean;
  t: TFunction;
}) {
  const shareBase = metricTotal > 0 ? metricTotal : rows.reduce((sum, row) => sum + getRankingMetricValue(row, metric), 0);
  const shareModeLabel = t('monitoring.share_by_metric', { metric: getRankingMetricLabel(metric, t) });
  const totalShareValue = formatRankingMetricValue(shareBase, metric, hasPrices);
  const legendRows = rows.slice(0, 5);
  const donutTooltipRows = rows
    .map((row) => {
      const value = getRankingMetricValue(row, metric);
      return {
        row,
        value,
        share: shareBase > 0 ? value / shareBase : 0,
      };
    })
    .filter((item) => item.value > 0);
  const donutStops = legendRows.reduce(
    (state, row, index) => {
      const value = getRankingMetricValue(row, metric);
      const share = shareBase > 0 ? (value / shareBase) * 100 : 0;
      const end = state.offset + share;
      state.parts.push(`${getDonutColor(index)} ${state.offset}% ${end}%`);
      state.offset = end;
      return state;
    },
    { offset: 0, parts: [] as string[] }
  );
  const donutBackground = donutStops.parts.length > 0
    ? `conic-gradient(${donutStops.parts.join(', ')}, color-mix(in srgb, var(--monitor-line) 58%, transparent) ${donutStops.offset}% 100%)`
    : 'color-mix(in srgb, var(--monitor-line) 58%, transparent)';

  return (
    <Card className={styles.modelStatsCard}>
      <div className={styles.rankingHeader}>
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
        <RankingMetricSwitch value={metric} onChange={onMetricChange} disabledCost={!hasPrices} t={t} />
      </div>
      {rows.length > 0 ? (
        <div className={styles.modelStatsLayout}>
          <div className={styles.modelStatsList}>
            {rows.map((row) => {
              const rowValue = getRankingMetricValue(row, metric);
              const value = shareBase > 0 ? rowValue / shareBase : 0;
              return (
                <div key={row.id} className={styles.modelStatsRow}>
                  <div className={styles.modelStatsMain}>
                    <div className={styles.modelStatsTitleLine}>
                      <strong>{row.account}</strong>
                      <span>{formatPercent(value)}</span>
                    </div>
                    <div className={styles.modelStatsMetaLine}>
                      <span>{`${formatCompactNumber(row.totalCalls)} ${t('monitoring.ranking_metric_requests')}`}</span>
                      <span>{`${formatCompactNumber(row.totalTokens)} ${t('monitoring.ranking_metric_tokens')}`}</span>
                      <span>{`${formatCompactNumber(row.failureCalls)} ${t('monitoring.errors_label')}`}</span>
                      <span>{hasPrices ? formatUsd(row.totalCost) : '--'}</span>
                    </div>
                    <span
                      className={styles.modelStatsBar}
                      style={{ '--ranking-width': getProgressWidth(value) } as CSSProperties}
                      aria-hidden="true"
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <aside className={styles.modelSharePanel}>
            <div className={styles.modelShareHeader}>
              <strong>{t('monitoring.model_share_title')}</strong>
              <span>{shareModeLabel}</span>
            </div>
            <div className={styles.donutChart} style={{ '--donut-bg': donutBackground } as CSSProperties}>
              <div className={styles.donutCenter}>
                <span>{getRankingSummaryLabel(metric, t)}</span>
                <strong>{totalShareValue}</strong>
              </div>
              <div className={styles.donutTooltip}>
                <strong>{t('monitoring.share_tooltip_title', { metric: shareModeLabel })}</strong>
                <div>
                  {donutTooltipRows.map((item, index) => (
                    <span key={item.row.id}>
                      <i style={{ background: getDonutColor(index) }} aria-hidden="true" />
                      <em>{item.row.account}</em>
                      <b>{formatPercent(item.share)}</b>
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <div className={styles.modelLegend}>
              {legendRows.map((row, index) => {
                const rowValue = getRankingMetricValue(row, metric);
                const value = shareBase > 0 ? rowValue / shareBase : 0;
                return (
                  <div key={row.id} className={styles.modelLegendItem} style={{ '--legend-color': getDonutColor(index) } as CSSProperties}>
                    <span className={styles.modelLegendDot} />
                    <span>{row.account}</span>
                    <strong>{formatPercent(value)}</strong>
                  </div>
                );
              })}
            </div>
          </aside>
        </div>
      ) : (
        <div className={styles.emptyBlockSmall}>{emptyText}</div>
      )}
    </Card>
  );
}

function ApiKeyRankingPanel({
  title,
  subtitle,
  rows,
  metric,
  metricTotal,
  onMetricChange,
  emptyText,
  hasPrices,
  t,
}: {
  title: string;
  subtitle: string;
  rows: MonitoringAccountRow[];
  metric: RankingMetric;
  metricTotal: number;
  onMetricChange: (metric: RankingMetric) => void;
  emptyText: string;
  hasPrices: boolean;
  t: TFunction;
}) {
  const shareBase = metricTotal > 0 ? metricTotal : rows.reduce((sum, row) => sum + getRankingMetricValue(row, metric), 0);
  const summaryLabel = getRankingSummaryLabel(metric, t);

  return (
    <Card className={styles.apiKeyRankingCard}>
      <div className={styles.rankingHeader}>
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
        <RankingMetricSwitch value={metric} onChange={onMetricChange} disabledCost={!hasPrices} t={t} />
      </div>
      <div className={styles.apiKeyRankingList}>
        {rows.length > 0 ? (
          <div className={styles.apiKeyRankingSummary}>
            <span>{summaryLabel}</span>
            <strong>{formatRankingMetricValue(shareBase, metric, hasPrices)}</strong>
            <small>{t('monitoring.api_keys_count', { count: rows.length })}</small>
          </div>
        ) : null}
        {rows.length > 0 ? (
          <div className={styles.apiKeyRankingScroll}>
            {rows.map((row, index) => {
              const rowValue = getRankingMetricValue(row, metric);
              const share = shareBase > 0 ? rowValue / shareBase : 0;
              return (
                <div key={row.id} className={styles.apiKeyRankingRow}>
                  <div className={styles.apiKeyRankingTopLine}>
                    <div className={styles.apiKeyRankingName}>
                      <span className={styles.rankingIndex}>{index + 1}</span>
                      <strong>{row.account}</strong>
                    </div>
                    <span>{formatPercent(share)}</span>
                  </div>
                  <div className={styles.apiKeyRankingMetaLine}>
                    <span>{`${formatCompactNumber(row.totalCalls)} ${t('monitoring.ranking_metric_requests')}`}</span>
                    <span>{`${formatCompactNumber(row.totalTokens)} Token`}</span>
                    <span>{`${formatCompactNumber(row.failureCalls)} ${t('monitoring.errors_label')}`}</span>
                    <span>{hasPrices ? formatUsd(row.totalCost) : '--'}</span>
                  </div>
                  <span
                    className={styles.apiKeyRankingBar}
                    style={{ '--ranking-width': getProgressWidth(share) } as CSSProperties}
                    aria-hidden="true"
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <div className={styles.emptyBlockSmall}>{emptyText}</div>
        )}
      </div>
    </Card>
  );
}

function MonitoringHealthStatusBar({
  statusData,
  locale,
  t,
  showRate = true,
}: {
  statusData: AccountStatusData;
  locale: string;
  t: TFunction;
  showRate?: boolean;
}) {
  const [activeTooltip, setActiveTooltip] = useState<number | null>(null);
  const [focusIndex, setFocusIndex] = useState(() => (statusData.blockDetails.length > 0 ? 0 : -1));
  const blocksRef = useRef<HTMLDivElement | null>(null);
  const blockButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tooltipIdPrefix = useId();
  const blockCount = statusData.blockDetails.length;
  const resolvedFocusIndex = blockCount === 0 ? -1 : focusIndex >= 0 && focusIndex < blockCount ? focusIndex : 0;
  const resolvedActiveTooltip = activeTooltip !== null && activeTooltip >= 0 && activeTooltip < blockCount ? activeTooltip : null;
  const hasData = statusData.totalSuccess + statusData.totalFailure > 0;
  const rateClassName = !hasData
    ? ''
    : statusData.successRate >= 90
      ? styles.monitoringStatusRateHigh
      : statusData.successRate >= 50
        ? styles.monitoringStatusRateMedium
        : styles.monitoringStatusRateLow;

  useEffect(() => {
    if (resolvedActiveTooltip === null) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (blocksRef.current && !blocksRef.current.contains(event.target as Node)) {
        setActiveTooltip(null);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [resolvedActiveTooltip]);

  const handlePointerEnter = useCallback((event: React.PointerEvent, index: number) => {
    if (event.pointerType === 'mouse') {
      setActiveTooltip(index);
    }
  }, []);

  const handlePointerLeave = useCallback((event: React.PointerEvent) => {
    if (event.pointerType === 'mouse' && (!blocksRef.current || !blocksRef.current.contains(document.activeElement))) {
      setActiveTooltip(null);
    }
  }, []);

  const handlePointerDown = useCallback((event: React.PointerEvent, index: number) => {
    if (event.pointerType === 'touch') {
      event.preventDefault();
      setFocusIndex(index);
      setActiveTooltip((previous) => (previous === index ? null : index));
    }
  }, []);

  const focusBlock = useCallback((index: number) => {
    blockButtonRefs.current[index]?.focus();
    setFocusIndex(index);
    setActiveTooltip(index);
  }, []);

  const handleFocus = useCallback((index: number) => {
    setFocusIndex(index);
    setActiveTooltip(index);
  }, []);

  const handleBlur = useCallback((event: React.FocusEvent<HTMLButtonElement>) => {
    if (blocksRef.current?.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setActiveTooltip(null);
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      if (event.key === 'Escape') {
        setActiveTooltip(null);
        return;
      }

      const nextIndex = getNextAccountStatusBlockIndex(index, event.key, blockCount);
      if (nextIndex === null) return;

      event.preventDefault();
      focusBlock(nextIndex);
    },
    [blockCount, focusBlock]
  );

  const getTooltipPositionClassName = (index: number, total: number) => {
    if (index <= 2) return styles.monitoringStatusTooltipLeft;
    if (index >= total - 3) return styles.monitoringStatusTooltipRight;
    return '';
  };

  const renderTooltip = (detail: AccountStatusBlockDetail, index: number, tooltipId: string) => {
    const total = detail.success + detail.failure;
    const timeRange = formatStatusWindowLabel(detail.startTime, detail.endTime, locale);

    return (
      <div
        id={tooltipId}
        role="tooltip"
        className={[
          styles.monitoringStatusTooltip,
          getTooltipPositionClassName(index, statusData.blockDetails.length),
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <span className={styles.monitoringTooltipTime}>{timeRange}</span>
        {total > 0 ? (
          <span className={styles.monitoringTooltipStats}>
            <span className={styles.monitoringTooltipSuccess}>{t('status_bar.success_short')} {detail.success}</span>
            <span className={styles.monitoringTooltipFailure}>{t('status_bar.failure_short')} {detail.failure}</span>
            <span className={styles.monitoringTooltipRate}>({(detail.rate * 100).toFixed(1)}%)</span>
          </span>
        ) : (
          <span className={styles.monitoringTooltipStats}>{t('status_bar.no_requests')}</span>
        )}
      </div>
    );
  };

  return (
    <div className={styles.monitoringStatusBar}>
      <div
        className={styles.monitoringStatusBlocks}
        ref={blocksRef}
        role="group"
        aria-label={t('monitoring.account_health_status')}
      >
        {statusData.blockDetails.map((detail, index) => {
          const isIdle = detail.rate === -1;
          const isActive = resolvedActiveTooltip === index;
          const timeRangeLabel = formatStatusWindowLabel(detail.startTime, detail.endTime, locale);
          const tooltipId = `${tooltipIdPrefix}-monitoring-status-tooltip-${index}`;
          const ariaLabel = buildAccountStatusBlockAriaLabel({
            detail,
            timeRangeLabel,
            successRateValue: formatStatusRate(Math.max(0, detail.rate * 100)),
            copy: {
              successLabel: t('stats.success'),
              failureLabel: t('stats.failure'),
              noRequestsLabel: t('status_bar.no_requests'),
              successRateLabel: t('monitoring.success_rate'),
            },
          });

          return (
            <div
              key={`${detail.startTime}-${detail.endTime}`}
              className={[styles.monitoringStatusBlockWrapper, isActive ? styles.monitoringStatusBlockActive : '']
                .filter(Boolean)
                .join(' ')}
            >
              <button
                ref={(node) => {
                  blockButtonRefs.current[index] = node;
                }}
                type="button"
                className={styles.monitoringStatusBlockButton}
                tabIndex={resolvedFocusIndex === index ? 0 : -1}
                aria-label={ariaLabel}
                aria-describedby={isActive ? tooltipId : undefined}
                onFocus={() => handleFocus(index)}
                onBlur={handleBlur}
                onKeyDown={(event) => handleKeyDown(event, index)}
                onPointerEnter={(event) => handlePointerEnter(event, index)}
                onPointerLeave={handlePointerLeave}
                onPointerDown={(event) => handlePointerDown(event, index)}
              >
                <div
                  aria-hidden="true"
                  className={[styles.monitoringStatusBlock, isIdle ? styles.monitoringStatusBlockIdle : '']
                    .filter(Boolean)
                    .join(' ')}
                  style={isIdle ? undefined : { backgroundColor: getAccountStatusColor(detail.rate) }}
                />
              </button>
              {isActive ? renderTooltip(detail, index, tooltipId) : null}
            </div>
          );
        })}
      </div>
      {showRate ? (
        <span
          className={[styles.monitoringStatusRate, rateClassName, !hasData ? styles.monitoringStatusRatePlaceholder : '']
            .filter(Boolean)
            .join(' ')}
        >
          {hasData ? formatStatusRate(statusData.successRate) : '--'}
        </span>
      ) : null}
    </div>
  );
}

const getSuccessRateClassName = (rate: number) =>
  rate >= 0.95 ? styles.goodText : rate >= 0.85 ? styles.warnText : styles.badText;

const getAccountStatusDotClassName = (tone: AccountHealthTone) => {
  if (tone === 'good') return styles.accountStatusDotEnabled;
  if (tone === 'warn') return styles.accountStatusDotMixed;
  return styles.accountStatusDotDisabled;
};

function AccountHealthStatusPanel({
  row,
  hasPrices,
  locale,
  t,
  statusData,
  scopeText,
}: {
  row: MonitoringAccountRow;
  hasPrices: boolean;
  locale: string;
  t: TFunction;
  statusData: AccountStatusData;
  scopeText: string;
}) {
  const healthMetrics = [
    { key: 'total-calls', label: t('monitoring.total_calls'), value: formatCompactNumber(row.totalCalls) },
    {
      key: 'success-failure',
      label: t('monitoring.success_failure'),
      value: <SuccessFailureValue success={row.successCalls} failure={row.failureCalls} />,
    },
    { key: 'estimated-cost', label: t('monitoring.estimated_cost'), value: hasPrices ? formatUsd(row.totalCost) : '--', className: styles.primaryText },
    { key: 'success-rate', label: t('monitoring.success_rate'), value: formatPercent(row.successRate), className: getSuccessRateClassName(row.successRate) },
  ];

  return (
    <section className={styles.accountOverviewStatusSection}>
      <div className={styles.accountSectionHeader}>
        <strong>{t('monitoring.account_health_status')}</strong>
        <span className={styles.accountSectionInfo} title={t('monitoring.account_health_status_hint')}>
          i
        </span>
      </div>
      <div className={styles.healthMetricGrid}>
        {healthMetrics.map((metric) => (
          <div key={metric.key} className={styles.healthMetricItem}>
            <span>{metric.label}</span>
            <strong className={metric.className}>{metric.value}</strong>
          </div>
        ))}
      </div>
      <MonitoringHealthStatusBar statusData={statusData} locale={locale} t={t} showRate={false} />
      <div className={styles.accountScopeText}>{scopeText}</div>
    </section>
  );
}

function AccountTokenMetricGrid({ metrics, t }: { metrics: AccountSummaryMetric[]; t: TFunction }) {
  const getTokenMetricToneClassName = (key: string) => {
    if (key === 'input-tokens') return styles.accountMetricIconInput;
    if (key === 'output-tokens') return styles.accountMetricIconOutput;
    if (key === 'cached-tokens') return styles.accountMetricIconCached;
    return styles.accountMetricIconTotal;
  };

  return (
    <section className={styles.accountTokenPanel}>
      <div className={styles.accountSectionHeader}>
        <strong>{t('monitoring.token_usage')}</strong>
      </div>
      <div className={styles.accountOverviewMetricGrid}>
        {metrics.map((metric) => (
          <div key={metric.key} className={styles.accountOverviewMetricCard}>
            <span className={styles.accountOverviewMetricLabel}>
              <span
                className={[styles.accountMetricIcon, getTokenMetricToneClassName(metric.key)]
                  .filter(Boolean)
                  .join(' ')}
                aria-hidden="true"
              />
              {metric.label}
            </span>
            <strong className={[styles.accountOverviewMetricValue, metric.valueClassName].filter(Boolean).join(' ')}>
              {metric.value}
            </strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function AccountModelUsageList({
  row,
  hasPrices,
  locale,
  t,
  limit = 1,
}: {
  row: MonitoringAccountRow;
  hasPrices: boolean;
  locale: string;
  t: TFunction;
  limit?: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const [expandedModels, setExpandedModels] = useState<Record<string, boolean>>({});
  const hasExtraModels = row.models.length > limit;
  const visibleModels = showAll ? row.models : row.models.slice(0, limit);
  const toggleModel = (key: string) => setExpandedModels((previous) => ({ ...previous, [key]: !previous[key] }));

  return (
    <section className={styles.accountModelListPanel}>
      <div className={styles.accountSectionHeader}>
        <strong>{t('monitoring.top_models')}</strong>
        {hasExtraModels ? (
          <button type="button" className={styles.accountModelViewAllButton} onClick={() => setShowAll((previous) => !previous)}>
            {showAll ? t('monitoring.collapse') : t('monitoring.view_all')}
          </button>
        ) : null}
      </div>

      {visibleModels.length > 0 ? (
        <div className={styles.accountModelList}>
          {visibleModels.map((model) => {
            const modelKey = `${row.id}-${model.model}`;
            const isModelExpanded = Boolean(expandedModels[modelKey]);
            return (
              <div key={modelKey} className={styles.accountModelItem}>
                <button
                  type="button"
                  className={styles.accountModelRow}
                  onClick={() => toggleModel(modelKey)}
                  aria-expanded={isModelExpanded}
                >
                  <span className={styles.accountModelName} title={model.model}>{model.model}</span>
                  <span className={styles.accountModelMetaLine}>
                    <span className={styles.accountModelStat}><small>{t('monitoring.ranking_metric_requests')}</small><strong>{formatCompactNumber(model.totalCalls)}</strong></span>
                    <span className={styles.accountModelStat}><small>{t('monitoring.success_rate')}</small><strong className={getSuccessRateClassName(model.successRate)}>{formatPercent(model.successRate)}</strong></span>
                    <span className={styles.accountModelStat}><small>{t('monitoring.ranking_metric_tokens')}</small><strong>{formatCompactNumber(model.totalTokens)}</strong></span>
                    <span className={styles.accountModelStat}><small>{t('monitoring.ranking_metric_cost')}</small><strong>{hasPrices ? formatUsd(model.totalCost) : '--'}</strong></span>
                    <span className={styles.accountModelChevron} aria-hidden="true">{isModelExpanded ? <IconChevronDown size={14} /> : '›'}</span>
                  </span>
                </button>
                {isModelExpanded ? (
                  <div className={styles.accountModelExpanded}>
                    <div className={styles.accountModelExpandedItem}><small>{t('monitoring.input_tokens')}</small><strong>{formatCompactNumber(model.inputTokens)}</strong></div>
                    <div className={styles.accountModelExpandedItem}><small>{t('monitoring.output_tokens')}</small><strong>{formatCompactNumber(model.outputTokens)}</strong></div>
                    <div className={styles.accountModelExpandedItem}><small>{t('monitoring.cached_tokens')}</small><strong>{formatCompactNumber(model.cachedTokens)}</strong></div>
                    <div className={styles.accountModelExpandedItem}><small>{t('monitoring.latest_request_time')}</small><strong>{new Date(model.lastSeenAt).toLocaleString(locale)}</strong></div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className={styles.emptyBlockSmall}>{t('monitoring.no_model_data')}</div>
      )}
    </section>
  );
}

function AccountQuotaPanel({
  quotaState,
  quotaEntries,
  locale,
  t,
  onRefreshQuota,
}: {
  quotaState?: AccountQuotaState;
  quotaEntries: AccountQuotaEntry[];
  locale: string;
  t: TFunction;
  onRefreshQuota: () => void;
}) {
  const quotaLoading = quotaState?.status === 'loading';
  const lastQuotaSync = quotaState?.lastRefreshedAt && Number.isFinite(quotaState.lastRefreshedAt)
    ? new Date(quotaState.lastRefreshedAt).toLocaleString(locale)
    : '';
  const quotaTitle = quotaEntries.length === 1 ? quotaEntries[0].providerLabel : t('quota_management.title');

  const renderRefreshButton = () => (
    <button type="button" className={styles.quotaRefreshButton} onClick={onRefreshQuota} disabled={quotaLoading}>
      <IconRefreshCw size={14} className={quotaLoading ? styles.refreshIconSpinning : styles.refreshIcon} />
      <span>{t('codex_quota.refresh_button')}</span>
    </button>
  );

  return (
    <section className={styles.quotaSection}>
      <div className={styles.quotaSectionHeader}>
        <div className={styles.quotaSectionTitleGroup}>
          <strong>{quotaTitle}</strong>
          {lastQuotaSync ? <span>{`${t('monitoring.last_sync')}: ${lastQuotaSync}`}</span> : null}
        </div>
        {renderRefreshButton()}
      </div>

      {quotaLoading && quotaEntries.length === 0 ? <div className={styles.quotaStateMessage}>{t('codex_quota.loading')}</div> : null}
      {!quotaLoading && quotaState?.status === 'error' && quotaEntries.length === 0 ? (
        <div className={styles.quotaStateMessage}>{t('codex_quota.load_failed', { message: quotaState.error || t('common.unknown_error') })}</div>
      ) : null}
      {!quotaLoading && quotaState?.status === 'success' && quotaEntries.length === 0 ? <div className={styles.quotaStateMessage}>{t('monitoring.account_quota_empty')}</div> : null}
      {!quotaState && quotaEntries.length === 0 ? <div className={styles.quotaStateMessage}>{t('monitoring.account_quota_empty')}</div> : null}

      {quotaEntries.length > 0 ? (
        <div className={styles.quotaEntryGrid}>
          {quotaEntries.map((entry) => (
            <div key={entry.key} className={styles.quotaEntryCard}>
              <div className={styles.quotaEntryHeader}>
                <div className={styles.quotaEntryMain}>
                  <strong>{entry.authLabel}</strong>
                </div>
              </div>

              {entry.quota?.status === 'loading' ? (
                <div className={styles.quotaStateMessage}>{t(`${entry.config.i18nPrefix}.loading`)}</div>
              ) : entry.quota?.status === 'error' ? (
                <div className={styles.quotaStateMessage}>
                  {t(`${entry.config.i18nPrefix}.load_failed`, { message: resolveQuotaErrorMessage(t, entry.quota) })}
                </div>
              ) : hasUsableQuotaContent(entry.quota) ? (
                <div className={quotaStyles.quotaSection}>
                  {entry.config.renderQuotaItems(entry.quota!, t, QUOTA_RENDER_HELPERS)}
                </div>
              ) : (
                <div className={styles.quotaStateMessage}>{t(`${entry.config.i18nPrefix}.idle`)}</div>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function AccountExpandedDetails({
  row,
  hasPrices,
  locale,
  t,
  quotaState,
  quotaEntries,
  onRefreshQuota,
}: {
  row: MonitoringAccountRow;
  hasPrices: boolean;
  locale: string;
  t: TFunction;
  quotaState?: AccountQuotaState;
  quotaEntries: AccountQuotaEntry[];
  onRefreshQuota: () => void;
}) {
  return (
    <div className={styles.accountOverviewCardBody}>
      <AccountQuotaPanel quotaState={quotaState} quotaEntries={quotaEntries} locale={locale} t={t} onRefreshQuota={onRefreshQuota} />
      <AccountModelUsageList row={row} hasPrices={hasPrices} locale={locale} t={t} />
    </div>
  );
}

function AccountOverviewCard({
  row,
  hasPrices,
  locale,
  t,
  isExpanded,
  statusData,
  scopeText,
  quotaState,
  quotaEntries,
  onToggle,
  onRefreshQuota,
}: {
  row: MonitoringAccountRow;
  hasPrices: boolean;
  locale: string;
  t: TFunction;
  isExpanded: boolean;
  statusData: AccountStatusData;
  scopeText: string;
  quotaState?: AccountQuotaState;
  quotaEntries: AccountQuotaEntry[];
  onToggle: () => void;
  onRefreshQuota: () => void;
}) {
  const summaryMetrics = buildAccountSummaryMetrics(row, hasPrices, locale, t);
  const cardMetrics = sortAccountOverviewCardMetrics(summaryMetrics, t);
  const tone = getAccountHealthTone(row);
  const latestRequestText = new Date(row.lastSeenAt).toLocaleString(locale);
  const accountLabel = buildAccountCardFileName(row, quotaEntries);
  const providerText = buildAccountCardProviderText(row);

  return (
    <Card
      className={[
        styles.accountOverviewCard,
        isExpanded ? styles.accountOverviewCardExpanded : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className={styles.accountOverviewCardHeader}>
        <div className={styles.accountTitleRow}>
          <button
            type="button"
            className={styles.accountButton}
            onClick={onToggle}
            aria-expanded={isExpanded}
            title={accountLabel}
          >
            <span className={styles.accountExpandGlyph} aria-hidden="true">
              {isExpanded ? <IconChevronUp size={15} /> : <IconChevronDown size={15} />}
            </span>
            <span className={styles.accountIdentityLine}>
              <span className={[styles.accountStatusDot, getAccountStatusDotClassName(tone)].filter(Boolean).join(' ')} aria-hidden="true" />
              <span className={styles.accountButtonLabel}>{accountLabel}</span>
            </span>
          </button>
          <span className={`${styles.accountHealthBadge} ${styles[`accountHealthBadge${tone}`]}`}>
            {tone === 'good' ? t('monitoring.health_good') : tone === 'warn' ? t('monitoring.health_warn') : t('monitoring.health_bad')}
          </span>
        </div>
        <div className={styles.accountMetaRow}>
          <span className={styles.accountOverviewCardTimestamp} title={providerText}>{providerText}</span>
          <span className={styles.accountMetaSeparator}>·</span>
          <span className={styles.accountOverviewCardTimestamp}>{t('monitoring.latest_request_time_value', { value: latestRequestText })}</span>
        </div>
      </div>

      <AccountHealthStatusPanel row={row} hasPrices={hasPrices} locale={locale} t={t} statusData={statusData} scopeText={scopeText} />
      <AccountTokenMetricGrid metrics={cardMetrics} t={t} />

      {isExpanded ? (
        <AccountExpandedDetails
          row={row}
          hasPrices={hasPrices}
          locale={locale}
          t={t}
          quotaState={quotaState}
          quotaEntries={quotaEntries}
          onRefreshQuota={onRefreshQuota}
        />
      ) : null}
    </Card>
  );
}

function AccountStatsPanel({
  rows,
  metric,
  emptyText,
  hasPrices,
  locale,
  t,
  rangeLabel,
  range,
  onRangeChange,
  onHide,
  expandedAccounts,
  accountQuotaStates,
  accountQuotaEntriesByAccount,
  onMetricChange,
  onToggleAccount,
  onRefreshQuota,
}: {
  rows: MonitoringAccountRow[];
  metric: AccountSortMetric;
  emptyText: string;
  hasPrices: boolean;
  locale: string;
  t: TFunction;
  rangeLabel: string;
  range: MonitoringTimeRange;
  onRangeChange: (range: MonitoringTimeRange) => void;
  onHide: () => void;
  expandedAccounts: Record<string, boolean>;
  accountQuotaStates: Record<string, AccountQuotaState>;
  accountQuotaEntriesByAccount: Map<string, AccountQuotaEntry[]>;
  onMetricChange: (metric: AccountSortMetric) => void;
  onToggleAccount: (accountId: string, account: string) => void;
  onRefreshQuota: (account: string) => void;
}) {
  const ACCOUNT_CARD_MIN_WIDTH = 330;
  const ACCOUNT_CARD_GAP = 16;
  const ROWS_PER_PAGE = 2;

  const [cardPage, setCardPage] = useState(0);
  const [gridEl, setGridEl] = useState<HTMLDivElement | null>(null);
  const gridRef = useCallback((el: HTMLDivElement | null) => setGridEl(el), []);
  const [gridCols, setGridCols] = useState(3);
  const [accountSearch, setAccountSearch] = useState('');
  const [accountProviderFilter, setAccountProviderFilter] = useState('all');
  const [accountHealthFilter, setAccountHealthFilter] = useState<'all' | AccountHealthTone>('all');

  useEffect(() => {
    if (!gridEl) return;
    const update = () => {
      const cols = Math.max(1, Math.floor((gridEl.clientWidth + ACCOUNT_CARD_GAP) / (ACCOUNT_CARD_MIN_WIDTH + ACCOUNT_CARD_GAP)));
      setGridCols((current) => (current === cols ? current : cols));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(gridEl);
    return () => observer.disconnect();
  }, [gridEl]);

  const providerOptions = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((row) => row.providers.forEach((p) => { if (p && p !== '-') set.add(p); }));
    return Array.from(set).sort();
  }, [rows]);

  const filteredRows = useMemo(() => {
    const query = accountSearch.trim().toLowerCase();
    return rows.filter((row) => {
      if (query) {
        const haystack = [row.accountMasked, row.account, ...row.authLabels, ...row.providers].join(' ').toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      if (accountProviderFilter !== 'all') {
        if (!row.providers.includes(accountProviderFilter)) return false;
      }
      if (accountHealthFilter !== 'all') {
        if (getAccountHealthTone(row) !== accountHealthFilter) return false;
      }
      return true;
    });
  }, [rows, accountSearch, accountProviderFilter, accountHealthFilter]);

  const hasActiveFilters = accountSearch.trim() !== '' || accountProviderFilter !== 'all' || accountHealthFilter !== 'all';

  const itemsPerPage = gridCols * ROWS_PER_PAGE;
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / itemsPerPage));
  const safePageIndex = Math.min(cardPage, totalPages - 1);
  const visibleRows = useMemo(
    () => filteredRows.slice(safePageIndex * itemsPerPage, (safePageIndex + 1) * itemsPerPage),
    [filteredRows, itemsPerPage, safePageIndex]
  );

  const accountStatusRange = useMemo(
    () => buildAccountStatusRange(rows, range),
    [rows, range]
  );

  const accountStatusDataById = useMemo(() => {
    const entries = visibleRows.map((row) => [row.id, buildAccountStatusData(row.rows ?? [], accountStatusRange)] as const);
    return new Map(entries);
  }, [accountStatusRange, visibleRows]);

  useEffect(() => {
    setCardPage(0);
  }, [accountSearch, accountProviderFilter, accountHealthFilter, metric, range, itemsPerPage]);

  return (
    <>
      <div className={styles.usageTrendHeader}>
        <div className={styles.usageTrendCopy}>
          <h2>{t('monitoring.account_stats_title')}</h2>
          <p>{t('monitoring.account_stats_desc')}</p>
        </div>
        <button type="button" className={`${styles.rankingMetricButton} ${styles.usageTrendHideButton} ${styles.mobileHeaderHideButton}`} onClick={onHide}>
          {t('monitoring.hide_analysis')}
        </button>
        <div className={styles.usageTrendActions}>
          <div className={`${styles.rankingMetricSwitch} ${styles.timeRangeControl}`}>
            {TIME_RANGE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`${styles.rankingMetricButton} ${styles.timeRangeButton} ${range === option.value ? styles.rankingMetricButtonActive : ''}`}
                onClick={() => onRangeChange(option.value)}
              >
                {t(option.labelKey)}
              </button>
            ))}
          </div>
          <button type="button" className={`${styles.rankingMetricButton} ${styles.usageTrendHideButton}`} onClick={onHide}>
            {t('monitoring.hide_analysis')}
          </button>
        </div>
      </div>

      <Card className={styles.accountStatsCard}>
        <div className={styles.accountStatsToolbar}>
          <div className={styles.accountStatsFilters}>
            <Input
              value={accountSearch}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setAccountSearch(event.target.value)}
              placeholder={t('monitoring.search_account')}
              className={styles.accountStatsSearchInput}
              rightElement={<IconSearch size={14} />}
              aria-label={t('monitoring.search_account')}
            />
            {providerOptions.length > 0 && (
              <select
                value={accountProviderFilter}
                onChange={(event) => setAccountProviderFilter(event.target.value)}
                className={styles.accountStatsSelect}
                aria-label={t('monitoring.filter_provider')}
              >
                <option value="all">{t('monitoring.filter_all_providers')}</option>
                {providerOptions.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            )}
            <select
              value={accountHealthFilter}
              onChange={(event) => setAccountHealthFilter(event.target.value as 'all' | AccountHealthTone)}
              className={styles.accountStatsSelect}
              aria-label={t('monitoring.filter_health_status')}
            >
              <option value="all">{t('monitoring.filter_all_statuses')}</option>
              <option value="good">{t('monitoring.health_good')}</option>
              <option value="warn">{t('monitoring.health_warn_filter')}</option>
              <option value="bad">{t('monitoring.health_bad')}</option>
            </select>
            {hasActiveFilters && (
              <button
                type="button"
                className={styles.accountStatsClearButton}
                onClick={() => { setAccountSearch(''); setAccountProviderFilter('all'); setAccountHealthFilter('all'); }}
              >
                {t('monitoring.clear_filters')}
              </button>
            )}
          </div>
          <div className={styles.rankingMetricSwitch} role="group" aria-label={t('monitoring.account_sort_aria')}>
            {ACCOUNT_SORT_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`${styles.rankingMetricButton} ${metric === option.value ? styles.rankingMetricButtonActive : ''}`}
                onClick={() => onMetricChange(option.value)}
                disabled={option.value === 'cost' && !hasPrices}
              >
                {t(option.labelKey)}
              </button>
            ))}
          </div>
        </div>

        {filteredRows.length > 0 ? (
          <>
            <div ref={gridRef} className={styles.accountOverviewCardGrid}>
              {visibleRows.map((row) => {
                const statusData = accountStatusDataById.get(row.id) ?? buildAccountStatusData([], accountStatusRange);
                return (
                  <AccountOverviewCard
                    key={row.id}
                    row={row}
                    hasPrices={hasPrices}
                    locale={locale}
                    t={t}
                    isExpanded={Boolean(expandedAccounts[row.id])}
                    statusData={statusData}
                    scopeText={formatAccountOverviewScopeText(rangeLabel, t)}
                    quotaState={accountQuotaStates[row.account]}
                    quotaEntries={accountQuotaEntriesByAccount.get(row.account) ?? []}
                    onToggle={() => onToggleAccount(row.id, row.account)}
                    onRefreshQuota={() => onRefreshQuota(row.account)}
                  />
                );
              })}
            </div>
            {totalPages > 1 && (
              <div className={quotaStyles.pagination}>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={safePageIndex === 0}
                  onClick={() => setCardPage((p) => Math.max(0, p - 1))}
                  aria-label={t('monitoring.previous_page')}
                >
                  {t('auth_files.pagination_prev', { defaultValue: t('monitoring.previous_page') })}
                </Button>
                <div className={quotaStyles.pageInfo}>
                  {t('auth_files.pagination_info', {
                    current: safePageIndex + 1,
                    total: totalPages,
                    count: filteredRows.length,
                    defaultValue: `${safePageIndex + 1} / ${totalPages} · ${filteredRows.length}`,
                  })}
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={safePageIndex >= totalPages - 1}
                  onClick={() => setCardPage((p) => Math.min(totalPages - 1, p + 1))}
                  aria-label={t('monitoring.next_page')}
                >
                  {t('auth_files.pagination_next', { defaultValue: t('monitoring.next_page') })}
                </Button>
              </div>
            )}
          </>
        ) : (
          <div className={styles.emptyBlockSmall}>{hasActiveFilters ? t('monitoring.no_matching_accounts') : emptyText}</div>
        )}
      </Card>
    </>
  );
}

function StatusBadge({ tone, children }: { tone: MonitoringStatusTone; children: ReactNode }) {
  return <span className={`${styles.statusBadge} ${styles[`tone${tone}`]}`}>{children}</span>;
}

function RealtimeErrorDetailsPanel({
  row,
  t,
  language,
}: {
  row: RealtimeLogRow;
  t: ReturnType<typeof useTranslation>['t'];
  language?: string;
}) {
  const categoryText = translateRealtimeErrorCategory(row.errorCategoryKey, t, language);
  const statusText = buildRealtimeStatusLabel(row, t('monitoring.result_failed'));
  const summaryText = row.errorMessage
    ? compactRealtimeErrorMessage(row.errorMessage, 220)
    : row.errorSummary || row.diagnosticText || categoryText;
  const detailItems = [
    { label: translateRealtimeErrorText('http_status', t, language), value: row.statusCode !== null ? String(row.statusCode) : '-' },
    { label: translateRealtimeErrorText('error_code', t, language), value: row.errorCode || '-' },
    { label: translateRealtimeErrorText('upstream_request_id', t, language), value: row.upstreamRequestId || '-' },
    { label: translateRealtimeErrorText('retry_after', t, language), value: row.retryAfter || '-' },
  ].filter((item) => item.value !== '-');

  return (
    <div className={styles.realtimeErrorDetailsPanel}>
      <div className={styles.realtimeErrorOverview}>
        <div className={styles.realtimeErrorOverviewTop}>
          <StatusBadge tone="bad">{statusText}</StatusBadge>
          <span>{categoryText}</span>
        </div>
        <strong>{summaryText}</strong>
      </div>
      {row.errorMessage ? (
        <div className={styles.realtimeErrorMessageBlock}>
          <span>{translateRealtimeErrorText('error_message', t, language)}</span>
          <pre className={styles.realtimeErrorMessage}>{compactRealtimeErrorMessage(row.errorMessage, 1200)}</pre>
        </div>
      ) : null}
      {detailItems.length > 0 ? (
        <div className={styles.realtimeErrorDetailsGrid}>
          {detailItems.map((item) => (
            <div key={item.label} className={styles.realtimeErrorDetailItem}>
              <span>{item.label}</span>
              <strong>{maskSensitiveText(item.value)}</strong>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RecentPattern({
  pattern,
  variant = 'default',
  label,
}: {
  pattern: boolean[];
  variant?: 'default' | 'plain';
  label?: string;
}) {
  const normalized = pattern.length > 0 ? pattern : Array.from({ length: 10 }, () => true);
  const successCount = normalized.filter(Boolean).length;
  const failureCount = normalized.length - successCount;
  const ariaLabel = label ?? `Recent ${normalized.length} requests: ${successCount} succeeded, ${failureCount} failed`;
  const containerClassName = [
    styles.patternBars,
    variant === 'plain' ? styles.patternBarsPlain : '',
  ]
    .filter(Boolean)
    .join(' ');
  const barClassName = [styles.patternBar, variant === 'plain' ? styles.patternBarPlain : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={containerClassName} role="img" aria-label={ariaLabel}>
      {normalized.map((item, index) => (
        <span
          key={index}
          className={`${barClassName} ${item ? styles.patternSuccess : styles.patternFailed}`}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}

export function MonitoringCenterPage() {
  const { t, i18n } = useTranslation();
  const config = useConfigStore((state) => state.config);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const quotaStore = useQuotaStore((state) => state);
  const [timeRange, setTimeRange] = useState<MonitoringTimeRange>('today');
  const [searchInput, setSearchInput] = useState('');
  const [selectedProvider, setSelectedProvider] = useState('all');
  const [selectedModel, setSelectedModel] = useState('all');
  const [selectedApiKey, setSelectedApiKey] = useState('all');
  const [selectedStatus, setSelectedStatus] = useState<StatusFilter>('all');
  const [expandedAccounts, setExpandedAccounts] = useState<Record<string, boolean>>({});
  const [selectedRealtimeErrorRow, setSelectedRealtimeErrorRow] = useState<RealtimeLogRow | null>(null);
  const [isPriceModalOpen, setIsPriceModalOpen] = useState(false);
  const [isMonitoringSettingsOpen, setIsMonitoringSettingsOpen] = useState(false);
  const [isMonitoringSettingsLoading, setIsMonitoringSettingsLoading] = useState(false);
  const [isMonitoringSettingsSaving, setIsMonitoringSettingsSaving] = useState(false);
  const [monitoringSettingsDraft, setMonitoringSettingsDraft] = useState<MonitoringSettingsDraft>(() => createMonitoringSettingsDraft());
  const [priceModel, setPriceModel] = useState('');
  const [priceDraft, setPriceDraft] = useState<PriceDraft>(() => createPriceDraft());
  const [isImportingUsage, setIsImportingUsage] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [accountQuotaStates, setAccountQuotaStates] = useState<Record<string, AccountQuotaState>>({});
  const [isUsageTrendHidden, setIsUsageTrendHidden] = useState(false);
  const [modelRankingMetric, setModelRankingMetric] = useState<RankingMetric>('requests');
  const [apiKeyRankingMetric, setApiKeyRankingMetric] = useState<RankingMetric>('requests');
  const [usageTrendApiKey, setUsageTrendApiKey] = useState('all');
  const [accountStatsMetric, setAccountStatsMetric] = useState<AccountSortMetric>('recent');
  const [isAccountStatsHidden, setIsAccountStatsHidden] = useState(false);
  const [realtimeLogPage, setRealtimeLogPage] = useState(1);
  const [realtimeLogUsage, setRealtimeLogUsage] = useState<UsagePayload | null>(null);
  const [realtimeLogMatchedTotal, setRealtimeLogMatchedTotal] = useState(0);
  const [realtimeLogNextCursor, setRealtimeLogNextCursor] = useState('');
  const [realtimeLogPageCursors, setRealtimeLogPageCursors] = useState<string[]>(['']);
  const [realtimeLogSnapshotMaxId, setRealtimeLogSnapshotMaxId] = useState(0);
  const [realtimeLogLoading, setRealtimeLogLoading] = useState(false);
  const [realtimeLogError, setRealtimeLogError] = useState('');
  const [realtimeLogColumns, setRealtimeLogColumns] = useState<RealtimeLogColumnPreference[]>(loadRealtimeLogColumns);
  const [draggedRealtimeLogColumnKey, setDraggedRealtimeLogColumnKey] = useState<RealtimeLogColumnKey | null>(null);
  const [isRealtimeColumnsMenuOpen, setIsRealtimeColumnsMenuOpen] = useState(false);
  const accountQuotaStatesRef = useRef<Record<string, AccountQuotaState>>({});
  const accountQuotaRequestIdsRef = useRef<Record<string, number>>({});
  const realtimeColumnsMenuRef = useRef<HTMLDivElement | null>(null);
  const deferredSearchInput = useDeferredValue(searchInput);
  const [deferredSearch, setDeferredSearch] = useState(searchInput);

  useEffect(() => {
    const timer = setTimeout(() => setDeferredSearch(deferredSearchInput), 300);
    return () => clearTimeout(timer);
  }, [deferredSearchInput]);

  const {
    usage,
    error: usageError,
    latestId,
    modelPrices,
    setModelPrices,
    refreshUsage,
    loadEventPage,
  } = useUsageData();
  const deferredUsage = useDeferredValue(usage);

  const {
    loading: monitoringLoading,
    error: monitoringError,
    authFiles,
    allRows,
    filteredRows,
    refreshMeta,
  } = useMonitoringData({
    usage: deferredUsage,
    logUsage: realtimeLogUsage,
    serverFilteredLogs: true,
    config,
    modelPrices,
    timeRange,
    searchQuery: '',
    deletedCredentialLabel: t('monitoring.deleted_credential'),
  });

  const {
    data: usageAggregates,
    error: aggregatesError,
    refresh: refreshAggregates,
  } = useUsageAggregates({
    latestId,
    timeRange,
    apiKeyHash: usageTrendApiKey,
    enabled: connectionStatus === 'connected',
  });

  const searchMatchedAuthIndexFilter = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    if (!query) return '';
    const matches = new Set<string>();
    allRows.forEach((row) => {
      if (row.authIndex === '-') return;
      const authText = [row.account, row.accountMasked, row.authLabel, row.source, row.sourceMasked]
        .filter(Boolean)
        .join('\n')
        .toLowerCase();
      if (authText.includes(query)) {
        matches.add(row.authIndex);
      }
    });
    return Array.from(matches).sort().join(',');
  }, [allRows, deferredSearch]);

  const realtimeLogRequestIdRef = useRef(0);
  const realtimeLogAbortControllerRef = useRef<AbortController | null>(null);
  const realtimeLogPageRef = useRef(1);
  const realtimeLogAutoRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const buildRealtimeLogFilters = useCallback((): UsageEventPageFilters => {
    const nowMs = Date.now();
    const fromMs = getRangeStartMs(timeRange, nowMs);
    return {
      fromMs: Number.isFinite(fromMs) && fromMs > 0 ? fromMs : undefined,
      toMs: nowMs,
      provider: selectedProvider === 'all' ? undefined : selectedProvider,
      model: selectedModel === 'all' ? undefined : selectedModel,
      authIndex: searchMatchedAuthIndexFilter || undefined,
      apiKeyHash: selectedApiKey === 'all' ? undefined : selectedApiKey,
      status: selectedStatus,
      search: searchMatchedAuthIndexFilter ? undefined : deferredSearch,
      limit: REALTIME_LOG_PAGE_SIZE,
    };
  }, [deferredSearch, searchMatchedAuthIndexFilter, selectedApiKey, selectedModel, selectedProvider, selectedStatus, timeRange]);

  const fetchRealtimeLogPage = useCallback(async (page: number, cursor = '') => {
    if (connectionStatus !== 'connected') return false;
    const requestId = realtimeLogRequestIdRef.current + 1;
    realtimeLogRequestIdRef.current = requestId;
    realtimeLogAbortControllerRef.current?.abort();
    const controller = new AbortController();
    realtimeLogAbortControllerRef.current = controller;
    setRealtimeLogLoading(true);
    setRealtimeLogError('');
    try {
      const result = await loadEventPage({ ...buildRealtimeLogFilters(), cursor, signal: controller.signal });
      if (realtimeLogRequestIdRef.current !== requestId) return false;
      setRealtimeLogUsage(result.usage);
      setRealtimeLogMatchedTotal(result.matchedTotal);
      setRealtimeLogNextCursor(result.nextCursor);
      setRealtimeLogSnapshotMaxId(result.snapshotMaxId);
      setRealtimeLogPageCursors((current) => {
        const next = current.slice(0, Math.max(page, 1));
        next[page - 1] = result.pageCursor;
        return next;
      });
      setRealtimeLogPage(page);
      return true;
    } catch (error) {
      if (realtimeLogRequestIdRef.current !== requestId) return false;
      if (controller.signal.aborted) return false;
      setRealtimeLogError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      if (realtimeLogRequestIdRef.current === requestId) {
        setRealtimeLogLoading(false);
      }
      if (realtimeLogAbortControllerRef.current === controller) {
        realtimeLogAbortControllerRef.current = null;
      }
    }
  }, [buildRealtimeLogFilters, connectionStatus, loadEventPage]);

  const refreshRealtimeLogs = useCallback(async () => {
    setRealtimeLogPageCursors(['']);
    return fetchRealtimeLogPage(1, '');
  }, [fetchRealtimeLogPage]);

  const showPreviousRealtimeLogPage = useCallback(async () => {
    if (realtimeLogLoading || realtimeLogPage <= 1) return;
    const previousPage = realtimeLogPage - 1;
    const cursor = realtimeLogPageCursors[previousPage - 1] ?? '';
    await fetchRealtimeLogPage(previousPage, cursor);
  }, [fetchRealtimeLogPage, realtimeLogLoading, realtimeLogPage, realtimeLogPageCursors]);

  const showNextRealtimeLogPage = useCallback(async () => {
    if (realtimeLogLoading || !realtimeLogNextCursor) return;
    const nextPage = realtimeLogPage + 1;
    const cursor = realtimeLogNextCursor;
    const success = await fetchRealtimeLogPage(nextPage, cursor);
    if (!success) return;
  }, [fetchRealtimeLogPage, realtimeLogLoading, realtimeLogNextCursor, realtimeLogPage]);

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshUsage(), refreshMeta(false), refreshRealtimeLogs()]);
    await refreshAggregates();
  }, [refreshAggregates, refreshMeta, refreshRealtimeLogs, refreshUsage]);

  const loadMonitoringSettings = useCallback(async () => {
    if (connectionStatus !== 'connected') {
      showNotification(t('notification.connection_required'), 'warning');
      return;
    }
    setIsMonitoringSettingsLoading(true);
    try {
      const response = await apiClient.get<{ settings: MonitoringSettings }>('/usage/settings');
      setMonitoringSettingsDraft(createMonitoringSettingsDraft(response.settings));
      setIsMonitoringSettingsOpen(true);
    } catch (error) {
      showNotification(error instanceof Error ? error.message : String(error || t('common.unknown_error')), 'error');
    } finally {
      setIsMonitoringSettingsLoading(false);
    }
  }, [connectionStatus, showNotification, t]);

  const handleSaveMonitoringSettings = useCallback(async () => {
    const settings = buildMonitoringSettingsFromDraft(monitoringSettingsDraft);
    if (settings.webdav.enabled && !settings.webdav.url) {
      showNotification(t('usage_stats.monitoring_settings_webdav_url_required'), 'warning');
      return;
    }
    setIsMonitoringSettingsSaving(true);
    try {
      const response = await apiClient.put<{ settings: MonitoringSettings }>('/usage/settings', { settings });
      setMonitoringSettingsDraft(createMonitoringSettingsDraft(response.settings));
      setIsMonitoringSettingsOpen(false);
      showNotification(t('usage_stats.monitoring_settings_saved'), 'success');
      await refreshAll();
    } catch (error) {
      showNotification(error instanceof Error ? error.message : String(error || t('common.unknown_error')), 'error');
    } finally {
      setIsMonitoringSettingsSaving(false);
    }
  }, [monitoringSettingsDraft, refreshAll, showNotification, t]);
  const handleExportUsage = useCallback(async () => {
    if (connectionStatus !== 'connected') {
      showNotification(t('notification.connection_required'), 'warning');
      return;
    }

    try {
      const response = await apiClient.getRaw('/usage/export', { responseType: 'blob' });
      const blob = response.data instanceof Blob ? response.data : new Blob([response.data], { type: 'application/x-ndjson' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      link.href = url;
      link.download = `usage-export-${timestamp}.jsonl`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      showNotification(t('usage_stats.export_success'), 'success');
    } catch (error) {
      showNotification(error instanceof Error ? error.message : String(error || t('common.unknown_error')), 'error');
    }
  }, [connectionStatus, showNotification, t]);

  const handleImportUsageClick = useCallback(() => {
    if (connectionStatus !== 'connected') {
      showNotification(t('notification.connection_required'), 'warning');
      return;
    }
    importInputRef.current?.click();
  }, [connectionStatus, showNotification, t]);

  const handleImportUsageFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;

      setIsImportingUsage(true);
      try {
        const content = await file.text();
        if (!content.trim()) {
          showNotification(t('usage_stats.import_invalid'), 'error');
          return;
        }

        const result = await apiClient.post<UsageImportResult>('/usage/import', content, {
          headers: { 'Content-Type': 'application/x-ndjson' },
        });
        const importedExtras = [
          (result.modelPriceRecords ?? 0) > 0 ? t('usage_stats.import_model_prices_restored', { count: result.modelPrices ?? 0 }) : '',
          (result.quotaCacheRecords ?? 0) > 0 ? t('usage_stats.import_quota_cache_restored', { count: result.quotaCache ?? 0 }) : '',
          result.accountInspectionSchedule ? t('usage_stats.import_account_inspection_schedule_restored') : '',
          result.monitoringSettings ? t('usage_stats.import_monitoring_settings_restored') : '',
        ].filter(Boolean).join(' · ');
        showNotification(
          [
            t('usage_stats.import_success', {
              added: result.added ?? 0,
              skipped: result.skipped ?? 0,
              total: result.total ?? 0,
              failed: result.failed ?? 0,
            }),
            importedExtras,
          ].filter(Boolean).join(' · '),
          (result.failed ?? 0) > 0 ? 'warning' : 'success'
        );
        await refreshAll();
      } catch (error) {
        showNotification(error instanceof Error ? error.message : String(error || t('common.unknown_error')), 'error');
      } finally {
        setIsImportingUsage(false);
      }
    },
    [refreshAll, showNotification, t]
  );

  const handleCopyRealtimeDiagnostic = useCallback((row: RealtimeLogRow) => {
    const text = buildRealtimeDiagnosticClipboardText(row, t, i18n.language);
    if (!navigator.clipboard?.writeText) {
      showNotification(translateRealtimeErrorText('copy_diagnostic_failed', t, i18n.language), 'error');
      return;
    }
    void navigator.clipboard.writeText(text)
      .then(() => showNotification(translateRealtimeErrorText('copy_diagnostic_success', t, i18n.language), 'success'))
      .catch(() => showNotification(translateRealtimeErrorText('copy_diagnostic_failed', t, i18n.language), 'error'));
  }, [i18n.language, showNotification, t]);

  useHeaderRefresh(refreshAll);

  const combinedError = [usageError, monitoringError, realtimeLogError].filter(Boolean).join('；');
  const hasPrices = Object.keys(modelPrices).length > 0;
  const pendingRealtimeEventCount = realtimeLogSnapshotMaxId > 0 ? Math.max(latestId - realtimeLogSnapshotMaxId, 0) : 0;

  useEffect(() => {
    realtimeLogPageRef.current = realtimeLogPage;
  }, [realtimeLogPage]);

  useEffect(() => {
    if (
      connectionStatus !== 'connected'
      || realtimeLogPage !== 1
      || pendingRealtimeEventCount <= 0
      || realtimeLogAutoRefreshTimerRef.current
    ) {
      return;
    }
    realtimeLogAutoRefreshTimerRef.current = setTimeout(() => {
      realtimeLogAutoRefreshTimerRef.current = null;
      if (realtimeLogPageRef.current === 1) {
        void refreshRealtimeLogs();
      }
    }, 1000);
  }, [connectionStatus, pendingRealtimeEventCount, realtimeLogPage, refreshRealtimeLogs]);

  useEffect(() => () => {
    realtimeLogAbortControllerRef.current?.abort();
    if (realtimeLogAutoRefreshTimerRef.current) {
      clearTimeout(realtimeLogAutoRefreshTimerRef.current);
      realtimeLogAutoRefreshTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    accountQuotaStatesRef.current = accountQuotaStates;
  }, [accountQuotaStates]);

  const setQuotaForConfig = useCallback(
    (quotaConfig: AnyQuotaConfig, updater: Record<string, QuotaStatusState> | ((prev: Record<string, QuotaStatusState>) => Record<string, QuotaStatusState>)) => {
      const setter = useQuotaStore.getState()[quotaConfig.storeSetter] as (value: typeof updater) => void;
      setter(updater);
    },
    []
  );

  const requestLogRows = filteredRows;

  const requestLogDerived = useMemo(() => {
    const providers = new Set<string>();
    const models = new Set<string>();
    const apiKeys = new Map<string, string>();

    allRows.forEach((row) => {
      if (row.provider) providers.add(row.provider);
      if (row.model) models.add(row.model);
      if (row.clientApiKey.hash && row.clientApiKey.hash !== '-' && !apiKeys.has(row.clientApiKey.hash)) {
        apiKeys.set(row.clientApiKey.hash, row.clientApiKey.masked);
      }
    });
    usageAggregates?.providers.forEach((bucket) => {
      if (bucket.provider) providers.add(bucket.provider);
    });
    usageAggregates?.models.forEach((bucket) => {
      if (bucket.model) models.add(bucket.model);
    });
    usageAggregates?.apiKeys.forEach((bucket) => {
      if (bucket.apiKeyHash && !apiKeys.has(bucket.apiKeyHash)) {
        apiKeys.set(bucket.apiKeyHash, maskSensitiveText(bucket.apiKeyHash));
      }
    });

    const sortedModels = Array.from(models).filter(Boolean).sort((left, right) => left.localeCompare(right));

    return {
      providerOptions: [
        { value: 'all', label: t('monitoring.filter_all_providers') },
        ...Array.from(providers)
          .filter(Boolean)
          .sort((left, right) => left.localeCompare(right))
          .map((value) => ({ value, label: value })),
      ],
      modelOptions: [
        { value: 'all', label: t('monitoring.filter_all_models') },
        ...sortedModels.map((value) => ({ value, label: value })),
      ],
      apiKeyOptions: [
        { value: 'all', label: t('monitoring.filter_all_api_keys') },
        ...Array.from(apiKeys.entries())
          .sort((left, right) => left[1].localeCompare(right[1]))
          .map(([value, label]) => ({ value, label })),
      ],
      priceModelOptions: [
        { value: '', label: t('usage_stats.model_price_select_placeholder') },
        ...Array.from(new Set([...sortedModels, ...Object.keys(modelPrices)]))
          .filter(Boolean)
          .sort((left, right) => left.localeCompare(right))
          .map((value) => ({ value, label: value })),
      ],
    };
  }, [allRows, modelPrices, t, usageAggregates]);
  const {
    providerOptions,
    modelOptions,
    apiKeyOptions,
    priceModelOptions,
  } = requestLogDerived;

  const statusOptions = useMemo(
    () => [
      { value: 'all', label: t('monitoring.filter_all_statuses') },
      { value: 'success', label: t('monitoring.filter_status_success') },
      { value: 'failed', label: t('monitoring.filter_status_failed') },
    ],
    [t]
  );

  useEffect(() => {
    if (selectedProvider !== 'all' && !providerOptions.some((option) => option.value === selectedProvider)) {
      setSelectedProvider('all');
    }
    if (selectedModel !== 'all' && !modelOptions.some((option) => option.value === selectedModel)) {
      setSelectedModel('all');
    }
    if (selectedApiKey !== 'all' && !apiKeyOptions.some((option) => option.value === selectedApiKey)) {
      setSelectedApiKey('all');
    }
  }, [apiKeyOptions, modelOptions, providerOptions, selectedApiKey, selectedModel, selectedProvider]);

  const authFilesByAuthIndex = useMemo(() => {
    const map = new Map<string, AuthFileItem>();
    authFiles.forEach((file) => {
      const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
      if (!authIndex || map.has(authIndex)) return;
      map.set(authIndex, file);
    });
    return map;
  }, [authFiles]);

  const scopedRowsState = useMemo(() => ({
    rows: requestLogRows,
    failureCount: requestLogRows.filter((row) => row.failed).length,
  }), [requestLogRows]);
  const scopedRows = scopedRowsState.rows;
  const scopedFailureCount = scopedRowsState.failureCount;

  const usageRowGroups = useMemo(() => {
    const nowMs = Date.now();
    const summaryWindowStartMs = nowMs - 30 * 60 * 1000;
    const todayStart = new Date(nowMs);
    todayStart.setHours(0, 0, 0, 0);
    const tomorrowStart = new Date(todayStart);
    tomorrowStart.setDate(tomorrowStart.getDate() + 1);
    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const trendStartMs = getRangeStartMs(timeRange, nowMs);
    const trendStatsRows: MonitoringEventRow[] = [];
    const topSummaryAccumulator = createMonitoringSummaryAccumulator();
    const todaySummaryAccumulator = createMonitoringSummaryAccumulator();
    const trendSummaryAccumulator = createMonitoringSummaryAccumulator();
    let todayCost = 0;
    let yesterdayCost = 0;

    allRows.forEach((row) => {
      if (!row.statsIncluded) return;
      addMonitoringSummaryRow(topSummaryAccumulator, row, summaryWindowStartMs, nowMs);
      if (row.timestampMs >= todayStart.getTime() && row.timestampMs < tomorrowStart.getTime()) {
        addMonitoringSummaryRow(todaySummaryAccumulator, row, summaryWindowStartMs, nowMs);
        todayCost += row.totalCost;
      } else if (row.timestampMs >= yesterdayStart.getTime() && row.timestampMs < todayStart.getTime()) {
        yesterdayCost += row.totalCost;
      }
      if (row.timestampMs >= trendStartMs && row.timestampMs <= nowMs) {
        trendStatsRows.push(row);
        addMonitoringSummaryRow(trendSummaryAccumulator, row, summaryWindowStartMs, nowMs);
      }
    });

    return {
      trendStatsRows,
      topSummary: finalizeMonitoringSummary(topSummaryAccumulator),
      todaySummary: finalizeMonitoringSummary(todaySummaryAccumulator),
      trendSummary: finalizeMonitoringSummary(trendSummaryAccumulator),
      todayCost,
      yesterdayCost,
    };
  }, [allRows, timeRange]);
  const {
    trendStatsRows,
    topSummary,
    todaySummary,
    yesterdayCost,
  } = usageRowGroups;

  const clientUsageTrendAnalytics = useMemo(
    () => buildUsageTrendAnalytics(trendStatsRows, timeRange, usageTrendApiKey, t('monitoring.filter_all_api_keys')),
    [trendStatsRows, timeRange, usageTrendApiKey, t]
  );
  const serverUsageTrendAnalytics = useMemo(
    () => buildServerUsageTrendAnalytics(
      usageAggregates,
      usageAggregates?.scopeTimeRange ?? timeRange,
      modelPrices,
      clientUsageTrendAnalytics.apiKeyOptions,
      usageAggregates?.scopeApiKeyHash ?? usageTrendApiKey
    ),
    [clientUsageTrendAnalytics.apiKeyOptions, modelPrices, timeRange, usageAggregates, usageTrendApiKey]
  );
  const aggregateTrendScopeMatches = Boolean(
    usageAggregates
      && usageAggregates.scopeTimeRange === timeRange
      && usageAggregates.scopeApiKeyHash === usageTrendApiKey
  );
  const usageTrendAnalytics = useMemo(() => {
    if (!serverUsageTrendAnalytics || (aggregatesError && !aggregateTrendScopeMatches)) {
      return clientUsageTrendAnalytics;
    }
    if (serverUsageTrendAnalytics.apiKeyRows.length > 0 || clientUsageTrendAnalytics.apiKeyRows.length === 0) {
      return serverUsageTrendAnalytics;
    }
    return {
      ...serverUsageTrendAnalytics,
      apiKeyRows: clientUsageTrendAnalytics.apiKeyRows,
    };
  }, [aggregateTrendScopeMatches, aggregatesError, clientUsageTrendAnalytics, serverUsageTrendAnalytics]);
  const usageTrendApiKeyOptions = usageTrendAnalytics.apiKeyOptions;
  const usageTrendPoints = usageTrendAnalytics.trendPoints;
  const tokenDistributionPoints = usageTrendAnalytics.tokenDistributionPoints;
  useEffect(() => {
    if (usageTrendApiKey !== 'all' && !usageTrendApiKeyOptions.some((option) => option.value === usageTrendApiKey)) {
      setUsageTrendApiKey('all');
    }
  }, [usageTrendApiKey, usageTrendApiKeyOptions]);

  const modelRankingRows = useMemo(
    () => [...usageTrendAnalytics.modelRows]
      .sort((left, right) => (
        getRankingMetricValue(right, modelRankingMetric) - getRankingMetricValue(left, modelRankingMetric)
        || right.totalTokens - left.totalTokens
        || right.totalCalls - left.totalCalls
      )),
    [modelRankingMetric, usageTrendAnalytics.modelRows]
  );
  const modelRankingMetricTotal = usageTrendAnalytics.scopedTotals[modelRankingMetric];
  const apiKeyRankingRows = useMemo(
    () => [...usageTrendAnalytics.apiKeyRows]
      .sort((left, right) => (
        getRankingMetricValue(right, apiKeyRankingMetric) - getRankingMetricValue(left, apiKeyRankingMetric)
        || right.totalCalls - left.totalCalls
        || right.totalCost - left.totalCost
      ))
      .slice(0, 8),
    [apiKeyRankingMetric, usageTrendAnalytics.apiKeyRows]
  );
  const apiKeyRankingMetricTotal = useMemo(
    () => usageTrendAnalytics.apiKeyRows.reduce(
      (total, row) => total + getRankingMetricValue(row, apiKeyRankingMetric),
      0
    ),
    [apiKeyRankingMetric, usageTrendAnalytics.apiKeyRows]
  );
  const accountStatsFilteredRows = useMemo(
    () => trendStatsRows.length > ACCOUNT_STATS_ANALYTICS_ROW_LIMIT
      ? trendStatsRows.slice(0, ACCOUNT_STATS_ANALYTICS_ROW_LIMIT)
      : trendStatsRows,
    [trendStatsRows]
  );
  const clientAccountStatsRows = useMemo(
    () => buildAccountRowsByAccount(accountStatsFilteredRows, true),
    [accountStatsFilteredRows]
  );
  const serverAccountStatsRows = useMemo(
    () => usageAggregates
      ? buildServerAccountRows(usageAggregates.accounts, allRows, authFilesByAuthIndex, modelPrices, t('monitoring.deleted_credential'))
      : null,
    [allRows, authFilesByAuthIndex, modelPrices, t, usageAggregates]
  );
  const accountStatsRows = useMemo(
    () => [...(
      aggregatesError && usageAggregates?.scopeTimeRange !== timeRange
        ? clientAccountStatsRows
        : serverAccountStatsRows ?? clientAccountStatsRows
    )]
      .sort((left, right) => (
        getAccountSortValue(right, accountStatsMetric) - getAccountSortValue(left, accountStatsMetric)
        || right.lastSeenAt - left.lastSeenAt
        || right.totalCalls - left.totalCalls
      )),
    [accountStatsMetric, aggregatesError, clientAccountStatsRows, serverAccountStatsRows, timeRange, usageAggregates?.scopeTimeRange]
  );
  const serverTopSummary = useMemo(
    () => usageAggregates ? buildAggregateSummary(usageAggregates.allSummary, modelPrices) : null,
    [modelPrices, usageAggregates]
  );
  const recentDailySummaries = useMemo(() => {
    if (!usageAggregates) return null;
    const grouped = new Map<string, UsageAggregateBucket[]>();
    usageAggregates.recentDailySummary.forEach((bucket) => {
      const dayKey = buildLocalDayKey(bucket.bucketStartMs);
      const items = grouped.get(dayKey) ?? [];
      items.push(bucket);
      grouped.set(dayKey, items);
    });
    const now = new Date();
    const todayKey = buildLocalDayKey(now.getTime());
    now.setDate(now.getDate() - 1);
    const yesterdayKey = buildLocalDayKey(now.getTime());
    return {
      today: buildAggregateSummary(grouped.get(todayKey) ?? [], modelPrices),
      yesterday: buildAggregateSummary(grouped.get(yesterdayKey) ?? [], modelPrices),
    };
  }, [modelPrices, usageAggregates]);
  const effectiveTopSummary = serverTopSummary ?? topSummary;
  const effectiveTodaySummary = recentDailySummaries?.today ?? todaySummary;
  const effectiveTodayCost = effectiveTodaySummary.totalCost;
  const effectiveYesterdayCost = recentDailySummaries?.yesterday.totalCost ?? yesterdayCost;
  const timeRangeLabel = useMemo(() => buildUsageTrendRangeLabel(timeRange, t), [timeRange, t]);
  const realtimeLogTotalCount = realtimeLogMatchedTotal;
  const realtimeLogTotalPages = realtimeLogTotalCount > 0 ? Math.ceil(realtimeLogTotalCount / REALTIME_LOG_PAGE_SIZE) : 0;
  const normalizedRealtimeLogPage = Math.min(Math.max(1, realtimeLogPage), Math.max(1, realtimeLogTotalPages));
  const realtimeLogPageRows = useMemo(
    () => buildRealtimeLogPageRows(scopedRows, 1, REALTIME_LOG_PAGE_SIZE).rows,
    [scopedRows]
  );
  const realtimeLogPagination = getClientPaginationRange(
    normalizedRealtimeLogPage,
    REALTIME_LOG_PAGE_SIZE,
    realtimeLogTotalCount,
    realtimeLogPageRows.length
  );
  const realtimeLogColumnDefinitions = useMemo<Record<RealtimeLogColumnKey, RealtimeLogColumnDefinition>>(() => ({
    type: {
      key: 'type',
      label: t('monitoring.column_type'),
      colClassName: styles.realtimeTypeCol,
      width: REALTIME_LOG_COLUMN_DEFAULT_WIDTHS.type,
      render: (row) => (
        <div className={styles.primaryCell}>
          <span>{row.provider}</span>
          <small>{row.account || row.authLabel || row.accountMasked || '-'}</small>
        </div>
      ),
    },
    model: {
      key: 'model',
      label: t('monitoring.column_model'),
      colClassName: styles.realtimeModelCol,
      width: REALTIME_LOG_COLUMN_DEFAULT_WIDTHS.model,
      render: (row) => (
        <div className={styles.primaryCell}>
          <span className={styles.monoCell}>{row.model}</span>
          <small className={styles.monoCell}>
            {row.modelAlias && row.modelAlias !== row.model ? row.modelAlias : buildRealtimeMetaText(row)}
          </small>
          {row.modelAlias && row.modelAlias !== row.model ? (
            <small className={styles.monoCell}>{buildRealtimeMetaText(row)}</small>
          ) : null}
        </div>
      ),
    },
    apiKey: {
      key: 'apiKey',
      label: t('monitoring.api_key_label'),
      colClassName: styles.realtimeApiKeyCol,
      width: REALTIME_LOG_COLUMN_DEFAULT_WIDTHS.apiKey,
      render: (row) => <span className={styles.monoCell}>{row.clientApiKey.masked}</span>,
    },
    recent: {
      key: 'recent',
      label: t('monitoring.recent_status'),
      colClassName: styles.realtimeRecentCol,
      cellClassName: () => styles.realtimeNowrapCell,
      width: REALTIME_LOG_COLUMN_DEFAULT_WIDTHS.recent,
      render: (row) => (
        <div className={styles.recentStatusCell}>
          <RecentPattern
            pattern={row.recentPattern}
            variant="plain"
            label={t('monitoring.recent_pattern_label', {
              total: row.recentPattern.length,
              success: row.recentSuccessCount,
              failure: row.recentFailureCount,
            })}
          />
        </div>
      ),
    },
    status: {
      key: 'status',
      label: t('monitoring.request_status'),
      colClassName: styles.realtimeStatusCol,
      width: REALTIME_LOG_COLUMN_DEFAULT_WIDTHS.status,
      render: (row) => (
        <div className={styles.primaryCell}>
          {row.failed ? (
            <button
              type="button"
              className={styles.realtimeStatusErrorButton}
              onClick={() => setSelectedRealtimeErrorRow(row)}
              title={translateRealtimeErrorText('error_details_click_hint', t, i18n.language)}
              aria-label={translateRealtimeErrorText('error_details_click_hint', t, i18n.language)}
            >
              <StatusBadge tone="bad">{buildRealtimeStatusLabel(row, t('monitoring.result_failed'))}</StatusBadge>
            </button>
          ) : (
            <StatusBadge tone="good">{t('monitoring.result_success')}</StatusBadge>
          )}
        </div>
      ),
    },
    successRate: {
      key: 'successRate',
      label: t('monitoring.column_success_rate'),
      colClassName: styles.realtimeRateCol,
      headerClassName: styles.realtimeMetricHeader,
      cellClassName: (row) => `${styles.realtimeMetricCell} ${getSuccessRateClassName(row.successRate)}`,
      width: REALTIME_LOG_COLUMN_DEFAULT_WIDTHS.successRate,
      render: (row) => formatPercent(row.successRate),
    },
    calls: {
      key: 'calls',
      label: t('monitoring.total_calls'),
      colClassName: styles.realtimeCountCol,
      headerClassName: styles.realtimeMetricHeader,
      cellClassName: () => styles.realtimeMetricCell,
      width: REALTIME_LOG_COLUMN_DEFAULT_WIDTHS.calls,
      render: (row) => formatCompactNumber(row.requestCount),
    },
    ttft: {
      key: 'ttft',
      label: t('monitoring.column_ttft'),
      colClassName: styles.realtimeTtftCol,
      headerClassName: styles.realtimeMetricHeader,
      cellClassName: () => styles.realtimeMetricCell,
      width: REALTIME_LOG_COLUMN_DEFAULT_WIDTHS.ttft,
      render: (row) => (
        <span
          className={
            row.ttftMs !== null && row.ttftMs >= 15000
              ? styles.badText
              : row.ttftMs !== null && row.ttftMs >= 8000
                ? styles.warnText
                : undefined
          }
        >
          {formatDurationMs(row.ttftMs, { locale: i18n.language })}
        </span>
      ),
    },
    latency: {
      key: 'latency',
      label: t('monitoring.column_latency'),
      colClassName: styles.realtimeLatencyCol,
      headerClassName: styles.realtimeMetricHeader,
      cellClassName: () => styles.realtimeMetricCell,
      width: REALTIME_LOG_COLUMN_DEFAULT_WIDTHS.latency,
      render: (row) => (
        <span
          className={
            row.latencyMs !== null && row.latencyMs >= 30000
              ? styles.badText
              : row.latencyMs !== null && row.latencyMs >= 15000
                ? styles.warnText
                : undefined
          }
        >
          {formatDurationMs(row.latencyMs, { locale: i18n.language })}
        </span>
      ),
    },
    time: {
      key: 'time',
      label: t('monitoring.column_time'),
      colClassName: styles.realtimeTimeCol,
      cellClassName: () => styles.realtimeTimeCell,
      width: REALTIME_LOG_COLUMN_DEFAULT_WIDTHS.time,
      render: (row) => new Date(row.timestampMs).toLocaleString(i18n.language),
    },
    usage: {
      key: 'usage',
      label: t('monitoring.this_call_usage'),
      colClassName: styles.realtimeUsageCol,
      cellClassName: () => styles.realtimeUsageTableCell,
      width: REALTIME_LOG_COLUMN_DEFAULT_WIDTHS.usage,
      render: (row) => (
        <div className={`${styles.primaryCell} ${styles.realtimeUsageCell}`}>
          <span>{formatCompactNumber(row.totalTokens)}</span>
          <small className={styles.realtimeUsageBreakdown}>
            <span><b>I</b><span>{formatCompactNumber(row.inputTokens)}</span></span>
            <span><b>O</b><span>{formatCompactNumber(row.outputTokens)}</span></span>
            <span><b>R</b><span>{formatCompactNumber(row.reasoningTokens)}</span></span>
            <span><b>C</b><span>{formatCompactNumber(row.cachedTokens)}</span></span>
          </small>
        </div>
      ),
    },
    cost: {
      key: 'cost',
      label: t('monitoring.this_call_cost'),
      colClassName: styles.realtimeCostCol,
      headerClassName: styles.realtimeMetricHeader,
      cellClassName: () => styles.realtimeMetricCell,
      width: REALTIME_LOG_COLUMN_DEFAULT_WIDTHS.cost,
      render: (row) => (hasPrices ? formatUsd(row.totalCost) : '--'),
    },
  }), [hasPrices, i18n.language, t]);
  const visibleRealtimeLogColumns = useMemo(
    () => realtimeLogColumns
      .filter((column) => column.visible)
      .map((column) => {
        const definition = realtimeLogColumnDefinitions[column.key];
        const contentWidth = column.width ?? estimateRealtimeLogColumnWidth(
          column.key,
          definition.label,
          realtimeLogPageRows
        );
        return {
          ...definition,
          width: Math.max(contentWidth, estimateRealtimeLogHeaderWidth(column.key, definition.label)),
        };
      })
      .filter(Boolean),
    [realtimeLogColumnDefinitions, realtimeLogColumns, realtimeLogPageRows]
  );
  const realtimeLogTableMinWidth = useMemo(
    () => visibleRealtimeLogColumns.reduce((total, column) => total + column.width, 0),
    [visibleRealtimeLogColumns]
  );
  const realtimeLogVisibleColumnCount = Math.max(1, visibleRealtimeLogColumns.length);
  const realtimeLogVisiblePreferenceCount = realtimeLogColumns.filter((column) => column.visible).length;

  useEffect(() => {
    if (connectionStatus !== 'connected') return;
    void refreshRealtimeLogs();
  }, [connectionStatus, refreshRealtimeLogs]);

  const accountQuotaTargetsByAccount = useMemo(
    () => {
      if (!usageAggregates || aggregatesError) {
        return buildAccountQuotaTargetsByAccount(accountStatsFilteredRows, authFilesByAuthIndex);
      }
      const sources = Array.from(new Set(usageAggregates.accounts.map((bucket) => bucket.authIndex).filter(Boolean)))
        .map((authIndex) => {
          const file = authFilesByAuthIndex.get(authIndex as string);
          const account = file
            ? [file.email, file.account, file.label, file.name]
                .map((value) => typeof value === 'string' ? value.trim() : '')
                .find(Boolean) || authIndex as string
            : authIndex as string;
          return {
            authIndex: authIndex as string,
            account,
            authLabel: file?.name || account,
          } satisfies AccountQuotaSourceRow;
        });
      return buildAccountQuotaTargetsByAccount(sources, authFilesByAuthIndex);
    },
    [accountStatsFilteredRows, aggregatesError, authFilesByAuthIndex, usageAggregates]
  );
  const accountQuotaEntriesByAccount = useMemo(
    () => buildAccountQuotaEntriesByAccount(accountQuotaTargetsByAccount, quotaStore, t),
    [accountQuotaTargetsByAccount, quotaStore, t]
  );
  const quotaTargetsByAccountForLoading = accountQuotaTargetsByAccount;

  const savedPriceEntries = useMemo(
    () => Object.entries(modelPrices).sort((left, right) => left[0].localeCompare(right[0])),
    [modelPrices]
  );

  const selectedFiltersCount =
    [selectedProvider, selectedModel, selectedApiKey, selectedStatus].filter(
      (value) => value !== 'all'
    ).length + (deferredSearch.trim() ? 1 : 0);

  const usageMetricCards: UsageMetricCard[] = [
    {
      key: 'traffic',
      title: t('monitoring.traffic_title'),
      label: t('monitoring.today_requests'),
      value: formatCompactNumber(effectiveTodaySummary.totalCalls),
      accent: 'blue',
      footer: [
        { label: t('monitoring.total_requests_label'), value: formatCompactNumber(effectiveTopSummary.totalCalls) },
        { label: t('monitoring.total_success_rate'), value: formatPercent(effectiveTopSummary.successRate) },
      ],
    },
    {
      key: 'tokens',
      title: 'Token',
      label: t('monitoring.today_tokens'),
      value: formatCompactNumber(effectiveTodaySummary.totalTokens),
      accent: 'purple',
      footer: [
        { label: t('monitoring.total_tokens_label'), value: formatCompactNumber(effectiveTopSummary.totalTokens) },
        { label: t('monitoring.input_output_reasoning'), value: `${formatCompactNumber(effectiveTopSummary.inputTokens)} / ${formatCompactNumber(effectiveTopSummary.outputTokens)} / ${formatCompactNumber(effectiveTopSummary.reasoningTokens)}` },
      ],
    },
    {
      key: 'cache',
      title: t('monitoring.cache_title'),
      label: t('monitoring.today_cache_hit_rate'),
      value: formatPercent(effectiveTodaySummary.inputTokens > 0 ? effectiveTodaySummary.cachedTokens / effectiveTodaySummary.inputTokens : 0),
      accent: 'green',
      footer: [
        { label: t('monitoring.today_cached_tokens'), value: formatCompactNumber(effectiveTodaySummary.cachedTokens) },
        { label: t('monitoring.total_cache_hits'), value: `${formatCompactNumber(effectiveTopSummary.cachedTokens)} / ${formatPercent(effectiveTopSummary.inputTokens > 0 ? effectiveTopSummary.cachedTokens / effectiveTopSummary.inputTokens : 0)}` },
      ],
    },
    {
      key: 'billing',
      title: t('monitoring.billing_title'),
      label: t('monitoring.today_cost'),
      value: hasPrices ? formatUsd(effectiveTodayCost) : '--',
      accent: 'amber',
      footer: [
        { label: t('monitoring.vs_yesterday'), value: hasPrices ? formatDeltaPercent(effectiveTodayCost, effectiveYesterdayCost) : '--' },
        { label: t('monitoring.total_cost_label'), value: hasPrices ? formatUsd(effectiveTopSummary.totalCost) : '--' },
      ],
    },
  ];

  const clearFilters = useCallback(() => {
    setSearchInput('');
    setSelectedProvider('all');
    setSelectedModel('all');
    setSelectedApiKey('all');
    setSelectedStatus('all');
  }, []);

  const updateRealtimeLogColumns = useCallback((updater: (columns: RealtimeLogColumnPreference[]) => RealtimeLogColumnPreference[]) => {
    setRealtimeLogColumns((current) => {
      const next = normalizeRealtimeLogColumns(updater(current));
      saveRealtimeLogColumns(next);
      return next;
    });
  }, []);

  const toggleRealtimeLogColumn = useCallback((key: RealtimeLogColumnKey) => {
    updateRealtimeLogColumns((columns) => {
      const visibleCount = columns.filter((item) => item.visible).length;
      return columns.map((item) => {
        if (item.key !== key) return item;
        if (item.visible && visibleCount <= 1) return item;
        return { ...item, visible: !item.visible };
      });
    });
  }, [updateRealtimeLogColumns]);

  const reorderRealtimeLogColumn = useCallback((sourceKey: RealtimeLogColumnKey, targetKey: RealtimeLogColumnKey) => {
    if (sourceKey === targetKey) return;
    updateRealtimeLogColumns((columns) => {
      const sourceIndex = columns.findIndex((item) => item.key === sourceKey);
      const targetIndex = columns.findIndex((item) => item.key === targetKey);
      if (sourceIndex < 0 || targetIndex < 0) return columns;
      const next = [...columns];
      const [item] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, item);
      return next;
    });
  }, [updateRealtimeLogColumns]);

  const resizeRealtimeLogColumn = useCallback((key: RealtimeLogColumnKey, width: number) => {
    updateRealtimeLogColumns((columns) => columns.map((column) => (
      column.key === key ? { ...column, width: clampRealtimeLogColumnWidth(key, width) } : column
    )));
  }, [updateRealtimeLogColumns]);

  const handleRealtimeLogHeaderDragStart = useCallback((event: DragEvent<HTMLTableCellElement>, key: RealtimeLogColumnKey) => {
    setDraggedRealtimeLogColumnKey(key);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', key);
  }, []);

  const handleRealtimeLogHeaderDragOver = useCallback((event: DragEvent<HTMLTableCellElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const handleRealtimeLogHeaderDrop = useCallback((event: DragEvent<HTMLTableCellElement>, targetKey: RealtimeLogColumnKey) => {
    event.preventDefault();
    const sourceKey = draggedRealtimeLogColumnKey ?? event.dataTransfer.getData('text/plain');
    if (isRealtimeLogColumnKey(sourceKey)) {
      reorderRealtimeLogColumn(sourceKey, targetKey);
    }
    setDraggedRealtimeLogColumnKey(null);
  }, [draggedRealtimeLogColumnKey, reorderRealtimeLogColumn]);

  const handleRealtimeLogHeaderDragEnd = useCallback(() => {
    setDraggedRealtimeLogColumnKey(null);
  }, []);

  const startRealtimeLogColumnResize = useCallback((event: ReactMouseEvent<HTMLSpanElement>, key: RealtimeLogColumnKey) => {
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = visibleRealtimeLogColumns.find((column) => column.key === key)?.width ?? REALTIME_LOG_COLUMN_DEFAULT_WIDTHS[key];
    const handleMouseMove = (moveEvent: MouseEvent) => {
      resizeRealtimeLogColumn(key, startWidth + moveEvent.clientX - startX);
    };
    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [resizeRealtimeLogColumn, visibleRealtimeLogColumns]);

  const resetRealtimeLogColumns = useCallback(() => {
    updateRealtimeLogColumns(() => createDefaultRealtimeLogColumns());
  }, [updateRealtimeLogColumns]);

  useEffect(() => {
    if (!isRealtimeColumnsMenuOpen) return undefined;

    const handleDocumentMouseDown = (event: MouseEvent) => {
      if (event.target instanceof Node && realtimeColumnsMenuRef.current?.contains(event.target)) {
        return;
      }
      setIsRealtimeColumnsMenuOpen(false);
    };

    document.addEventListener('mousedown', handleDocumentMouseDown);
    return () => {
      document.removeEventListener('mousedown', handleDocumentMouseDown);
    };
  }, [isRealtimeColumnsMenuOpen]);

  const loadAccountQuota = useCallback(
    async (account: string, force: boolean = false) => {
      const currentState = accountQuotaStatesRef.current[account];
      const targets = quotaTargetsByAccountForLoading.get(account) ?? [];
      const targetKey = targets.map((target) => target.key).join('|');
      if (!force && currentState && currentState.status !== 'idle' && currentState.targetKey === targetKey) {
        return;
      }

      const requestId = (accountQuotaRequestIdsRef.current[account] ?? 0) + 1;
      accountQuotaRequestIdsRef.current[account] = requestId;

      setAccountQuotaStates((previous) => ({
        ...previous,
        [account]: {
          status: 'loading',
          targetKey,
          lastRefreshedAt: previous[account]?.lastRefreshedAt,
        },
      }));

      if (targets.length === 0) {
        if (accountQuotaRequestIdsRef.current[account] !== requestId) return;
        setAccountQuotaStates((previous) => ({
          ...previous,
          [account]: {
            status: 'success',
            targetKey,
            lastRefreshedAt: Date.now(),
          },
        }));
        return;
      }

      targets.forEach((target) => {
        setQuotaForConfig(target.config, (prev) => ({
          ...prev,
          [target.fileName]: target.config.buildLoadingState(),
        }));
      });

      const settled = await settleWithConcurrency(
        targets,
        ACCOUNT_QUOTA_REQUEST_CONCURRENCY,
        (target) => requestAccountQuota(target, t)
      );
      if (accountQuotaRequestIdsRef.current[account] !== requestId) return;

      settled.forEach((result, index) => {
        const target = targets[index];
        const quota = result.status === 'fulfilled'
          ? result.value
          : target.config.buildErrorState(
              result.reason instanceof Error ? result.reason.message : String(result.reason || t('common.unknown_error')),
              getStatusFromError(result.reason)
            ) as QuotaStatusState;

        setQuotaForConfig(target.config, (prev) => ({
          ...prev,
          [target.fileName]: quota,
        }));
      });

      const currentStore = useQuotaStore.getState();
      const entries = targets.map((target) => getQuotaForTarget(currentStore, target)).filter(Boolean) as QuotaStatusState[];
      const hasSuccess = entries.some((entry) => entry.status === 'success');
      const firstError = entries.find((entry) => entry.status === 'error')?.error;
      setAccountQuotaStates((previous) => ({
        ...previous,
        [account]: {
          status: hasSuccess ? 'success' : 'error',
          targetKey,
          error: hasSuccess ? '' : firstError || t('common.unknown_error'),
          lastRefreshedAt: Date.now(),
        },
      }));
    },
    [quotaTargetsByAccountForLoading, setQuotaForConfig, t]
  );

  const toggleAccountExpanded = useCallback((accountId: string, account: string) => {
    if (account && !expandedAccounts[accountId]) {
      void loadAccountQuota(account);
    }
    setExpandedAccounts((previous) => ({
      ...previous,
      [accountId]: !previous[accountId],
    }));
  }, [expandedAccounts, loadAccountQuota]);

  const handlePriceModelChange = useCallback(
    (value: string) => {
      setPriceModel(value);
      setPriceDraft(createPriceDraft(modelPrices[value]));
    },
    [modelPrices]
  );

  const handlePriceDraftChange = useCallback((field: keyof PriceDraft, value: string) => {
    setPriceDraft((previous) => ({ ...previous, [field]: value }));
  }, []);

  const resetPriceEditor = useCallback(() => {
    setPriceModel('');
    setPriceDraft(createPriceDraft());
  }, []);

  const handleSavePrice = useCallback(() => {
    if (!priceModel) {
      return;
    }

    const prompt = parsePriceValue(priceDraft.prompt);
    const completion = parsePriceValue(priceDraft.completion);
    const cache = priceDraft.cache.trim() === '' ? prompt : parsePriceValue(priceDraft.cache);

    setModelPrices({
      ...modelPrices,
      [priceModel]: {
        prompt,
        completion,
        cache,
      },
    });
  }, [modelPrices, priceDraft.cache, priceDraft.completion, priceDraft.prompt, priceModel, setModelPrices]);

  const handleDeletePrice = useCallback(
    (model: string) => {
      const nextPrices = { ...modelPrices };
      delete nextPrices[model];
      setModelPrices(nextPrices);

      if (priceModel === model) {
        resetPriceEditor();
      }
    },
    [modelPrices, priceModel, resetPriceEditor, setModelPrices]
  );

  return (
    <div className={styles.page}>
      <section className={styles.masthead}>
        <div className={styles.mastheadGlow} aria-hidden="true" />

        <div className={styles.mastheadCopy}>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>{t('monitoring.title')}</h1>
            <div className={styles.titleActions}>
              <button
                type="button"
                className={`${styles.quickLinkButton} ${styles.mastheadActionButton}`}
                onClick={() => void handleExportUsage()}
              >
                {t('usage_stats.export')}
              </button>
              <button
                type="button"
                className={`${styles.quickLinkButton} ${styles.mastheadActionButton}`}
                onClick={handleImportUsageClick}
                disabled={isImportingUsage}
              >
                {isImportingUsage ? t('common.loading') : t('usage_stats.import')}
              </button>
              <button
                type="button"
                className={`${styles.quickLinkButton} ${styles.mastheadActionButton}`}
                onClick={() => setIsPriceModalOpen(true)}
              >
                {t('usage_stats.model_price_settings')}
              </button>
              <button
                type="button"
                className={`${styles.quickLinkButton} ${styles.mastheadActionButton}`}
                onClick={() => void loadMonitoringSettings()}
                disabled={isMonitoringSettingsLoading}
              >
                {isMonitoringSettingsLoading ? t('common.loading') : t('usage_stats.monitoring_settings')}
              </button>
              <input
                ref={importInputRef}
                type="file"
                accept=".jsonl,.ndjson,.json,application/x-ndjson,application/json"
                className={styles.hiddenFileInput}
                onChange={handleImportUsageFile}
              />
            </div>
          </div>
          <p className={styles.subtitle}>{t('monitoring.console_subtitle')}</p>

          <div className={styles.usageStatsHero}>
            <TopUsageStats cards={usageMetricCards} />
          </div>
        </div>
      </section>

      {!isUsageTrendHidden ? (
        <section className={styles.usageTrendSection}>
          <UsageTrendHeader
            range={timeRange}
            totalCalls={usageTrendAnalytics.scopedTotals.requests}
            apiKeyFilter={usageTrendApiKey}
            apiKeyOptions={usageTrendApiKeyOptions}
            onRangeChange={setTimeRange}
            onApiKeyFilterChange={setUsageTrendApiKey}
            onHide={() => setIsUsageTrendHidden(true)}
            t={t}
          />
          <div className={styles.usageTrendInsightsGrid}>
            <UsageTrendPanel
              points={usageTrendPoints}
              hasPrices={hasPrices}
              emptyText={t('monitoring.no_data')}
              t={t}
            />
            <ApiKeyRankingPanel
              title={t('monitoring.api_key_ranking_title')}
              subtitle={t('monitoring.api_key_ranking_desc')}
              rows={apiKeyRankingRows}
              metric={apiKeyRankingMetric}
              metricTotal={apiKeyRankingMetricTotal}
              onMetricChange={setApiKeyRankingMetric}
              emptyText={t('monitoring.no_data')}
              hasPrices={hasPrices}
              t={t}
            />
          </div>
          <div className={styles.rankingGrid}>
            <ModelStatsPanel
              title={t('monitoring.model_stats_title')}
              subtitle={t('monitoring.model_stats_desc')}
              rows={modelRankingRows}
              metric={modelRankingMetric}
              metricTotal={modelRankingMetricTotal}
              onMetricChange={setModelRankingMetric}
              emptyText={t('monitoring.no_data')}
              hasPrices={hasPrices}
              t={t}
            />
            <TokenDistributionPanel
              points={tokenDistributionPoints}
              emptyText={t('monitoring.no_data')}
              hasPrices={hasPrices}
              t={t}
            />
          </div>
        </section>
      ) : (
        <section className={styles.usageTrendCollapsed}>
          <div>
            <h2>{t('monitoring.usage_stats_title')}</h2>
            <p>{t('monitoring.analysis_hidden_desc')}</p>
          </div>
          <button type="button" className={styles.usageTrendHideButton} onClick={() => setIsUsageTrendHidden(false)}>
            {t('monitoring.show_analysis')}
          </button>
        </section>
      )}

      {!isAccountStatsHidden ? (
        <section className={styles.usageTrendSection}>
          <AccountStatsPanel
            rows={accountStatsRows}
            metric={accountStatsMetric}
            emptyText={t('monitoring.no_data')}
            hasPrices={hasPrices}
            locale={i18n.language}
            t={t}
            rangeLabel={timeRangeLabel}
            range={timeRange}
            onRangeChange={setTimeRange}
            onHide={() => setIsAccountStatsHidden(true)}
            expandedAccounts={expandedAccounts}
            accountQuotaStates={accountQuotaStates}
            accountQuotaEntriesByAccount={accountQuotaEntriesByAccount}
            onMetricChange={setAccountStatsMetric}
            onToggleAccount={toggleAccountExpanded}
            onRefreshQuota={(account) => void loadAccountQuota(account, true)}
          />
        </section>
      ) : (
        <section className={styles.usageTrendCollapsed}>
          <div>
            <h2>{t('monitoring.account_stats_title')}</h2>
            <p>{t('monitoring.account_stats_hidden_desc')}</p>
          </div>
          <button type="button" className={styles.usageTrendHideButton} onClick={() => setIsAccountStatsHidden(false)}>
            {t('monitoring.show_account_stats')}
          </button>
        </section>
      )}

      <section className={styles.usageTrendSection}>
        <div className={styles.usageTrendHeader}>
          <div className={styles.usageTrendCopy}>
            <h2>{t('monitoring.analysis_tab_logs')}</h2>
            <p>
              {selectedFiltersCount > 0
                ? t('monitoring.active_filters_hint', { count: selectedFiltersCount, rows: realtimeLogMatchedTotal })
                : t('monitoring.realtime_table_desc')}
            </p>
          </div>
          <div className={styles.usageTrendActions}>
            <div className={`${styles.rankingMetricSwitch} ${styles.timeRangeControl}`}>
              {TIME_RANGE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`${styles.rankingMetricButton} ${styles.timeRangeButton} ${timeRange === option.value ? styles.rankingMetricButtonActive : ''}`}
                  onClick={() => setTimeRange(option.value)}
                >
                  {t(option.labelKey)}
                </button>
              ))}
            </div>
          </div>
        </div>

        <Card className={styles.realtimePanel}>
        <div className={styles.filterGrid}>
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder={t('monitoring.search_placeholder')}
            className={styles.toolbarHeaderSearchInput}
            rightElement={<IconSearch size={16} />}
            aria-label={t('monitoring.search_placeholder')}
          />
          <Select
            value={selectedApiKey}
            options={apiKeyOptions}
            onChange={setSelectedApiKey}
            ariaLabel={t('monitoring.filter_api_key')}
          />
          <Select
            value={selectedProvider}
            options={providerOptions}
            onChange={setSelectedProvider}
            ariaLabel={t('monitoring.filter_provider')}
          />
          <Select
            value={selectedModel}
            options={modelOptions}
            onChange={setSelectedModel}
            ariaLabel={t('monitoring.filter_model')}
          />
          <Select
            value={selectedStatus}
            options={statusOptions}
            onChange={(value) => setSelectedStatus(value as StatusFilter)}
            ariaLabel={t('monitoring.filter_status')}
          />
          <button type="button" className={styles.clearButton} onClick={clearFilters}>
            <IconSlidersHorizontal size={16} />
            <span>{t('monitoring.clear_filters')}</span>
          </button>
          <div className={styles.realtimeColumnsMenu} ref={realtimeColumnsMenuRef}>
            <button
              type="button"
              className={styles.clearButton}
              onClick={() => setIsRealtimeColumnsMenuOpen((open) => !open)}
              aria-expanded={isRealtimeColumnsMenuOpen}
            >
              <IconSlidersHorizontal size={16} />
              <span>{t('monitoring.realtime_columns_title')}</span>
            </button>
            {isRealtimeColumnsMenuOpen ? (
              <div className={styles.realtimeColumnsDropdown}>
                <div className={styles.realtimeColumnsDropdownHeader}>
                  <span>{t('monitoring.realtime_columns_hint')}</span>
                  <button type="button" className={styles.inlineActionButton} onClick={resetRealtimeLogColumns}>
                    {t('monitoring.realtime_columns_reset')}
                  </button>
                </div>
                <div className={styles.realtimeColumnsDropdownList}>
                  {realtimeLogColumns.map((column) => {
                    const definition = realtimeLogColumnDefinitions[column.key];
                    return (
                      <label key={column.key} className={styles.realtimeColumnToggle}>
                        <input
                          type="checkbox"
                          checked={column.visible}
                          disabled={column.visible && realtimeLogVisiblePreferenceCount <= 1}
                          onChange={() => toggleRealtimeLogColumn(column.key)}
                        />
                        <span>{definition.label}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {combinedError ? <div className={styles.errorBox}>{combinedError}</div> : null}

        <div className={styles.inlineMetrics}>
          <span>{`${t('monitoring.log_rows')}: ${realtimeLogTotalCount}`}</span>
          <span>{`${t('monitoring.recent_failures')}: ${scopedFailureCount}`}</span>
          {realtimeLogMatchedTotal > 0 ? (
            <span>
              {t('monitoring.request_events_page_source_hint', {
                from: realtimeLogPagination.from,
                to: realtimeLogPagination.to,
                total: realtimeLogMatchedTotal,
                defaultValue: `Showing ${realtimeLogPagination.from}-${realtimeLogPagination.to} of ${realtimeLogMatchedTotal} matching events from a stable snapshot.`,
              })}
            </span>
          ) : null}
          {pendingRealtimeEventCount > 0 ? (
            <button type="button" className={styles.inlineActionButton} onClick={() => void refreshRealtimeLogs()}>
              {t('monitoring.request_events_new_available', {
                count: pendingRealtimeEventCount,
                defaultValue: `${pendingRealtimeEventCount} new events available`,
              })}
            </button>
          ) : null}
        </div>

        <div className={`${styles.tableWrapper} ${styles.tableScrollWrapper} ${styles.realtimeTableWrapper}`}>
          <table
            className={`${styles.table} ${styles.realtimeTable}`}
            style={{ '--realtime-table-min-width': `${realtimeLogTableMinWidth}px` } as CSSProperties}
          >
            <colgroup>
              {visibleRealtimeLogColumns.map((column) => (
                <col key={column.key} className={column.colClassName} style={{ width: `${column.width}px` }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {visibleRealtimeLogColumns.map((column) => (
                  <th
                    key={column.key}
                    className={[
                      styles.realtimeDraggableHeader,
                      column.headerClassName,
                      draggedRealtimeLogColumnKey === column.key ? styles.realtimeDraggableHeaderActive : '',
                    ].filter(Boolean).join(' ')}
                    draggable
                    scope="col"
                    onDragStart={(event) => handleRealtimeLogHeaderDragStart(event, column.key)}
                    onDragOver={handleRealtimeLogHeaderDragOver}
                    onDrop={(event) => handleRealtimeLogHeaderDrop(event, column.key)}
                    onDragEnd={handleRealtimeLogHeaderDragEnd}
                  >
                    <span className={styles.realtimeHeaderContent}>{column.label}</span>
                    <span
                      className={styles.realtimeColumnResizeHandle}
                      role="separator"
                      aria-label={t('monitoring.realtime_column_resize', { column: column.label })}
                      onMouseDown={(event) => startRealtimeLogColumnResize(event, column.key)}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {realtimeLogPageRows.map((row) => (
                <tr key={row.id} className={row.failed ? styles.logRowFailed : undefined}>
                  {visibleRealtimeLogColumns.map((column) => (
                    <td key={column.key} className={column.cellClassName?.(row)}>
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
              {realtimeLogPageRows.length === 0 ? (
                <tr>
                  <td colSpan={realtimeLogVisibleColumnCount}>
                    <div className={styles.emptyTable}>
                      {monitoringLoading ? t('common.loading') : deferredSearch.trim() ? t('monitoring.no_filtered_data') : t('monitoring.no_data')}
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {realtimeLogPagination.totalPages > 1 ? (
          <div className={quotaStyles.pagination}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void showPreviousRealtimeLogPage()}
              disabled={realtimeLogLoading || !realtimeLogPagination.hasPrevious}
              aria-label={t('monitoring.previous_page')}
            >
              {t('monitoring.previous_page')}
            </Button>
            <div className={quotaStyles.pageInfo}>
              {t('monitoring.pagination_info', {
                from: realtimeLogPagination.from,
                to: realtimeLogPagination.to,
                total: realtimeLogPagination.total,
                page: realtimeLogPagination.page,
                totalPages: realtimeLogPagination.totalPages,
                defaultValue: `${realtimeLogPagination.from}-${realtimeLogPagination.to} / ${realtimeLogPagination.total}`,
              })}
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void showNextRealtimeLogPage()}
              disabled={realtimeLogLoading || !realtimeLogNextCursor || !realtimeLogPagination.hasNext}
              aria-label={t('monitoring.next_page')}
            >
              {t('monitoring.next_page')}
            </Button>
          </div>
        ) : null}
        </Card>
      </section>

      <Modal
        open={Boolean(selectedRealtimeErrorRow)}
        onClose={() => setSelectedRealtimeErrorRow(null)}
        title={translateRealtimeErrorText('error_details', t, i18n.language)}
        width={720}
        className={styles.monitorModal}
        footer={selectedRealtimeErrorRow ? (
          <div className={styles.monitorModalActions}>
            <Button variant="secondary" size="sm" onClick={() => handleCopyRealtimeDiagnostic(selectedRealtimeErrorRow)}>
              {translateRealtimeErrorText('copy_diagnostic', t, i18n.language)}
            </Button>
            <Button variant="primary" size="sm" onClick={() => setSelectedRealtimeErrorRow(null)}>
              {t('common.close')}
            </Button>
          </div>
        ) : null}
      >
        {selectedRealtimeErrorRow ? (
          <RealtimeErrorDetailsPanel row={selectedRealtimeErrorRow} t={t} language={i18n.language} />
        ) : null}
      </Modal>

      <Modal
        open={isMonitoringSettingsOpen}
        onClose={() => setIsMonitoringSettingsOpen(false)}
        title={t('usage_stats.monitoring_settings')}
        width={760}
        className={styles.monitorModal}
      >
        <div className={styles.monitoringSettingsEditor}>
          <div className={styles.settingsSectionCard}>
            <div className={styles.settingsSectionHeader}>
              <strong>{t('usage_stats.monitoring_settings_retention_title')}</strong>
              <span>{t('usage_stats.monitoring_settings_retention_desc')}</span>
            </div>
            <label className={styles.settingsField}>
              <span>{t('usage_stats.monitoring_settings_retention_days')}</span>
              <Input
                type="number"
                min="0"
                step="1"
                value={monitoringSettingsDraft.retentionDays}
                onChange={(event) => setMonitoringSettingsDraft((previous) => ({ ...previous, retentionDays: event.target.value }))}
                placeholder="0"
              />
              <small>{t('usage_stats.monitoring_settings_retention_hint')}</small>
              <div className={styles.settingsScheduleNote}>{t('usage_stats.monitoring_settings_retention_schedule')}</div>
            </label>
          </div>

          <div className={styles.settingsSectionCard}>
            <div className={styles.settingsSectionHeader}>
              <strong>{t('usage_stats.monitoring_settings_webdav_title')}</strong>
              <span>{t('usage_stats.monitoring_settings_webdav_desc')}</span>
            </div>
            <label className={styles.settingsCheckboxField}>
              <input
                type="checkbox"
                checked={monitoringSettingsDraft.webdavEnabled}
                onChange={(event) => setMonitoringSettingsDraft((previous) => ({ ...previous, webdavEnabled: event.target.checked }))}
              />
              <span>{t('usage_stats.monitoring_settings_webdav_enabled')}</span>
            </label>
            <div className={styles.settingsGrid}>
              <label className={styles.settingsField}>
                <span>{t('usage_stats.monitoring_settings_webdav_interval')}</span>
                <Input
                  type="number"
                  min="1"
                  step="1"
                  value={monitoringSettingsDraft.webdavIntervalMinutes}
                  onChange={(event) => setMonitoringSettingsDraft((previous) => ({ ...previous, webdavIntervalMinutes: event.target.value }))}
                  placeholder="1440"
                />
              </label>
              <label className={styles.settingsField}>
                <span>{t('usage_stats.monitoring_settings_webdav_retention_days')}</span>
                <Input
                  type="number"
                  min="0"
                  step="1"
                  value={monitoringSettingsDraft.webdavRetentionDays}
                  onChange={(event) => setMonitoringSettingsDraft((previous) => ({ ...previous, webdavRetentionDays: event.target.value }))}
                  placeholder="0"
                />
                <small>{t('usage_stats.monitoring_settings_webdav_retention_hint')}</small>
              </label>
              <label className={styles.settingsField}>
                <span>{t('usage_stats.monitoring_settings_webdav_url')}</span>
                <Input
                  value={monitoringSettingsDraft.webdavUrl}
                  onChange={(event) => setMonitoringSettingsDraft((previous) => ({ ...previous, webdavUrl: event.target.value }))}
                  placeholder="https://example.com/dav/path"
                />
              </label>
              <label className={styles.settingsField}>
                <span>{t('usage_stats.monitoring_settings_webdav_username')}</span>
                <Input
                  value={monitoringSettingsDraft.webdavUsername}
                  onChange={(event) => setMonitoringSettingsDraft((previous) => ({ ...previous, webdavUsername: event.target.value }))}
                  autoComplete="username"
                />
              </label>
              <label className={styles.settingsField}>
                <span>{t('usage_stats.monitoring_settings_webdav_password')}</span>
                <Input
                  type="password"
                  value={monitoringSettingsDraft.webdavPassword}
                  onChange={(event) => setMonitoringSettingsDraft((previous) => ({ ...previous, webdavPassword: event.target.value }))}
                  autoComplete="current-password"
                />
              </label>
            </div>
            <small className={styles.settingsHint}>{t('usage_stats.monitoring_settings_webdav_hint')}</small>
          </div>

          <div className={styles.priceActionsBar}>
            <Button variant="secondary" size="sm" onClick={() => setIsMonitoringSettingsOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" size="sm" onClick={() => void handleSaveMonitoringSettings()} disabled={isMonitoringSettingsSaving}>
              {isMonitoringSettingsSaving ? t('common.loading') : t('common.save')}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={isPriceModalOpen}
        onClose={() => setIsPriceModalOpen(false)}
        title={t('usage_stats.model_price_settings')}
        width={860}
        className={styles.monitorModal}
      >
        <div className={styles.priceEditor}>
          <div className={styles.priceGrid}>
            <div className={`${styles.priceField} ${styles.priceFieldModel}`}>
              <label>{t('usage_stats.model_name')}</label>
              <Select
                value={priceModel}
                options={priceModelOptions}
                onChange={handlePriceModelChange}
                ariaLabel={t('usage_stats.model_name')}
              />
            </div>
            <div className={`${styles.priceField} ${styles.priceFieldPrompt}`}>
              <label>{`${t('usage_stats.model_price_prompt')} ($/1M)`}</label>
              <Input
                type="number"
                value={priceDraft.prompt}
                onChange={(event) => handlePriceDraftChange('prompt', event.target.value)}
                placeholder="0.0000"
                step="0.0001"
              />
            </div>
            <div className={`${styles.priceField} ${styles.priceFieldCompletion}`}>
              <label>{`${t('usage_stats.model_price_completion')} ($/1M)`}</label>
              <Input
                type="number"
                value={priceDraft.completion}
                onChange={(event) => handlePriceDraftChange('completion', event.target.value)}
                placeholder="0.0000"
                step="0.0001"
              />
            </div>
            <div className={`${styles.priceField} ${styles.priceFieldCache}`}>
              <label>{`${t('usage_stats.model_price_cache')} ($/1M)`}</label>
              <Input
                type="number"
                value={priceDraft.cache}
                onChange={(event) => handlePriceDraftChange('cache', event.target.value)}
                placeholder="0.0000"
                step="0.0001"
              />
            </div>
          </div>

          <div className={styles.priceActionsBar}>
            <Button variant="secondary" size="sm" onClick={resetPriceEditor}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" size="sm" onClick={handleSavePrice} disabled={!priceModel}>
              {t('common.save')}
            </Button>
          </div>
        </div>

        <div className={styles.savedPricesList}>
          <div className={styles.savedPricesHeader}>{t('usage_stats.saved_prices')}</div>
          {savedPriceEntries.length > 0 ? (
            <div className={styles.savedPricesTableWrap}>
              <table className={styles.savedPricesTable}>
                <thead>
                  <tr>
                    <th>{t('usage_stats.model_name')}</th>
                    <th>{t('usage_stats.model_price_prompt')}</th>
                    <th>{t('usage_stats.model_price_completion')}</th>
                    <th>{t('usage_stats.model_price_cache')}</th>
                    <th>{t('common.action')}</th>
                  </tr>
                </thead>
                <tbody>
                  {savedPriceEntries.map(([model, price]) => (
                    <tr key={model}>
                      <td className={`${styles.monoCell} ${styles.savedPricesModelCell}`}>{model}</td>
                      <td>{formatPriceUnit(price.prompt)}</td>
                      <td>{formatPriceUnit(price.completion)}</td>
                      <td>{formatPriceUnit(price.cache)}</td>
                      <td className={styles.savedPricesActionsCell}>
                        <div className={styles.savedPricesActions}>
                          <button
                            type="button"
                            className={styles.inlineActionButton}
                            onClick={() => handlePriceModelChange(model)}
                          >
                            {t('common.edit')}
                          </button>
                          <button
                            type="button"
                            className={styles.inlineActionButton}
                            onClick={() => handleDeletePrice(model)}
                          >
                            {t('common.delete')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className={styles.emptyBlockSmall}>{t('usage_stats.model_price_empty')}</div>
          )}
        </div>
      </Modal>
    </div>
  );
}
