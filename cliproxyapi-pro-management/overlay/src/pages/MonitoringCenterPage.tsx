import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode } from 'react';
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
  IconTimer,
} from '@/components/ui/icons';
import {
  buildAccountRows,
  buildMonitoringSummary,
  useMonitoringData,
  type MonitoringAccountGroupBy,
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

const AUTO_REFRESH_OPTIONS = [
  { value: '0', labelKey: 'monitoring.auto_refresh_off' },
  { value: '5000', labelKey: 'monitoring.auto_refresh_5s' },
  { value: '10000', labelKey: 'monitoring.auto_refresh_10s' },
  { value: '30000', labelKey: 'monitoring.auto_refresh_30s' },
  { value: '60000', labelKey: 'monitoring.auto_refresh_60s' },
  { value: '300000', labelKey: 'monitoring.auto_refresh_5m' },
];

const ACCOUNT_GROUP_OPTIONS: Array<{ value: MonitoringAccountGroupBy; labelKey: string }> = [
  { value: 'account', labelKey: 'monitoring.group_by_account' },
  { value: 'apiKey', labelKey: 'monitoring.group_by_api_key' },
  { value: 'model', labelKey: 'monitoring.group_by_model' },
];

const ANALYSIS_TAB_OPTIONS: Array<{ value: AnalysisTab; labelKey: string }> = [
  { value: 'trend', labelKey: 'monitoring.analysis_tab_trend' },
  { value: 'failures', labelKey: 'monitoring.analysis_tab_failures' },
  { value: 'cost', labelKey: 'monitoring.analysis_tab_cost' },
  { value: 'logs', labelKey: 'monitoring.analysis_tab_logs' },
];

type StatusFilter = 'all' | 'success' | 'failed';

type PanelProps = {
  title: string;
  subtitle?: string;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
};

type SummaryCardProps = {
  label: string;
  value: ReactNode;
  meta: string;
  tone?: MonitoringStatusTone;
};

type FocusScope = {
  type: MonitoringAccountGroupBy;
  value: string;
};

type AnalysisTab = 'trend' | 'failures' | 'cost' | 'logs';

type TrendPoint = {
  key: string;
  label: string;
  requests: number;
  failures: number;
  tokens: number;
  cost: number;
};

type FailureAnalysisRow = {
  key: string;
  label: string;
  meta: string;
  failures: number;
  totalCalls: number;
  failureRate: number;
  lastSeenAt: number;
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

const buildAccountSecondaryText = (row: MonitoringAccountRow) => {
  if (row.group === 'apiKey') {
    const accounts = row.authLabels.filter((label) => label && label !== row.account);
    return accounts.length > 0 ? joinShort(accounts, 2) : joinShort(row.authIndices, 2);
  }
  if (row.group === 'model') {
    const accounts = row.authLabels.filter(Boolean);
    return accounts.length > 0 ? joinShort(accounts, 2) : joinShort(row.channels, 2);
  }

  const extraAuthLabels = row.authLabels.filter((label) => label && label !== row.account);
  if (extraAuthLabels.length > 0) {
    return joinShort(extraAuthLabels, 2);
  }
  if (row.channels.length > 0) {
    return joinShort(row.channels, 2);
  }
  return '';
};

const getGroupDimensionLabel = (groupBy: MonitoringAccountGroupBy, t: TFunction) => {
  if (groupBy === 'apiKey') return t('monitoring.api_key_label');
  if (groupBy === 'model') return t('monitoring.model_label');
  return t('monitoring.account_label');
};

const getFocusActionLabel = (row: MonitoringAccountRow, t: TFunction) => {
  if (row.group === 'apiKey') return t('monitoring.focus_api_key');
  if (row.group === 'model') return t('monitoring.focus_model');
  return t('monitoring.focus_account');
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

const getAccountSortValue = (row: MonitoringAccountRow, key: AccountSortKey) => {
  switch (key) {
    case 'totalCalls':
      return row.totalCalls;
    case 'successCalls':
      return row.successCalls;
    case 'successRate':
      return row.successRate;
    case 'totalTokens':
      return row.totalTokens;
    case 'inputTokens':
      return row.inputTokens;
    case 'outputTokens':
      return row.outputTokens;
    case 'cachedTokens':
      return row.cachedTokens;
    case 'totalCost':
      return row.totalCost;
    case 'lastSeenAt':
    default:
      return row.lastSeenAt;
  }
};

const compareAccountRowsByDefault = (left: MonitoringAccountRow, right: MonitoringAccountRow) =>
  right.lastSeenAt - left.lastSeenAt ||
  right.totalCalls - left.totalCalls ||
  right.totalCost - left.totalCost ||
  left.account.localeCompare(right.account);

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

type AccountSortKey =
  | 'totalCalls'
  | 'successCalls'
  | 'failureCalls'
  | 'successRate'
  | 'totalTokens'
  | 'inputTokens'
  | 'outputTokens'
  | 'cachedTokens'
  | 'totalCost'
  | 'lastSeenAt';

type AccountSortDirection = 'asc' | 'desc';

type AccountSortState = {
  key: AccountSortKey;
  direction: AccountSortDirection;
};

type AccountOverviewColumn = {
  key: string;
  label: string;
  sortKey?: AccountSortKey;
};

type AccountSummaryMetric = {
  key: string;
  label: string;
  value: ReactNode;
  valueClassName?: string;
};

const getDefaultAccountSort = (groupBy: MonitoringAccountGroupBy): AccountSortState => ({
  key: groupBy === 'account' ? 'lastSeenAt' : groupBy === 'apiKey' ? 'totalCalls' : 'totalCost',
  direction: 'desc',
});


const formatPercent = (value: number) => `${(value * 100).toFixed(1)}%`;

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

const buildTrendPoints = (rows: MonitoringEventRow[]): TrendPoint[] => {
  const grouped = new Map<string, TrendPoint>();
  const useHourly = new Set(rows.map((row) => row.dayKey)).size <= 1;

  rows.forEach((row) => {
    const key = useHourly ? `${row.dayKey} ${row.hourLabel}` : row.dayKey;
    const label = useHourly ? row.hourLabel : row.dayKey.slice(5).replace('-', '/');
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

const buildFailureAnalysisRows = (rows: MonitoringEventRow[]): FailureAnalysisRow[] => {
  const grouped = new Map<string, FailureAnalysisRow>();

  rows.forEach((row) => {
    const key = `${row.provider}::${row.channel}::${row.model}`;
    const existing = grouped.get(key) ?? {
      key,
      label: row.model,
      meta: [row.provider, row.channel].filter(Boolean).join(' · '),
      failures: 0,
      totalCalls: 0,
      failureRate: 0,
      lastSeenAt: 0,
    };

    existing.totalCalls += row.statsIncluded ? 1 : 0;
    existing.failures += row.failed ? 1 : 0;
    existing.lastSeenAt = Math.max(existing.lastSeenAt, row.timestampMs);
    grouped.set(key, existing);
  });

  return Array.from(grouped.values())
    .map((row) => ({
      ...row,
      failureRate: row.totalCalls > 0 ? row.failures / row.totalCalls : 0,
    }))
    .filter((row) => row.failures > 0)
    .sort((left, right) => right.failures - left.failures || right.failureRate - left.failureRate || right.lastSeenAt - left.lastSeenAt)
    .slice(0, 10);
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
    } satisfies RealtimeLogRow;
  });

  return enriched.sort(
    (left, right) =>
      right.timestampMs - left.timestampMs ||
      right.requestCount - left.requestCount ||
      right.id.localeCompare(left.id)
  );
};

function RankingPanel({
  title,
  subtitle,
  rows,
  maxCalls,
  emptyText,
  hasPrices,
}: {
  title: string;
  subtitle: string;
  rows: MonitoringAccountRow[];
  maxCalls: number;
  emptyText: string;
  hasPrices: boolean;
}) {
  return (
    <Card className={styles.rankingCard}>
      <div className={styles.rankingHeader}>
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
      </div>
      <div className={styles.rankingList}>
        {rows.map((row, index) => (
          <div key={row.id} className={styles.rankingRow}>
            <span className={styles.rankingIndex}>{index + 1}</span>
            <div className={styles.rankingMain}>
              <div className={styles.rankingTitleLine}>
                <strong>{row.account}</strong>
                <span>{formatCompactNumber(row.totalCalls)}</span>
              </div>
              <div className={styles.rankingMetaLine}>
                <span>{formatPercent(row.successRate)}</span>
                <span>{formatCompactNumber(row.totalTokens)}</span>
                <span>{hasPrices ? formatUsd(row.totalCost) : '--'}</span>
              </div>
              <span
                className={styles.rankingBar}
                style={{ '--ranking-width': `${Math.max((row.totalCalls / maxCalls) * 100, 4)}%` } as CSSProperties}
                aria-hidden="true"
              />
            </div>
          </div>
        ))}
        {rows.length === 0 ? <div className={styles.emptyBlockSmall}>{emptyText}</div> : null}
      </div>
    </Card>
  );
}

function Panel({ title, subtitle, extra, children, className }: PanelProps) {
  return (
    <Card className={[styles.panel, className].filter(Boolean).join(' ')}>
      <div className={styles.panelHeader}>
        <div>
          <h2 className={styles.panelTitle}>{title}</h2>
          {subtitle ? <p className={styles.panelSubtitle}>{subtitle}</p> : null}
        </div>
        {extra ? <div className={styles.panelExtra}>{extra}</div> : null}
      </div>
      {children}
    </Card>
  );
}

function SummaryCard({ label, value, meta, tone }: SummaryCardProps) {
  return (
    <Card className={styles.summaryCard}>
      <span className={styles.summaryLabel}>{label}</span>
      <strong className={`${styles.summaryValue} ${tone ? styles[`tone${tone}`] : ''}`}>{value}</strong>
      <span className={styles.summaryMeta}>{meta}</span>
    </Card>
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
          key={`${index}-${item ? 'success' : 'failed'}`}
          className={`${barClassName} ${item ? styles.patternSuccess : styles.patternFailed}`}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}

function AccountSummaryPrimary({
  row,
  expanded,
  onToggle,
}: {
  row: MonitoringAccountRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const secondaryText = buildAccountSecondaryText(row);

  return (
    <button
      type="button"
      className={[styles.accountButton, expanded ? styles.expandedAccountButton : ''].filter(Boolean).join(' ')}
      onClick={onToggle}
      aria-expanded={expanded}
    >
      {expanded ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
      <span className={styles.accountButtonLabel}>{row.account}</span>
      {secondaryText ? <small>{secondaryText}</small> : null}
    </button>
  );
}

function ModelSpendTable({
  row,
  hasPrices,
  locale,
  t,
  showQuota,
  quotaState,
  quotaEntries,
  onRefreshQuota,
}: {
  row: MonitoringAccountRow;
  hasPrices: boolean;
  locale: string;
  t: TFunction;
  showQuota: boolean;
  quotaState?: AccountQuotaState;
  quotaEntries: AccountQuotaEntry[];
  onRefreshQuota: () => void;
}) {
  const quotaLoading = quotaState?.status === 'loading';
  const lastQuotaSync =
    quotaState?.lastRefreshedAt && Number.isFinite(quotaState.lastRefreshedAt)
      ? new Date(quotaState.lastRefreshedAt).toLocaleString(locale)
      : '';

  const quotaTitle =
    quotaEntries.length === 1
      ? quotaEntries[0].providerLabel
      : quotaEntries.length > 1
        ? t('quota_management.title')
        : '';

  const renderRefreshButton = () => (
    <button
      type="button"
      className={styles.quotaRefreshButton}
      onClick={onRefreshQuota}
      disabled={quotaLoading}
    >
      <IconRefreshCw
        size={14}
        className={quotaLoading ? styles.refreshIconSpinning : styles.refreshIcon}
      />
      <span>{t('codex_quota.refresh_button')}</span>
    </button>
  );

  return (
    <div className={styles.expandPanel}>
      {showQuota ? (
        <section className={styles.quotaSection}>
        {quotaLoading && quotaEntries.length === 0 ? (
          <div className={styles.quotaStateMessage}>{t('codex_quota.loading')}</div>
        ) : null}

        {!quotaLoading && quotaState?.status === 'error' && quotaEntries.length === 0 ? (
          <div className={styles.quotaStateMessage}>
            {t('codex_quota.load_failed', { message: quotaState.error || t('common.unknown_error') })}
          </div>
        ) : null}

        {!quotaLoading && quotaState?.status === 'success' && quotaEntries.length === 0 ? (
          <div className={styles.quotaStateMessage}>{t('monitoring.account_quota_empty')}</div>
        ) : null}

        {quotaEntries.length > 0 ? (
          <>
            <div className={styles.quotaSectionHeader}>
              <div className={styles.quotaSectionTitleGroup}>
                <strong>{quotaTitle}</strong>
                {lastQuotaSync ? <span>{`${t('monitoring.last_sync')}: ${lastQuotaSync}`}</span> : null}
              </div>
              {renderRefreshButton()}
            </div>
            <div className={styles.quotaEntryGrid}>
              {quotaEntries.map((entry) => (
                <div key={entry.key} className={styles.quotaEntryCard}>
                  <div className={styles.quotaEntryHeader}>
                    <div className={styles.quotaEntryMain}>
                      <strong>{entry.authLabel}</strong>
                      <small>{`${entry.providerLabel} · ${entry.fileName}`}</small>
                    </div>
                  </div>

                  {entry.quota?.status === 'loading' ? (
                    <div className={styles.quotaStateMessage}>{t(`${entry.config.i18nPrefix}.loading`)}</div>
                  ) : entry.quota?.status === 'error' ? (
                    <div className={styles.quotaStateMessage}>
                      {t(`${entry.config.i18nPrefix}.load_failed`, {
                        message: resolveQuotaErrorMessage(t, entry.quota),
                      })}
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
          </>
        ) : null}
        </section>
      ) : null}

      <div className={styles.tableWrapper}>
        <table className={`${styles.table} ${styles.innerTable}`}>
          <thead>
            <tr>
              <th>{t('usage_stats.model_price_model')}</th>
              <th>{t('monitoring.calls')}</th>
              <th>{t('monitoring.column_success_rate')}</th>
              <th>{t('monitoring.input_tokens')}</th>
              <th>{t('monitoring.output_tokens')}</th>
              <th>{t('monitoring.cached_tokens')}</th>
              <th>{t('monitoring.total_tokens')}</th>
              <th>{t('monitoring.estimated_cost')}</th>
              <th>{t('monitoring.latest_request_time')}</th>
            </tr>
          </thead>
          <tbody>
            {row.models.map((model) => (
              <tr key={`${row.id}-${model.model}`}>
                <td className={styles.monoCell}>{model.model}</td>
                <td>{formatCompactNumber(model.totalCalls)}</td>
                <td
                  className={
                    model.successRate >= 0.95
                      ? styles.goodText
                      : model.successRate >= 0.85
                        ? styles.warnText
                        : styles.badText
                  }
                >
                  {formatPercent(model.successRate)}
                </td>
                <td>{formatCompactNumber(model.inputTokens)}</td>
                <td>{formatCompactNumber(model.outputTokens)}</td>
                <td>{formatCompactNumber(model.cachedTokens)}</td>
                <td>{formatCompactNumber(model.totalTokens)}</td>
                <td>{hasPrices ? formatUsd(model.totalCost) : '--'}</td>
                <td>{new Date(model.lastSeenAt).toLocaleString(locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ExpandedAccountCard({
  row,
  hasPrices,
  locale,
  t,
  summaryMetrics,
  isFocused,
  quotaState,
  quotaEntries,
  onToggle,
  onFocus,
  onRefreshQuota,
}: {
  row: MonitoringAccountRow;
  hasPrices: boolean;
  locale: string;
  t: TFunction;
  summaryMetrics: AccountSummaryMetric[];
  isFocused: boolean;
  quotaState?: AccountQuotaState;
  quotaEntries: AccountQuotaEntry[];
  onToggle: () => void;
  onFocus: () => void;
  onRefreshQuota: () => void;
}) {
  return (
    <div className={styles.expandedAccountCard}>
      <div className={styles.expandedAccountSummary}>
        <div className={styles.expandedAccountPrimary}>
          <AccountSummaryPrimary row={row} expanded onToggle={onToggle} />
        </div>
        {summaryMetrics.map((metric) => (
          <div key={metric.key} className={styles.expandedAccountMetricValue}>
            <strong className={metric.valueClassName}>{metric.value}</strong>
          </div>
        ))}
        <div className={styles.expandedAccountAction}>
          <button type="button" className={styles.inlineActionButton} onClick={onFocus}>
            {isFocused ? t('monitoring.restore_account_scope') : getFocusActionLabel(row, t)}
          </button>
        </div>
      </div>

      <div className={styles.expandedAccountBody}>
        <ModelSpendTable
          row={row}
          hasPrices={hasPrices}
          locale={locale}
          t={t}
          showQuota={row.group === 'account'}
          quotaState={quotaState}
          quotaEntries={quotaEntries}
          onRefreshQuota={onRefreshQuota}
        />
      </div>
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
  const [autoRefreshMs, setAutoRefreshMs] = useState('5000');
  const [selectedAccount, setSelectedAccount] = useState('all');
  const [selectedProvider, setSelectedProvider] = useState('all');
  const [selectedModel, setSelectedModel] = useState('all');
  const [selectedChannel, setSelectedChannel] = useState('all');
  const [selectedStatus, setSelectedStatus] = useState<StatusFilter>('all');
  const [accountGroupBy, setAccountGroupBy] = useState<MonitoringAccountGroupBy>('account');
  const [expandedAccounts, setExpandedAccounts] = useState<Record<string, boolean>>({});
  const [focusScope, setFocusScope] = useState<FocusScope | null>(null);
  const [isPriceModalOpen, setIsPriceModalOpen] = useState(false);
  const [priceModel, setPriceModel] = useState('');
  const [priceDraft, setPriceDraft] = useState<PriceDraft>(() => createPriceDraft());
  const [isImportingUsage, setIsImportingUsage] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [accountQuotaStates, setAccountQuotaStates] = useState<Record<string, AccountQuotaState>>({});
  const [accountSort, setAccountSort] = useState<AccountSortState>(() => getDefaultAccountSort('account'));
  const [activeAnalysisTab, setActiveAnalysisTab] = useState<AnalysisTab>('trend');
  const accountQuotaStatesRef = useRef<Record<string, AccountQuotaState>>({});
  const accountQuotaRequestIdsRef = useRef<Record<string, number>>({});
  const deferredSearch = useDeferredValue(searchInput);

  const {
    usage,
    loading: usageLoading,
    error: usageError,
    lastRefreshedAt,
    modelPrices,
    setModelPrices,
    loadUsage,
  } = useUsageData();

  const {
    loading: monitoringLoading,
    error: monitoringError,
    authFiles,
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
    await Promise.all([loadUsage(), refreshMeta(false)]);
  }, [loadUsage, refreshMeta]);

  const refreshUsageOnly = useCallback(async () => {
    await loadUsage();
  }, [loadUsage]);

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
    connectionStatus === 'connected' && Number(autoRefreshMs) > 0 ? Number(autoRefreshMs) : null
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

  const accountOptions = useMemo(
    () => [
      { value: 'all', label: t('monitoring.filter_all_accounts') },
      ...Array.from(new Map(filteredRows.map((row) => [row.account, row.account])).entries())
        .sort((left, right) => left[1].localeCompare(right[1]))
        .map(([value, label]) => ({ value, label })),
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

  const channelOptions = useMemo(
    () => [
      { value: 'all', label: t('monitoring.filter_all_channels') },
      ...Array.from(new Set(filteredRows.map((row) => row.channel)))
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right))
        .map((value) => ({ value, label: value })),
    ],
    [filteredRows, t]
  );

  const statusOptions = useMemo(
    () => [
      { value: 'all', label: t('monitoring.filter_all_statuses') },
      { value: 'success', label: t('monitoring.filter_status_success') },
      { value: 'failed', label: t('monitoring.filter_status_failed') },
    ],
    [t]
  );

  const accountGroupOptions = useMemo(
    () => ACCOUNT_GROUP_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) })),
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
        if (selectedAccount !== 'all' && row.account !== selectedAccount) {
          return false;
        }
        if (selectedProvider !== 'all' && row.provider !== selectedProvider) {
          return false;
        }
        if (selectedModel !== 'all' && row.model !== selectedModel) {
          return false;
        }
        if (selectedChannel !== 'all' && row.channel !== selectedChannel) {
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
    [filteredRows, selectedAccount, selectedChannel, selectedModel, selectedProvider, selectedStatus]
  );
  const focusedRows = useMemo(
    () =>
      focusScope
        ? scopedRows.filter((row) => {
            if (focusScope.type === 'account') return row.account === focusScope.value;
            if (focusScope.type === 'apiKey') return row.clientApiKeyId === focusScope.value;
            return row.model === focusScope.value;
          })
        : scopedRows,
    [focusScope, scopedRows]
  );
  const scopedStatsRows = useMemo(() => focusedRows.filter((row) => row.statsIncluded), [focusedRows]);

  const modelRankingRows = useMemo(
    () => [...buildAccountRows(scopedRows, 'model')]
      .sort((left, right) => right.totalCalls - left.totalCalls || right.totalCost - left.totalCost)
      .slice(0, 8),
    [scopedRows]
  );
  const apiKeyRankingRows = useMemo(
    () => [...buildAccountRows(scopedRows, 'apiKey')]
      .sort((left, right) => right.totalCalls - left.totalCalls || right.totalCost - left.totalCost)
      .slice(0, 8),
    [scopedRows]
  );
  const trendPoints = useMemo(() => buildTrendPoints(focusedRows), [focusedRows]);
  const failureAnalysisRows = useMemo(() => buildFailureAnalysisRows(focusedRows), [focusedRows]);
  const costRankingRows = useMemo(
    () => [...buildAccountRows(focusedRows, 'model')]
      .sort((left, right) => right.totalCost - left.totalCost || right.totalTokens - left.totalTokens)
      .slice(0, 10),
    [focusedRows]
  );
  const focusLabel = useMemo(() => {
    if (!focusScope) return '';
    const row = buildAccountRows(scopedRows, focusScope.type).find((item) => (
      focusScope.type === 'account'
        ? item.account === focusScope.value
        : focusScope.type === 'apiKey'
          ? item.id === focusScope.value
          : item.model === focusScope.value
    ));
    if (row) return row.account;
    return focusScope.value;
  }, [focusScope, scopedRows]);
  const maxModelRankingCalls = Math.max(...modelRankingRows.map((row) => row.totalCalls), 1);
  const maxApiKeyRankingCalls = Math.max(...apiKeyRankingRows.map((row) => row.totalCalls), 1);
  const maxTrendRequests = Math.max(...trendPoints.map((point) => point.requests), 1);
  const scopedSummary = useMemo(() => buildMonitoringSummary(scopedStatsRows), [scopedStatsRows]);
  const accountRows = useMemo(() => buildAccountRows(scopedRows, accountGroupBy), [accountGroupBy, scopedRows]);

  const sortedAccountRows = useMemo(() => {
    const directionFactor = accountSort.direction === 'desc' ? -1 : 1;

    return [...accountRows].sort((left, right) => {
      const valueDiff = getAccountSortValue(left, accountSort.key) - getAccountSortValue(right, accountSort.key);
      if (valueDiff !== 0) {
        return valueDiff * directionFactor;
      }

      return compareAccountRowsByDefault(left, right);
    });
  }, [accountRows, accountSort]);
  const realtimeLogRows = useMemo(() => buildRealtimeLogRows(focusedRows), [focusedRows]);

  const accountQuotaTargetsByAccount = useMemo(() => {
    const grouped = new Map<string, Map<string, AccountQuotaTarget>>();

    scopedRows.forEach((row) => {
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
  }, [authFilesByAuthIndex, scopedRows]);
  const accountQuotaEntriesByAccount = useMemo(() => {
    return new Map(
      Array.from(accountQuotaTargetsByAccount.entries()).map(([account, targets]) => [
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
  }, [accountQuotaTargetsByAccount, quotaStore, t]);
  const activeScopeRows = focusedRows;
  const scopedFailureCount = activeScopeRows.filter((row) => row.failed).length;
  const savedPriceEntries = useMemo(
    () => Object.entries(modelPrices).sort((left, right) => left[0].localeCompare(right[0])),
    [modelPrices]
  );

  const selectedFiltersCount =
    [selectedAccount, selectedProvider, selectedModel, selectedChannel, selectedStatus].filter(
      (value) => value !== 'all'
    ).length + (deferredSearch.trim() ? 1 : 0) + (focusScope ? 1 : 0);

  const accountOverviewColumns = useMemo<AccountOverviewColumn[]>(
    () => [
      {
        key: 'account',
        label: getGroupDimensionLabel(accountGroupBy, t),
      },
      { key: 'total-calls', label: t('monitoring.total_calls'), sortKey: 'totalCalls' },
      { key: 'success-calls', label: t('monitoring.success_calls'), sortKey: 'successCalls' },
      { key: 'success-rate', label: t('monitoring.call_success_rate'), sortKey: 'successRate' },
      { key: 'total-tokens', label: t('monitoring.total_tokens'), sortKey: 'totalTokens' },
      { key: 'estimated-cost', label: t('monitoring.estimated_cost'), sortKey: 'totalCost' },
      { key: 'latest-request-time', label: t('monitoring.latest_request_time'), sortKey: 'lastSeenAt' },
      { key: 'action', label: t('common.action') },
    ],
    [accountGroupBy, t]
  );

  const summaryCards: SummaryCardProps[] = [
    {
      label: t('monitoring.total_calls'),
      value: formatCompactNumber(scopedSummary.totalCalls),
      meta: `${accountRows.length} ${accountGroupBy === 'apiKey' ? t('monitoring.api_keys_suffix') : accountGroupBy === 'model' ? t('monitoring.models_suffix') : t('monitoring.accounts_suffix')}${focusScope ? ` · ${t('monitoring.focused_scope_label')}: ${activeScopeRows.length}` : ''}`,
    },
    {
      label: t('monitoring.success_calls'),
      value: <SuccessFailureValue success={scopedSummary.successCalls} failure={scopedSummary.failureCalls} />,
      meta: formatPercent(scopedSummary.successRate),
    },
    {
      label: t('monitoring.call_success_rate'),
      value: formatPercent(scopedSummary.successRate),
      meta: formatDurationMs(scopedSummary.averageLatencyMs, { locale: i18n.language }),
      tone:
        scopedSummary.successRate >= 0.95
          ? 'good'
          : scopedSummary.successRate >= 0.85
            ? 'warn'
            : 'bad',
    },
    {
      label: t('monitoring.estimated_cost'),
      value: hasPrices ? formatUsd(scopedSummary.totalCost) : '--',
      meta: hasPrices ? t('monitoring.estimated_cost_hint') : t('monitoring.estimated_cost_missing'),
      tone: hasPrices ? undefined : 'warn',
    },
    {
      label: t('monitoring.input_tokens'),
      value: formatCompactNumber(scopedSummary.inputTokens),
      meta: `${t('monitoring.of_token_mix')} ${formatPercent(scopedSummary.totalTokens > 0 ? scopedSummary.inputTokens / scopedSummary.totalTokens : 0)}`,
    },
    {
      label: t('monitoring.output_tokens'),
      value: formatCompactNumber(scopedSummary.outputTokens),
      meta: `${t('monitoring.of_token_mix')} ${formatPercent(scopedSummary.totalTokens > 0 ? scopedSummary.outputTokens / scopedSummary.totalTokens : 0)}`,
    },
    {
      label: t('monitoring.cached_tokens'),
      value: formatCompactNumber(scopedSummary.cachedTokens),
      meta: `${t('monitoring.of_input_tokens')} ${formatPercent(scopedSummary.inputTokens > 0 ? scopedSummary.cachedTokens / scopedSummary.inputTokens : 0)}`,
    },
    {
      label: t('monitoring.total_tokens'),
      value: formatCompactNumber(scopedSummary.totalTokens),
      meta: `${t('monitoring.reasoning_tokens')} ${formatCompactNumber(scopedSummary.reasoningTokens)}`,
    },
  ];

  const clearFocusScope = useCallback(() => {
    setFocusScope(null);
  }, []);

  const focusAccountRow = useCallback((row: MonitoringAccountRow) => {
    if (row.group === 'account') {
      setFocusScope((previous) =>
        previous?.type === 'account' && previous.value === row.account ? null : { type: 'account', value: row.account }
      );
      return;
    }

    if (row.group === 'apiKey') {
      setFocusScope((previous) =>
        previous?.type === 'apiKey' && previous.value === row.id ? null : { type: 'apiKey', value: row.id }
      );
      return;
    }

    setFocusScope((previous) =>
      previous?.type === 'model' && previous.value === row.model ? null : { type: 'model', value: row.model }
    );
  }, []);

  const clearFilters = useCallback(() => {
    setFocusScope(null);
    setSearchInput('');
    setSelectedAccount('all');
    setSelectedProvider('all');
    setSelectedModel('all');
    setSelectedChannel('all');
    setSelectedStatus('all');
  }, []);

  const loadAccountQuota = useCallback(
    async (account: string, force: boolean = false) => {
      const currentState = accountQuotaStatesRef.current[account];
      const targets = accountQuotaTargetsByAccount.get(account) ?? [];
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
    [accountQuotaTargetsByAccount, setQuotaForConfig, t]
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

  const handleAccountFilterChange = useCallback((value: string) => {
    setSelectedAccount(value);
  }, []);

  const handleAccountSort = useCallback((key: AccountSortKey) => {
    setAccountSort((previous) =>
      previous.key === key
        ? {
            key,
            direction: previous.direction === 'desc' ? 'asc' : 'desc',
          }
        : {
            key,
            direction: 'desc',
          }
    );
  }, []);

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
        </div>
      </section>

      <Panel
        title={t('monitoring.toolbar_title')}
        subtitle={
          selectedFiltersCount > 0
            ? t('monitoring.active_filters_hint', { count: selectedFiltersCount, rows: activeScopeRows.length })
            : t('monitoring.realtime_table_desc')
        }
        className={styles.toolbarPanel}
        extra={
          <div className={styles.toolbarHeaderActions}>
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder={t('monitoring.search_placeholder')}
              className={styles.toolbarHeaderSearchInput}
              rightElement={<IconSearch size={16} />}
              aria-label={t('monitoring.search_placeholder')}
            />
            <button type="button" className={styles.clearButton} onClick={clearFilters}>
              <IconSlidersHorizontal size={16} />
              <span>{t('monitoring.clear_filters')}</span>
            </button>
          </div>
        }
      >
        <div className={styles.toolbarControlRow}>
          <div className={styles.segmentedControl}>
            {TIME_RANGE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`${styles.segmentButton} ${timeRange === option.value ? styles.segmentButtonActive : ''}`}
                onClick={() => setTimeRange(option.value)}
              >
                {t(option.labelKey)}
              </button>
            ))}
          </div>

          <div className={styles.refreshCluster}>
            <span className={styles.syncPill}>
              {t('monitoring.last_sync')}: {lastRefreshedAt ? lastRefreshedAt.toLocaleTimeString(i18n.language) : '--'}
            </span>

            <div className={styles.refreshControls}>
              <div className={styles.autoRefreshField}>
                <span className={styles.autoRefreshLabel}>
                  <IconTimer size={16} />
                  {t('monitoring.auto_refresh')}
                </span>
                <Select
                  className={styles.autoRefreshSelect}
                  triggerClassName={styles.autoRefreshSelectTrigger}
                  value={autoRefreshMs}
                  options={AUTO_REFRESH_OPTIONS.map((option) => ({
                    value: option.value,
                    label: t(option.labelKey),
                  }))}
                  onChange={setAutoRefreshMs}
                  ariaLabel={t('monitoring.auto_refresh')}
                  fullWidth={false}
                />
              </div>

              <button
                type="button"
                className={styles.refreshButton}
                onClick={() => void refreshAll()}
                disabled={overallLoading}
              >
                <IconRefreshCw size={16} className={overallLoading ? styles.refreshIconSpinning : styles.refreshIcon} />
                <span className={styles.refreshButtonLabel}>{t('usage_stats.refresh')}</span>
              </button>
            </div>
          </div>
        </div>

        <div className={styles.filterGrid}>
          <Select
            value={selectedAccount}
            options={accountOptions}
            onChange={handleAccountFilterChange}
            ariaLabel={t('monitoring.filter_account')}
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
            value={selectedChannel}
            options={channelOptions}
            onChange={setSelectedChannel}
            ariaLabel={t('monitoring.filter_channel')}
          />
          <Select
            value={selectedStatus}
            options={statusOptions}
            onChange={(value) => setSelectedStatus(value as StatusFilter)}
            ariaLabel={t('monitoring.filter_status')}
          />
        </div>

        {combinedError ? <div className={styles.errorBox}>{combinedError}</div> : null}
      </Panel>

        <Panel title={t('monitoring.usage_stats_title')} subtitle={t('monitoring.usage_stats_desc')}>
          <section className={styles.summaryGrid} aria-label={t('monitoring.usage_stats_title')}>
            {summaryCards.map((card) => (
              <SummaryCard key={card.label} {...card} />
            ))}
          </section>
        </Panel>

      <section className={styles.rankingGrid}>
        <RankingPanel
          title={t('monitoring.model_stats_title')}
          subtitle={t('monitoring.model_stats_desc')}
          rows={modelRankingRows}
          maxCalls={maxModelRankingCalls}
          emptyText={t('monitoring.no_data')}
          hasPrices={hasPrices}
        />
        <RankingPanel
          title={t('monitoring.api_key_ranking_title')}
          subtitle={t('monitoring.api_key_ranking_desc')}
          rows={apiKeyRankingRows}
          maxCalls={maxApiKeyRankingCalls}
          emptyText={t('monitoring.no_data')}
          hasPrices={hasPrices}
        />
      </section>

      <Panel
        title={t('monitoring.multidimensional_summary_title')}
        subtitle={t('monitoring.multidimensional_summary_desc')}
        className={styles.accountPanel}
        extra={
          <div className={styles.accountPanelActions}>
            <Select
              value={accountGroupBy}
              options={accountGroupOptions}
              onChange={(value) => {
                const nextGroupBy = value as MonitoringAccountGroupBy;
                setAccountGroupBy(nextGroupBy);
                setAccountSort(getDefaultAccountSort(nextGroupBy));
                setExpandedAccounts({});
                clearFocusScope();
              }}
              ariaLabel={t('monitoring.account_group_by')}
            />
          </div>
        }
      >
        <div className={`${styles.tableWrapper} ${styles.tableScrollWrapper} ${styles.accountTableWrapper}`}>
          <table className={`${styles.table} ${styles.accountOverviewTable}`}>
            <colgroup>
              {accountOverviewColumns.map((column) => (
                <col key={column.key} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {accountOverviewColumns.map((column) => {
                  if (!column.sortKey) {
                    return <th key={column.key}>{column.label}</th>;
                  }

                  const isActive = accountSort.key === column.sortKey;
                  const SortIcon = isActive
                    ? accountSort.direction === 'desc'
                      ? IconChevronDown
                      : IconChevronUp
                    : null;

                  return (
                    <th
                      key={column.key}
                      aria-sort={isActive ? (accountSort.direction === 'desc' ? 'descending' : 'ascending') : 'none'}
                    >
                      <button
                        type="button"
                        className={[
                          styles.sortableHeaderButton,
                          isActive ? styles.sortableHeaderButtonActive : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        onClick={() => handleAccountSort(column.sortKey!)}
                      >
                        <span>{column.label}</span>
                        <span className={styles.sortIndicator} aria-hidden="true">
                          {SortIcon ? <SortIcon size={14} /> : null}
                        </span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sortedAccountRows.map((row) => {
                const isExpanded = Boolean(expandedAccounts[row.id]);
                const isFocused = focusScope?.type === row.group && focusScope.value === (row.group === 'account' ? row.account : row.group === 'apiKey' ? row.id : row.model);
                const summaryMetrics = buildAccountSummaryMetrics(row, hasPrices, i18n.language, t);

                if (isExpanded) {
                  return (
                    <tr key={row.id} className={styles.expandedAccountCardRow}>
                      <td colSpan={accountOverviewColumns.length}>
                        <ExpandedAccountCard
                          row={row}
                          hasPrices={hasPrices}
                          locale={i18n.language}
                          t={t}
                          summaryMetrics={summaryMetrics}
                          isFocused={isFocused}
                          quotaState={row.group === 'account' ? accountQuotaStates[row.account] : undefined}
                          quotaEntries={row.group === 'account' ? accountQuotaEntriesByAccount.get(row.account) ?? [] : []}
                          onToggle={() => toggleAccountExpanded(row.id, row.group === 'account' ? row.account : '')}
                          onFocus={() => focusAccountRow(row)}
                          onRefreshQuota={() => void loadAccountQuota(row.account, true)}
                        />
                      </td>
                    </tr>
                  );
                }

                return (
                  <tr key={row.id} className={isFocused ? styles.focusedRow : undefined}>
                    <td>
                      <AccountSummaryPrimary
                        row={row}
                        expanded={false}
                        onToggle={() => toggleAccountExpanded(row.id, row.group === 'account' ? row.account : '')}
                      />
                    </td>
                    {summaryMetrics.map((metric) => (
                      <td key={metric.key} className={metric.valueClassName}>
                        {metric.value}
                      </td>
                    ))}
                    <td>
                      <button
                        type="button"
                        className={styles.inlineActionButton}
                        onClick={() => focusAccountRow(row)}
                      >
                        {isFocused ? t('monitoring.restore_account_scope') : getFocusActionLabel(row, t)}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {sortedAccountRows.length === 0 ? (
                <tr>
                  <td colSpan={accountOverviewColumns.length}>
                    <div className={styles.emptyTable}>
                      {deferredSearch.trim() ? t('monitoring.no_filtered_data') : t('monitoring.no_data')}
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Panel>

      <Card className={styles.focusPanel}>
        <div className={styles.focusHeader}>
          <span className={styles.focusKicker}>{t('monitoring.current_focus_title')}</span>
          <strong>
            {focusScope
              ? `${getGroupDimensionLabel(focusScope.type, t)}: ${focusLabel}`
              : t('monitoring.no_focus_title')}
          </strong>
          {!focusScope ? <small>{t('monitoring.no_focus_desc')}</small> : null}
        </div>
        <div className={styles.focusMetrics}>
          <div>
            <span>{t('monitoring.total_calls')}</span>
            <strong>{formatCompactNumber(scopedSummary.totalCalls)}</strong>
          </div>
          <div>
            <span>{t('monitoring.call_success_rate')}</span>
            <strong>{formatPercent(scopedSummary.successRate)}</strong>
          </div>
          <div>
            <span>{t('monitoring.estimated_cost')}</span>
            <strong>{hasPrices ? formatUsd(scopedSummary.totalCost) : '--'}</strong>
          </div>
          <div>
            <span>{t('monitoring.avg_latency')}</span>
            <strong>{formatDurationMs(scopedSummary.averageLatencyMs, { locale: i18n.language })}</strong>
          </div>
        </div>
        <button type="button" className={styles.inlineActionButton} onClick={clearFocusScope} disabled={!focusScope}>
          {t('monitoring.clear_focus')}
        </button>
      </Card>

      <Panel
        title={t('monitoring.analysis_view_title')}
        subtitle={t('monitoring.analysis_view_desc')}
        className={styles.realtimePanel}
        extra={
          <div className={styles.inlineMetrics}>
            <span>{`${t('monitoring.log_rows')}: ${realtimeLogRows.length}`}</span>
            <span>{`${t('monitoring.recent_failures')}: ${scopedFailureCount}`}</span>
          </div>
        }
      >
        <div className={styles.analysisTabs} role="tablist" aria-label={t('monitoring.analysis_view_title')}>
          {ANALYSIS_TAB_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={activeAnalysisTab === option.value}
              className={`${styles.analysisTabButton} ${activeAnalysisTab === option.value ? styles.analysisTabButtonActive : ''}`}
              onClick={() => setActiveAnalysisTab(option.value)}
            >
              {t(option.labelKey)}
            </button>
          ))}
        </div>

        {activeAnalysisTab === 'trend' ? (
          <div className={styles.trendGrid}>
            {trendPoints.map((point) => (
              <div key={point.key} className={styles.trendItem}>
                <span className={styles.trendBarTrack}>
                  <span
                    className={styles.trendBarFill}
                    style={{ '--trend-height': `${Math.max((point.requests / maxTrendRequests) * 100, 4)}%` } as CSSProperties}
                  />
                </span>
                <strong>{formatCompactNumber(point.requests)}</strong>
                <span>{point.label}</span>
              </div>
            ))}
            {trendPoints.length === 0 ? <div className={styles.emptyBlockSmall}>{t('monitoring.no_data')}</div> : null}
          </div>
        ) : null}

        {activeAnalysisTab === 'failures' ? (
          <div className={styles.analysisList}>
            {failureAnalysisRows.map((row) => (
              <div key={row.key} className={styles.analysisRow}>
                <div className={styles.primaryCell}>
                  <span className={styles.monoCell}>{row.label}</span>
                  <small>{row.meta || '-'}</small>
                </div>
                <div className={styles.inlineMetrics}>
                  <span>{`${t('monitoring.column_failures')}: ${formatCompactNumber(row.failures)}`}</span>
                  <span>{`${t('monitoring.column_failure_rate')}: ${formatPercent(row.failureRate)}`}</span>
                  <span>{new Date(row.lastSeenAt).toLocaleString(i18n.language)}</span>
                </div>
              </div>
            ))}
            {failureAnalysisRows.length === 0 ? <div className={styles.emptyBlockSmall}>{t('monitoring.no_failures')}</div> : null}
          </div>
        ) : null}

        {activeAnalysisTab === 'cost' ? (
          <div className={styles.analysisList}>
            {costRankingRows.map((row) => (
              <div key={row.id} className={styles.analysisRow}>
                <div className={styles.primaryCell}>
                  <span className={styles.monoCell}>{row.account}</span>
                  <small>{`${formatCompactNumber(row.totalTokens)} ${t('monitoring.column_tokens')} · ${formatPercent(row.successRate)}`}</small>
                </div>
                <strong>{hasPrices ? formatUsd(row.totalCost) : '--'}</strong>
              </div>
            ))}
            {costRankingRows.length === 0 ? <div className={styles.emptyBlockSmall}>{t('monitoring.no_data')}</div> : null}
          </div>
        ) : null}

        {activeAnalysisTab === 'logs' ? (
          <div className={`${styles.tableWrapper} ${styles.tableScrollWrapper} ${styles.realtimeTableWrapper}`}>
            <table className={`${styles.table} ${styles.realtimeTable}`}>
            <thead>
              <tr>
                <th>{t('monitoring.column_type')}</th>
                <th>{t('monitoring.column_model')}</th>
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
                    <div className={styles.recentStatusCell}>
                      <RecentPattern
                        pattern={row.recentPattern}
                        variant="plain"
                        label={t('monitoring.recent_pattern_label', {
                          total: row.recentPattern.length,
                          success: row.recentPattern.filter(Boolean).length,
                          failure: row.recentPattern.filter((item) => !item).length,
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
                  <td colSpan={10}>
                    <div className={styles.emptyTable}>
                      {deferredSearch.trim() ? t('monitoring.no_filtered_data') : t('monitoring.no_data')}
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          </div>
        ) : null}
      </Panel>
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
