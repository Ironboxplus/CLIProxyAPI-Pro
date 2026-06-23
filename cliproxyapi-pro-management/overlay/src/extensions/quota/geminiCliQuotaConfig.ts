import React from 'react';
import type { ReactNode } from 'react';
import type { TFunction } from 'i18next';
import type {
  AuthFileItem,
  GeminiCliCodeAssistPayload,
  GeminiCliCredits,
  GeminiCliParsedBucket,
  GeminiCliQuotaBucket,
  GeminiCliQuotaBucketState,
  GeminiCliQuotaPayload,
  GeminiCliQuotaState,
  GeminiCliUserTier,
} from '@/types';
import { apiCallApi, getApiCallErrorMessage } from '@/services/api';
import {
  createStatusError,
  formatQuotaResetTime,
  isDisabledAuthFile,
  isGeminiCliFile,
  isRuntimeOnlyAuthFile,
  normalizeNumberValue,
  normalizeQuotaFraction,
  normalizeStringValue,
  resolveGeminiCliProjectId,
} from '@/utils/quota';
import { normalizeAuthIndex } from '@/utils/authIndex';
import type { QuotaConfig } from '@/components/quota/quotaConfigs';
import type { QuotaRenderHelpers } from '@/components/quota/QuotaCard';
import styles from '@/pages/QuotaPage.module.scss';

const GEMINI_CLI_QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';
const GEMINI_CLI_CODE_ASSIST_URL =
  'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
const GEMINI_CLI_G1_CREDIT_TYPE = 'GOOGLE_ONE_AI';
const QUOTA_PROGRESS_HIGH_THRESHOLD = 70;
const QUOTA_PROGRESS_MEDIUM_THRESHOLD = 30;

type GeminiCliQuotaData = {
  buckets: GeminiCliQuotaBucketState[];
  projectId: string;
  tierLabel: string | null;
  tierId: string | null;
  creditBalance: number | null;
};

type GeminiCliQuotaGroupDefinition = {
  id: string;
  label: string;
  preferredModelId?: string;
  modelIds: string[];
};

const GEMINI_CLI_QUOTA_GROUPS: GeminiCliQuotaGroupDefinition[] = [
  {
    id: 'gemini-flash-lite-series',
    label: 'Gemini Flash Lite Series',
    preferredModelId: 'gemini-2.5-flash-lite',
    modelIds: ['gemini-2.5-flash-lite'],
  },
  {
    id: 'gemini-flash-series',
    label: 'Gemini Flash Series',
    preferredModelId: 'gemini-3-flash-preview',
    modelIds: ['gemini-3-flash-preview', 'gemini-2.5-flash'],
  },
  {
    id: 'gemini-pro-series',
    label: 'Gemini Pro Series',
    preferredModelId: 'gemini-3.1-pro-preview',
    modelIds: ['gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-2.5-pro'],
  },
];

const GEMINI_CLI_GROUP_ORDER = new Map(
  GEMINI_CLI_QUOTA_GROUPS.map((group, index) => [group.id, index] as const)
);

const GEMINI_CLI_GROUP_LOOKUP = new Map(
  GEMINI_CLI_QUOTA_GROUPS.flatMap((group) =>
    group.modelIds.map((modelId) => [modelId, group] as const)
  )
);

const PREMIUM_GEMINI_CLI_TIER_IDS = new Set(['g1-pro-tier', 'g1-ultra-tier']);

const parseGeminiCliQuotaPayload = (payload: unknown): GeminiCliQuotaPayload | null => {
  if (payload === undefined || payload === null) return null;
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed) as GeminiCliQuotaPayload;
    } catch {
      return null;
    }
  }
  return typeof payload === 'object' ? (payload as GeminiCliQuotaPayload) : null;
};

const parseGeminiCliCodeAssistPayload = (
  payload: unknown
): GeminiCliCodeAssistPayload | null => {
  if (payload === undefined || payload === null) return null;
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed) as GeminiCliCodeAssistPayload;
    } catch {
      return null;
    }
  }
  return typeof payload === 'object' ? (payload as GeminiCliCodeAssistPayload) : null;
};

const normalizeGeminiCliModelId = (value: unknown): string | null => {
  const modelId = normalizeStringValue(value);
  if (!modelId) return null;
  return modelId.endsWith('_vertex') ? modelId.slice(0, -'_vertex'.length) : modelId;
};

const isIgnoredGeminiCliModel = (modelId: string): boolean =>
  modelId === 'gemini-2.0-flash' || modelId.startsWith('gemini-2.0-flash-');

const pickEarlierResetTime = (current?: string, next?: string): string | undefined => {
  if (!current) return next;
  if (!next) return current;
  const currentTime = new Date(current).getTime();
  const nextTime = new Date(next).getTime();
  if (Number.isNaN(currentTime)) return next;
  if (Number.isNaN(nextTime)) return current;
  return currentTime <= nextTime ? current : next;
};

