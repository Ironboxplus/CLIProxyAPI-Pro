import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
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
  buildAccountRows,
  buildMonitoringSummary,
  useMonitoringData,
  type MonitoringAccountRow,
  type MonitoringEventRow,
  type MonitoringStatusTone,
  type MonitoringTimeRange,
} from '@/features/monitoring/hooks/useMonitoringData';
import { useUsageData } from '@/features/monitoring/hooks/useUsageData';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useInterval } from '@/hooks/useInterval';
import { apiClient } from '@/services/api/client';
import { useAuthStore, useConfigStore, useNotificationStore, useQuotaStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { maskSensitiveText } from '@/utils/format';
import { getStatusFromError } from '@/utils/quota';
import { formatCompactNumber, formatDurationMs, formatUsd, normalizeAuthIndex, type ModelPrice } from '@/utils/usage';
import {
  ANTIGRAVITY_CONFIG,
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  GEMINI_CLI_CONFIG,
  KIMI_CONFIG,
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

const buildApiKeyFilterOptions = (rows: MonitoringEventRow[], allLabel: string) => [
  { value: 'all', label: allLabel },
  ...Array.from(
    new Map(
      rows
        .filter((row) => row.clientApiKey.hash && row.clientApiKey.hash !== '-')
        .map((row) => [row.clientApiKey.hash, row.clientApiKey.masked])
    ).entries()
  )
    .sort((left, right) => left[1].localeCompare(right[1]))
    .map(([value, label]) => ({ value, label })),
];

const formatStatusRate = (rate: number) => {
  const rounded = rate.toFixed(1);
  return `${rounded.endsWith('.0') ? rounded.slice(0, -2) : rounded}%`;
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

const buildAccountStatusRange = (rows: MonitoringEventRow[], range: MonitoringTimeRange, nowMs = Date.now()): AccountStatusRange => {
  if (range !== 'all') {
    return {
      startTime: getRangeStartMs(range, nowMs),
      endTime: nowMs,
    };
  }

  const minTimestamp = rows.reduce(
    (min, row) => Math.min(min, row.timestampMs),
    Number.POSITIVE_INFINITY
  );
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

type RealtimeLogRow = MonitoringEventRow & {
  requestCount: number;
  successRate: number;
  streamKey: string;
  recentPattern: boolean[];
  recentSuccessCount: number;
  recentFailureCount: number;
};

type UsageImportResult = {
  added?: number;
  skipped?: number;
  total?: number;
  failed?: number;
};


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

const getRankingMetricTotalFromRows = (rows: MonitoringEventRow[], metric: RankingMetric) => {
  if (metric === 'cost') return rows.reduce((sum, row) => sum + row.totalCost, 0);
  if (metric === 'tokens') return rows.reduce((sum, row) => sum + row.totalTokens, 0);
  return rows.reduce((sum, row) => sum + (row.statsIncluded ? 1 : 0), 0);
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
  if (quotaFileNames.length > 0) return joinShort(quotaFileNames, 1);

  const fileName = row.authLabels.find((label) => label && label !== '-' && label.endsWith('.json'));
  return fileName || row.authLabels.find((label) => label && label !== '-') || row.accountMasked || row.account;
};

const buildAccountCardProviderText = (row: MonitoringAccountRow) => {
  const providers = row.providers.filter((provider) => provider && provider !== '-');
  return providers.length > 0 ? joinShort(providers, 2) : '-';
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

type AccountSummaryMetric = {
  key: string;
  label: string;
  value: ReactNode;
  valueClassName?: string;
};

const formatPercent = (value: number) => `${(value * 100).toFixed(1)}%`;

const getRangeStartMs = (range: MonitoringTimeRange, nowMs: number) => {
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);

  switch (range) {
    case 'today':
      return start.getTime();
    case '7d':
      start.setDate(start.getDate() - 6);
      return start.getTime();
    case '14d':
      start.setDate(start.getDate() - 13);
      return start.getTime();
    case '30d':
      start.setDate(start.getDate() - 29);
      return start.getTime();
    case 'all':
    default:
      return Number.NEGATIVE_INFINITY;
  }
};

const filterRowsByRange = (rows: MonitoringEventRow[], range: MonitoringTimeRange) => {
  const nowMs = Date.now();
  const startMs = getRangeStartMs(range, nowMs);
  return rows.filter((row) => row.timestampMs >= startMs && row.timestampMs <= nowMs);
};

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

const formatLocalDayKey = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const formatHourLabel = (date: Date) => `${String(date.getHours()).padStart(2, '0')}:00`;

const formatDayLabel = (date: Date) => `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;

const formatShortDateTime = (date: Date) =>
  `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

const buildUsageTrendRangeLabel = (range: MonitoringTimeRange, t: TFunction) => {
  if (range === 'all') return t('monitoring.all_retained_logs');

  const now = new Date();
  const start = new Date(getRangeStartMs(range, now.getTime()));
  return `${formatShortDateTime(start)} - ${formatShortDateTime(now)}`;
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
      const dayKey = formatLocalDayKey(cursor);
      const label = formatHourLabel(cursor);
      buckets.push(getEmptyTrendPoint(`${dayKey} ${label}`, label));
      cursor.setHours(cursor.getHours() + 1);
    }
    return buckets;
  }

  cursor.setHours(0, 0, 0, 0);
  const end = new Date(nowMs);
  end.setHours(0, 0, 0, 0);
  while (cursor.getTime() <= end.getTime()) {
    const key = formatLocalDayKey(cursor);
    buckets.push(getEmptyTrendPoint(key, formatDayLabel(cursor)));
    cursor.setDate(cursor.getDate() + 1);
  }
  return buckets;
};

const buildTimeBucketMeta = (range: MonitoringTimeRange) => {
  const useHourly = range === 'today';
  return {
    useHourly,
    getKey: (row: MonitoringEventRow) => (useHourly ? `${row.dayKey} ${row.hourLabel}` : row.dayKey),
    getLabel: (row: MonitoringEventRow) => (useHourly ? row.hourLabel : row.dayKey.slice(5).replace('-', '/')),
  };
};

const roundCurrency = (value: number) => Math.round(value * 100) / 100;

const formatDeltaPercent = (current: number, previous: number) => {
  const roundedCurrent = roundCurrency(current);
  const roundedPrevious = roundCurrency(previous);
  if (roundedPrevious <= 0) return roundedCurrent > 0 ? '+100.0%' : '0.0%';
  const delta = (roundedCurrent - roundedPrevious) / roundedPrevious;
  return `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}%`;
};

const joinShort = (values: string[], limit = 2) => {
  if (values.length <= limit) {
    return values.join(', ');
  }
  return `${values.slice(0, limit).join(', ')} +${values.length - limit}`;
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

const buildTrendPoints = (rows: MonitoringEventRow[], range: MonitoringTimeRange = 'all'): TrendPoint[] => {
  const nowMs = Date.now();
  const prefilled = buildFilledTrendBuckets(range, nowMs);
  const grouped = new Map<string, TrendPoint>(prefilled.map((point) => [point.key, point]));
  const { getKey, getLabel } = buildTimeBucketMeta(range);

  rows.forEach((row) => {
    const key = getKey(row);
    const label = getLabel(row);
    const existing = grouped.get(key) ?? {
      key,
      label,
      requests: 0,
      failures: 0,
      tokens: 0,
      cost: 0,
    };

    existing.requests += row.statsIncluded ? 1 : 0;
    existing.failures += row.failed ? 1 : 0;
    existing.tokens += row.totalTokens;
    existing.cost += row.totalCost;
    grouped.set(key, existing);
  });

  return Array.from(grouped.values()).sort((left, right) => left.key.localeCompare(right.key)).slice(-24);
};

const buildTokenDistributionPoints = (rows: MonitoringEventRow[], range: MonitoringTimeRange = 'all'): TokenDistributionPoint[] => {
  const grouped = new Map<string, TokenDistributionPoint>();
  const { getKey, getLabel } = buildTimeBucketMeta(range);

  rows.forEach((row) => {
    const key = getKey(row);
    const label = getLabel(row);
    const existing = grouped.get(key) ?? {
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

    existing.requests += row.statsIncluded ? 1 : 0;
    existing.totalTokens += row.totalTokens;
    existing.inputTokens += row.inputTokens;
    existing.outputTokens += row.outputTokens;
    existing.reasoningTokens += row.reasoningTokens;
    existing.cachedTokens += row.cachedTokens;
    existing.totalCost += row.totalCost;
    grouped.set(key, existing);
  });

  return Array.from(grouped.values()).sort((left, right) => left.key.localeCompare(right.key)).slice(-24);
};

const buildRealtimeMetaText = (row: MonitoringEventRow) => {
  const text = `${row.endpointMethod} ${row.endpointPath}`.trim();
  return maskSensitiveText(text || '-');
};

const QUOTA_CONFIGS: AnyQuotaConfig[] = [
  ANTIGRAVITY_CONFIG,
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  GEMINI_CLI_CONFIG,
  KIMI_CONFIG,
] as AnyQuotaConfig[];

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

const resolveQuotaErrorMessage = (t: TFunction, quota?: QuotaStatusState): string => {
  if (!quota) return t('common.unknown_error');
  if (quota.errorStatus === 404) return t('common.quota_update_required');
  if (quota.errorStatus === 403) return t('common.quota_check_credential');
  return quota.error || t('common.unknown_error');
};

const hasUsableQuotaContent = (quota?: QuotaStatusState) => {
  if (!quota || quota.status !== 'success') return false;
  const record = quota as unknown as Record<string, unknown>;
  return ['groups', 'windows', 'buckets', 'rows'].some((key) => {
    const value = record[key];
    return Array.isArray(value) && value.length > 0;
  }) || Boolean(record.planType || record.tierLabel || record.creditBalance !== undefined);
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

const buildAccountQuotaTargetsByAccount = (
  rows: MonitoringEventRow[],
  authFilesByAuthIndex: Map<string, AuthFileItem>
) => {
  const grouped = new Map<string, Map<string, AccountQuotaTarget>>();

  rows.forEach((row) => {
    const authIndex = normalizeAuthIndex(row.authIndex);
    if (!authIndex || !row.account) return;

    const file = authFilesByAuthIndex.get(authIndex);
    if (!file) return;

    const quotaConfig = QUOTA_CONFIGS.find((item) => item.filterFn(file));
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

const buildRealtimeLogRows = (rows: MonitoringEventRow[]): RealtimeLogRow[] => {
  const sortedAsc = [...rows].sort(
    (left, right) => left.timestampMs - right.timestampMs || left.id.localeCompare(right.id)
  );
  const metricsByStream = new Map<string, { total: number; success: number; pattern: boolean[] }>();

  const enriched = sortedAsc.map((row) => {
    const streamKey = [row.account, row.provider, row.model, row.channel].join('::');
    const previous = metricsByStream.get(streamKey) ?? { total: 0, success: 0, pattern: [] };
    const nextPattern = [...previous.pattern, !row.failed].slice(-10);
    const next = {
      total: previous.total + (row.statsIncluded ? 1 : 0),
      success: previous.success + (row.statsIncluded && !row.failed ? 1 : 0),
      pattern: nextPattern,
    };
    metricsByStream.set(streamKey, next);

    return {
      ...row,
      streamKey,
      requestCount: next.total,
      successRate: next.total > 0 ? next.success / next.total : 1,
      recentPattern: nextPattern,
      recentSuccessCount: nextPattern.filter(Boolean).length,
      recentFailureCount: nextPattern.filter((item) => !item).length,
    } satisfies RealtimeLogRow;
  });

  return enriched.sort(
    (left, right) =>
      right.timestampMs - left.timestampMs ||
      right.requestCount - left.requestCount ||
      right.id.localeCompare(left.id)
  );
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
  const quotaTitle = quotaEntries.length === 1 ? quotaEntries[0].providerLabel : quotaEntries.length > 1 ? t('quota_management.title') : t('codex_quota.title');

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
  const visibleRows = filteredRows.slice(safePageIndex * itemsPerPage, (safePageIndex + 1) * itemsPerPage);

  const accountStatusRange = useMemo(
    () => buildAccountStatusRange(rows.flatMap((row) => row.rows), range),
    [rows, range]
  );

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
                const statusData = buildAccountStatusData(row.rows, accountStatusRange);
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
              <div className={styles.accountCardPagination}>
                <button
                  type="button"
                  className={styles.accountCardPageButton}
                  disabled={safePageIndex === 0}
                  onClick={() => setCardPage((p) => Math.max(0, p - 1))}
                  aria-label={t('monitoring.previous_page')}
                >
                  ‹
                </button>
                <span className={styles.accountCardPageInfo}>
                  {safePageIndex + 1} / {totalPages}
                </span>
                <button
                  type="button"
                  className={styles.accountCardPageButton}
                  disabled={safePageIndex >= totalPages - 1}
                  onClick={() => setCardPage((p) => Math.min(totalPages - 1, p + 1))}
                  aria-label={t('monitoring.next_page')}
                >
                  ›
                </button>
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
  const [isPriceModalOpen, setIsPriceModalOpen] = useState(false);
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
  const accountQuotaStatesRef = useRef<Record<string, AccountQuotaState>>({});
  const accountQuotaRequestIdsRef = useRef<Record<string, number>>({});
  const deferredSearch = useDeferredValue(searchInput);

  const {
    usage,
    loading: usageLoading,
    error: usageError,
    modelPrices,
    setModelPrices,
    refreshUsage,
  } = useUsageData();

  const {
    loading: monitoringLoading,
    error: monitoringError,
    authFiles,
    allRows,
    filteredRows,
    refreshMeta,
  } = useMonitoringData({
    usage,
    config,
    modelPrices,
    timeRange,
    searchQuery: deferredSearch,
  });

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshUsage(), refreshMeta(false)]);
  }, [refreshUsage, refreshMeta]);

  const refreshUsageOnly = useCallback(async () => {
    await refreshUsage();
  }, [refreshUsage]);

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
        showNotification(
          t('usage_stats.import_success', {
            added: result.added ?? 0,
            skipped: result.skipped ?? 0,
            total: result.total ?? 0,
            failed: result.failed ?? 0,
          }),
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

  useHeaderRefresh(refreshAll);
  useInterval(
    () => {
      void refreshUsageOnly().catch(() => {});
    },
    connectionStatus === 'connected' ? 5000 : null
  );

  const overallLoading = usageLoading || monitoringLoading;
  const combinedError = [usageError, monitoringError].filter(Boolean).join('；');
  const hasPrices = Object.keys(modelPrices).length > 0;

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

  const providerOptions = useMemo(
    () => [
      { value: 'all', label: t('monitoring.filter_all_providers') },
      ...Array.from(new Set(filteredRows.map((row) => row.provider)))
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right))
        .map((value) => ({ value, label: value })),
    ],
    [filteredRows, t]
  );

  const modelOptions = useMemo(
    () => [
      { value: 'all', label: t('monitoring.filter_all_models') },
      ...Array.from(new Set(filteredRows.map((row) => row.model)))
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right))
        .map((value) => ({ value, label: value })),
    ],
    [filteredRows, t]
  );

  const apiKeyOptions = useMemo(() => buildApiKeyFilterOptions(filteredRows, t('monitoring.filter_all_api_keys')), [filteredRows, t]);

  const statusOptions = useMemo(
    () => [
      { value: 'all', label: t('monitoring.filter_all_statuses') },
      { value: 'success', label: t('monitoring.filter_status_success') },
      { value: 'failed', label: t('monitoring.filter_status_failed') },
    ],
    [t]
  );

  const priceModelOptions = useMemo(
    () => [
      { value: '', label: t('usage_stats.model_price_select_placeholder') },
      ...Array.from(new Set([...filteredRows.map((row) => row.model), ...Object.keys(modelPrices)]))
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right))
        .map((value) => ({ value, label: value })),
    ],
    [filteredRows, modelPrices, t]
  );

  const authFilesByAuthIndex = useMemo(() => {
    const map = new Map<string, AuthFileItem>();
    authFiles.forEach((file) => {
      const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
      if (!authIndex || map.has(authIndex)) return;
      map.set(authIndex, file);
    });
    return map;
  }, [authFiles]);

  const scopedRows = useMemo(
    () =>
      filteredRows.filter((row) => {
        if (selectedProvider !== 'all' && row.provider !== selectedProvider) {
          return false;
        }
        if (selectedModel !== 'all' && row.model !== selectedModel) {
          return false;
        }
        if (selectedApiKey !== 'all' && row.clientApiKey.hash !== selectedApiKey) {
          return false;
        }
        if (selectedStatus === 'success' && row.failed) {
          return false;
        }
        if (selectedStatus === 'failed' && !row.failed) {
          return false;
        }
        return true;
      }),
    [filteredRows, selectedApiKey, selectedModel, selectedProvider, selectedStatus]
  );

  const topStatsRows = useMemo(() => allRows.filter((row) => row.statsIncluded), [allRows]);
  const todayStatsRows = useMemo(
    () => filterRowsByRange(topStatsRows, 'today'),
    [topStatsRows]
  );
  const trendStatsRows = useMemo(
    () => filterRowsByRange(topStatsRows, timeRange),
    [topStatsRows, timeRange]
  );
  const todayCost = useMemo(() => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const tomorrowStart = new Date(todayStart);
    tomorrowStart.setDate(tomorrowStart.getDate() + 1);
    return topStatsRows.reduce(
      (sum, row) => sum + (row.timestampMs >= todayStart.getTime() && row.timestampMs < tomorrowStart.getTime() ? row.totalCost : 0),
      0
    );
  }, [topStatsRows]);
  const yesterdayCost = useMemo(() => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    return topStatsRows.reduce(
      (sum, row) => sum + (row.timestampMs >= yesterdayStart.getTime() && row.timestampMs < todayStart.getTime() ? row.totalCost : 0),
      0
    );
  }, [topStatsRows]);
  const usageTrendApiKeyOptions = useMemo(() => buildApiKeyFilterOptions(trendStatsRows, t('monitoring.filter_all_api_keys')), [trendStatsRows, t]);
  const usageTrendScopedRows = useMemo(
    () => usageTrendApiKey === 'all'
      ? trendStatsRows
      : trendStatsRows.filter((row) => row.clientApiKey.hash === usageTrendApiKey),
    [usageTrendApiKey, trendStatsRows]
  );
  const usageTrendPoints = useMemo(() => buildTrendPoints(usageTrendScopedRows, timeRange), [usageTrendScopedRows, timeRange]);
  const tokenDistributionPoints = useMemo(() => buildTokenDistributionPoints(usageTrendScopedRows, timeRange), [usageTrendScopedRows, timeRange]);
  useEffect(() => {
    if (usageTrendApiKey !== 'all' && !usageTrendApiKeyOptions.some((option) => option.value === usageTrendApiKey)) {
      setUsageTrendApiKey('all');
    }
  }, [usageTrendApiKey, usageTrendApiKeyOptions]);

  const trendSummary = useMemo(() => buildMonitoringSummary(trendStatsRows), [trendStatsRows]);
  const topSummary = useMemo(() => buildMonitoringSummary(topStatsRows), [topStatsRows]);
  const todaySummary = useMemo(() => buildMonitoringSummary(todayStatsRows), [todayStatsRows]);
  const modelRankingRows = useMemo(
    () => [...buildAccountRows(usageTrendScopedRows, 'model')]
      .sort((left, right) => (
        getRankingMetricValue(right, modelRankingMetric) - getRankingMetricValue(left, modelRankingMetric)
        || right.totalTokens - left.totalTokens
        || right.totalCalls - left.totalCalls
      )),
    [modelRankingMetric, usageTrendScopedRows]
  );
  const modelRankingMetricTotal = useMemo(
    () => getRankingMetricTotalFromRows(usageTrendScopedRows, modelRankingMetric),
    [modelRankingMetric, usageTrendScopedRows]
  );
  const apiKeyRankingRows = useMemo(
    () => [...buildAccountRows(trendStatsRows, 'apiKey')]
      .sort((left, right) => (
        getRankingMetricValue(right, apiKeyRankingMetric) - getRankingMetricValue(left, apiKeyRankingMetric)
        || right.totalCalls - left.totalCalls
        || right.totalCost - left.totalCost
      ))
      .slice(0, 8),
    [apiKeyRankingMetric, trendStatsRows]
  );
  const apiKeyRankingMetricTotal = useMemo(
    () => getRankingMetricTotalFromRows(trendStatsRows, apiKeyRankingMetric),
    [apiKeyRankingMetric, trendStatsRows]
  );
  const accountStatsFilteredRows = useMemo(
    () => filterRowsByRange(topStatsRows, timeRange),
    [topStatsRows, timeRange]
  );
  const accountStatsRows = useMemo(
    () => [...buildAccountRows(accountStatsFilteredRows, 'account')]
      .sort((left, right) => (
        getAccountSortValue(right, accountStatsMetric) - getAccountSortValue(left, accountStatsMetric)
        || right.lastSeenAt - left.lastSeenAt
        || right.totalCalls - left.totalCalls
      )),
    [accountStatsMetric, accountStatsFilteredRows]
  );
  const timeRangeLabel = useMemo(() => buildUsageTrendRangeLabel(timeRange, t), [timeRange, t]);
  const realtimeLogRows = useMemo(() => buildRealtimeLogRows(scopedRows), [scopedRows]);

  const accountQuotaTargetsByAccount = useMemo(
    () => buildAccountQuotaTargetsByAccount(accountStatsFilteredRows, authFilesByAuthIndex),
    [authFilesByAuthIndex, accountStatsFilteredRows]
  );
  const accountQuotaEntriesByAccount = useMemo(
    () => buildAccountQuotaEntriesByAccount(accountQuotaTargetsByAccount, quotaStore, t),
    [accountQuotaTargetsByAccount, quotaStore, t]
  );
  const quotaTargetsByAccountForLoading = accountQuotaTargetsByAccount;

  const activeScopeRows = scopedRows;
  const scopedFailureCount = activeScopeRows.filter((row) => row.failed).length;
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
      value: formatCompactNumber(todaySummary.totalCalls),
      accent: 'blue',
      footer: [
        { label: t('monitoring.total_requests_label'), value: formatCompactNumber(topSummary.totalCalls) },
        { label: t('monitoring.total_success_rate'), value: formatPercent(topSummary.successRate) },
      ],
    },
    {
      key: 'tokens',
      title: 'Token',
      label: t('monitoring.today_tokens'),
      value: formatCompactNumber(todaySummary.totalTokens),
      accent: 'purple',
      footer: [
        { label: t('monitoring.total_tokens_label'), value: formatCompactNumber(topSummary.totalTokens) },
        { label: t('monitoring.input_output_reasoning'), value: `${formatCompactNumber(topSummary.inputTokens)} / ${formatCompactNumber(topSummary.outputTokens)} / ${formatCompactNumber(topSummary.reasoningTokens)}` },
      ],
    },
    {
      key: 'cache',
      title: t('monitoring.cache_title'),
      label: t('monitoring.today_cache_hit_rate'),
      value: formatPercent(todaySummary.inputTokens > 0 ? todaySummary.cachedTokens / todaySummary.inputTokens : 0),
      accent: 'green',
      footer: [
        { label: t('monitoring.today_cached_tokens'), value: formatCompactNumber(todaySummary.cachedTokens) },
        { label: t('monitoring.total_cache_hits'), value: `${formatCompactNumber(topSummary.cachedTokens)} / ${formatPercent(topSummary.inputTokens > 0 ? topSummary.cachedTokens / topSummary.inputTokens : 0)}` },
      ],
    },
    {
      key: 'billing',
      title: t('monitoring.billing_title'),
      label: t('monitoring.today_cost'),
      value: hasPrices ? formatUsd(todayCost) : '--',
      accent: 'amber',
      footer: [
        { label: t('monitoring.vs_yesterday'), value: hasPrices ? formatDeltaPercent(todayCost, yesterdayCost) : '--' },
        { label: t('monitoring.total_cost_label'), value: hasPrices ? formatUsd(topSummary.totalCost) : '--' },
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

      const settled = await Promise.allSettled(targets.map((target) => requestAccountQuota(target, t)));
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
      {overallLoading && !usage ? (
        <div className={styles.loadingOverlay} aria-busy="true">
          <div className={styles.loadingOverlayContent}>
            <LoadingSpinner size={28} />
            <span>{t('common.loading')}</span>
          </div>
        </div>
      ) : null}

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
            totalCalls={trendSummary.totalCalls}
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
                ? t('monitoring.active_filters_hint', { count: selectedFiltersCount, rows: activeScopeRows.length })
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
        </div>

        {combinedError ? <div className={styles.errorBox}>{combinedError}</div> : null}

        <div className={styles.inlineMetrics}>
          <span>{`${t('monitoring.log_rows')}: ${realtimeLogRows.length}`}</span>
          <span>{`${t('monitoring.recent_failures')}: ${scopedFailureCount}`}</span>
        </div>

        <div className={`${styles.tableWrapper} ${styles.tableScrollWrapper} ${styles.realtimeTableWrapper}`}>
          <table className={`${styles.table} ${styles.realtimeTable}`}>
            <thead>
              <tr>
                <th>{t('monitoring.column_type')}</th>
                <th>{t('monitoring.column_model')}</th>
                <th>{t('monitoring.api_key_label')}</th>
                <th>{t('monitoring.recent_status')}</th>
                <th>{t('monitoring.request_status')}</th>
                <th>{t('monitoring.column_success_rate')}</th>
                <th>{t('monitoring.total_calls')}</th>
                <th>{t('monitoring.column_latency')}</th>
                <th>{t('monitoring.column_time')}</th>
                <th>{t('monitoring.this_call_usage')}</th>
                <th>{t('monitoring.this_call_cost')}</th>
              </tr>
            </thead>
            <tbody>
              {realtimeLogRows.slice(0, 150).map((row) => (
                <tr key={row.id} className={row.failed ? styles.logRowFailed : undefined}>
                  <td>
                    <div className={styles.primaryCell}>
                      <span>{row.provider}</span>
                      <small>{row.account || row.authLabel || row.accountMasked || '-'}</small>
                    </div>
                  </td>
                  <td>
                    <div className={styles.primaryCell}>
                      <span className={styles.monoCell}>{row.model}</span>
                      <small className={styles.monoCell}>{buildRealtimeMetaText(row)}</small>
                    </div>
                  </td>
                  <td>
                    <span className={styles.monoCell}>{row.clientApiKey.masked}</span>
                  </td>
                  <td>
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
                  </td>
                  <td>
                    <StatusBadge tone={row.failed ? 'bad' : 'good'}>
                      {row.failed ? t('monitoring.result_failed') : t('monitoring.result_success')}
                    </StatusBadge>
                  </td>
                  <td
                    className={
                      row.successRate >= 0.95
                        ? styles.goodText
                        : row.successRate >= 0.85
                          ? styles.warnText
                          : styles.badText
                    }
                  >
                    {formatPercent(row.successRate)}
                  </td>
                  <td>{formatCompactNumber(row.requestCount)}</td>
                  <td>
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
                  </td>
                  <td>{new Date(row.timestampMs).toLocaleString(i18n.language)}</td>
                  <td>
                    <div className={styles.primaryCell}>
                      <span>{formatCompactNumber(row.totalTokens)}</span>
                      <small>{`I ${formatCompactNumber(row.inputTokens)} · O ${formatCompactNumber(row.outputTokens)} · C ${formatCompactNumber(row.cachedTokens)}`}</small>
                    </div>
                  </td>
                  <td>{hasPrices ? formatUsd(row.totalCost) : '--'}</td>
                </tr>
              ))}
              {realtimeLogRows.length === 0 ? (
                <tr>
                  <td colSpan={11}>
                    <div className={styles.emptyTable}>
                      {deferredSearch.trim() ? t('monitoring.no_filtered_data') : t('monitoring.no_data')}
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        </Card>
      </section>

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