const minNullableNumber = (current: number | null, next: number | null): number | null => {
  if (current === null) return next;
  if (next === null) return current;
  return Math.min(current, next);
};

const buildGeminiCliQuotaBuckets = (
  buckets: GeminiCliParsedBucket[]
): GeminiCliQuotaBucketState[] => {
  if (buckets.length === 0) return [];

  type BucketGroup = {
    id: string;
    label: string;
    tokenType: string | null;
    modelIds: string[];
    preferredModelId?: string;
    preferredBucket?: GeminiCliParsedBucket;
    fallbackRemainingFraction: number | null;
    fallbackRemainingAmount: number | null;
    fallbackResetTime: string | undefined;
  };

  const grouped = new Map<string, BucketGroup>();

  buckets.forEach((bucket) => {
    if (isIgnoredGeminiCliModel(bucket.modelId)) return;
    const group = GEMINI_CLI_GROUP_LOOKUP.get(bucket.modelId);
    const groupId = group?.id ?? bucket.modelId;
    const label = group?.label ?? bucket.modelId;
    const tokenKey = bucket.tokenType ?? '';
    const mapKey = `${groupId}::${tokenKey}`;
    const existing = grouped.get(mapKey);

    if (!existing) {
      const preferredModelId = group?.preferredModelId;
      grouped.set(mapKey, {
        id: `${groupId}${tokenKey ? `-${tokenKey}` : ''}`,
        label,
        tokenType: bucket.tokenType,
        modelIds: [bucket.modelId],
        preferredModelId,
        preferredBucket:
          preferredModelId && bucket.modelId === preferredModelId ? bucket : undefined,
        fallbackRemainingFraction: bucket.remainingFraction,
        fallbackRemainingAmount: bucket.remainingAmount,
        fallbackResetTime: bucket.resetTime,
      });
      return;
    }

    existing.fallbackRemainingFraction = minNullableNumber(
      existing.fallbackRemainingFraction,
      bucket.remainingFraction
    );
    existing.fallbackRemainingAmount = minNullableNumber(
      existing.fallbackRemainingAmount,
      bucket.remainingAmount
    );
    existing.fallbackResetTime = pickEarlierResetTime(existing.fallbackResetTime, bucket.resetTime);
    existing.modelIds.push(bucket.modelId);

    if (existing.preferredModelId && bucket.modelId === existing.preferredModelId) {
      existing.preferredBucket = bucket;
    }
  });

  const toGroupOrder = (bucket: BucketGroup): number => {
    const tokenSuffix = bucket.tokenType ? `-${bucket.tokenType}` : '';
    const groupId = bucket.id.endsWith(tokenSuffix)
      ? bucket.id.slice(0, bucket.id.length - tokenSuffix.length)
      : bucket.id;
    return GEMINI_CLI_GROUP_ORDER.get(groupId) ?? Number.MAX_SAFE_INTEGER;
  };

  return Array.from(grouped.values())
    .sort((a, b) => {
      const orderDiff = toGroupOrder(a) - toGroupOrder(b);
      if (orderDiff !== 0) return orderDiff;
      return (a.tokenType ?? '').localeCompare(b.tokenType ?? '');
    })
    .map((bucket) => {
      const preferred = bucket.preferredBucket;
      return {
        id: bucket.id,
        label: bucket.label,
        remainingFraction: preferred
          ? preferred.remainingFraction
          : bucket.fallbackRemainingFraction,
        remainingAmount: preferred ? preferred.remainingAmount : bucket.fallbackRemainingAmount,
        resetTime: preferred ? preferred.resetTime : bucket.fallbackResetTime,
        tokenType: bucket.tokenType,
        modelIds: Array.from(new Set(bucket.modelIds)),
      };
    });
};

const resolveGeminiCliRemainingFraction = (bucket: GeminiCliQuotaBucket): number | null => {
  const normalized = normalizeQuotaFraction(bucket.remainingFraction ?? bucket.remaining_fraction);
  if (normalized !== null) return normalized;
  const amount = normalizeNumberValue(bucket.remainingAmount ?? bucket.remaining_amount);
  if (amount !== null && amount <= 0) return 0;
  if (bucket.resetTime || bucket.reset_time) return 0;
  return null;
};

const fetchGeminiCliCodeAssist = async (
  authIndex: string,
  projectId: string
): Promise<Pick<GeminiCliQuotaData, 'tierLabel' | 'tierId' | 'creditBalance'>> => {
  const result = await apiCallApi.request({
    authIndex,
    method: 'POST',
    url: GEMINI_CLI_CODE_ASSIST_URL,
    header: { 'Content-Type': 'application/json' },
    data: JSON.stringify({
      cloudaicompanionProject: projectId,
      metadata: {
        ideType: 'IDE_UNSPECIFIED',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI',
        duetProject: projectId,
      },
    }),
    useExecutor: true,
  });

  if (result.statusCode < 200 || result.statusCode >= 300) {
    return { tierLabel: null, tierId: null, creditBalance: null };
  }

  const payload = parseGeminiCliCodeAssistPayload(result.body ?? result.bodyText);
  return {
    tierLabel: resolveGeminiCliTierLabel(payload),
    tierId: resolveGeminiCliTierId(payload),
    creditBalance: resolveGeminiCliCreditBalance(payload),
  };
};

const fetchGeminiCliQuota = async (
  file: AuthFileItem,
  t: TFunction
): Promise<GeminiCliQuotaData> => {
  const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
  if (!authIndex) {
    throw new Error(t('gemini_cli_quota.missing_auth_index'));
  }

  const projectId = resolveGeminiCliProjectId(file);
  if (!projectId) {
    throw new Error(t('gemini_cli_quota.missing_project_id'));
  }

  const quotaResponse = await apiCallApi.request({
    authIndex,
    method: 'POST',
    url: GEMINI_CLI_QUOTA_URL,
    header: { 'Content-Type': 'application/json' },
    data: JSON.stringify({ project: projectId }),
    useExecutor: true,
  });

  if (quotaResponse.statusCode < 200 || quotaResponse.statusCode >= 300) {
    throw createStatusError(getApiCallErrorMessage(quotaResponse), quotaResponse.statusCode);
  }

  const payload = parseGeminiCliQuotaPayload(quotaResponse.body ?? quotaResponse.bodyText);
  const rawBuckets = Array.isArray(payload?.buckets) ? payload.buckets : [];
  const parsedBuckets = rawBuckets
    .map((bucket): GeminiCliParsedBucket | null => {
      const modelId = normalizeGeminiCliModelId(bucket.modelId ?? bucket.model_id);
      if (!modelId || isIgnoredGeminiCliModel(modelId)) return null;
      const remainingFraction = resolveGeminiCliRemainingFraction(bucket);
      const remainingAmount = normalizeNumberValue(
        bucket.remainingAmount ?? bucket.remaining_amount
      );
      return {
        modelId,
        tokenType: normalizeStringValue(bucket.tokenType ?? bucket.token_type),
        remainingFraction,
        remainingAmount,
        resetTime: normalizeStringValue(bucket.resetTime ?? bucket.reset_time) ?? undefined,
      };
    })
    .filter((bucket): bucket is GeminiCliParsedBucket => bucket !== null);

  const buckets = buildGeminiCliQuotaBuckets(parsedBuckets);
  if (buckets.length === 0) {
    throw new Error(t('gemini_cli_quota.empty_buckets'));
  }

  const supplementary = await fetchGeminiCliCodeAssist(authIndex, projectId).catch(() => ({
    tierLabel: null,
    tierId: null,
    creditBalance: null,
  }));

  return {
    buckets,
    projectId,
    ...supplementary,
  };
};

const resolveGeminiCliTier = (
  payload: GeminiCliCodeAssistPayload | null
): GeminiCliUserTier | null => {
  if (!payload) return null;
  const paidTier = payload.paidTier ?? payload.paid_tier ?? null;
  const currentTier = payload.currentTier ?? payload.current_tier ?? null;
  return paidTier?.id ? paidTier : currentTier;
};

const resolveGeminiCliTierId = (payload: GeminiCliCodeAssistPayload | null): string | null =>
  normalizeStringValue(resolveGeminiCliTier(payload)?.id);

const resolveGeminiCliTierLabel = (payload: GeminiCliCodeAssistPayload | null): string | null => {
  const tier = resolveGeminiCliTier(payload);
  const tierId = normalizeStringValue(tier?.id);
  const tierName = normalizeStringValue(tier?.name);
  if (tierName) return tierName;
  if (tierId === 'free-tier') return 'Free';
  if (tierId === 'legacy-tier') return 'Legacy';
  if (tierId === 'standard-tier') return 'Standard';
  if (tierId === 'g1-pro-tier') return 'Google One AI Pro';
  if (tierId === 'g1-ultra-tier') return 'Google One AI Ultra';
  return tierId;
};

const resolveGeminiCliCreditBalance = (
  payload: GeminiCliCodeAssistPayload | null
): number | null => {
  const tier = resolveGeminiCliTier(payload);
  const credits: GeminiCliCredits[] = tier?.availableCredits ?? tier?.available_credits ?? [];
  for (const credit of credits) {
    const creditType = normalizeStringValue(credit.creditType ?? credit.credit_type);
    if (creditType !== GEMINI_CLI_G1_CREDIT_TYPE) continue;
    return normalizeNumberValue(credit.creditAmount ?? credit.credit_amount);
  }
  return null;
};

const renderGeminiCliItems = (
  quota: GeminiCliQuotaState,
  t: TFunction,
  helpers: QuotaRenderHelpers
): ReactNode => {
  const { styles: styleMap, QuotaProgressBar } = helpers;
  const { createElement: h, Fragment } = React;
  const buckets = quota.buckets ?? [];
  const nodes: ReactNode[] = [];
  const tierLabel = quota.tierLabel ?? null;
  const tierId = quota.tierId ?? null;
  const creditBalance = quota.creditBalance ?? null;

  if (tierLabel || creditBalance !== null) {
    nodes.push(
      h(
        'div',
        { key: 'tier', className: styleMap.codexPlan },
        tierLabel
          ? h(
              'span',
              { className: styleMap.codexPlanItem },
              h('span', { className: styleMap.codexPlanLabel }, t('gemini_cli_quota.tier_label')),
              h(
                'span',
                {
                  className:
                    tierId && PREMIUM_GEMINI_CLI_TIER_IDS.has(tierId)
                      ? styleMap.premiumPlanValue
                      : styleMap.codexPlanValue,
                },
                tierLabel
              )
            )
          : null,
        creditBalance !== null
          ? h(
              'span',
              { className: styleMap.codexPlanItem },
              h('span', { className: styleMap.codexPlanLabel }, t('gemini_cli_quota.credit_label')),
              h(
                'span',
                { className: styleMap.codexPlanValue },
                t('gemini_cli_quota.credit_amount', { count: creditBalance })
              )
            )
          : null
      )
    );
  }

  if (buckets.length === 0) {
    nodes.push(
      h('div', { key: 'empty', className: styleMap.quotaMessage }, t('gemini_cli_quota.empty_buckets'))
    );
    return h(Fragment, null, ...nodes);
  }

  nodes.push(
    ...buckets.map((bucket) => {
      const remainingFraction = bucket.remainingFraction;
      const remaining =
        remainingFraction === null ? null : Math.max(0, Math.min(100, remainingFraction * 100));
      const percentLabel = remaining === null ? '--' : `${Math.round(remaining)}%`;
      const amountLabel =
        bucket.remainingAmount === null
          ? null
          : t('gemini_cli_quota.remaining_amount', { count: bucket.remainingAmount });

      return h(
        'div',
        { key: bucket.id, className: styleMap.quotaRow },
        h(
          'div',
          { className: styleMap.quotaRowHeader },
          h('span', { className: styleMap.quotaModel, title: bucket.modelIds?.join(', ') }, bucket.label),
          h(
            'div',
            { className: styleMap.quotaMeta },
            h('span', { className: styleMap.quotaPercent }, percentLabel),
            amountLabel ? h('span', { className: styleMap.quotaAmount }, amountLabel) : null,
            h('span', { className: styleMap.quotaReset }, formatQuotaResetTime(bucket.resetTime))
          )
        ),
        h(QuotaProgressBar, {
          percent: remaining,
          highThreshold: QUOTA_PROGRESS_HIGH_THRESHOLD,
          mediumThreshold: QUOTA_PROGRESS_MEDIUM_THRESHOLD,
        })
      );
    })
  );

  return h(Fragment, null, ...nodes);
};

export const GEMINI_CLI_CONFIG = {
  type: 'gemini-cli',
  i18nPrefix: 'gemini_cli_quota',
  cardIdleMessageKey: 'quota_management.card_idle_hint',
  filterFn: (file: AuthFileItem) =>
    isGeminiCliFile(file) && !isRuntimeOnlyAuthFile(file) && !isDisabledAuthFile(file),
  fetchQuota: fetchGeminiCliQuota,
  storeSelector: (state) => state.geminiCliQuota,
  storeSetter: 'setGeminiCliQuota',
  buildLoadingState: () => ({
    status: 'loading',
    buckets: [],
    projectId: '',
    tierLabel: null,
    tierId: null,
    creditBalance: null,
  }),
  buildSuccessState: (data: GeminiCliQuotaData) => ({
    status: 'success',
    buckets: data.buckets,
    projectId: data.projectId,
    tierLabel: data.tierLabel,
    tierId: data.tierId,
    creditBalance: data.creditBalance,
    cachedAt: Date.now(),
  }),
  buildErrorState: (message: string, status?: number) => ({
    status: 'error',
    buckets: [],
    projectId: '',
    tierLabel: null,
    tierId: null,
    creditBalance: null,
    error: message,
    errorStatus: status,
  }),
  cardClassName: styles.geminiCliCard,
  controlsClassName: styles.geminiCliControls,
  controlClassName: styles.geminiCliControl,
  gridClassName: styles.geminiCliGrid,
  renderQuotaItems: renderGeminiCliItems,
} satisfies QuotaConfig<GeminiCliQuotaState, GeminiCliQuotaData>;
