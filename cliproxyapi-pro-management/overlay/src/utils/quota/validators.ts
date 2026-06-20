/**
 * Validation and type checking functions for quota management.
 */

import type { AuthFileItem } from '@/types';
import { normalizeNumberValue } from './parsers';

export type QuotaProviderType = 'antigravity' | 'claude' | 'codex' | 'kimi' | 'xai';

type QuotaProviderMetadata = {
  quotaMapName:
    | 'antigravityQuota'
    | 'claudeQuota'
    | 'codexQuota'
    | 'kimiQuota'
    | 'xaiQuota';
  setterName:
    | 'setAntigravityQuota'
    | 'setClaudeQuota'
    | 'setCodexQuota'
    | 'setKimiQuota'
    | 'setXaiQuota';
};

export const QUOTA_PROVIDER_METADATA: Record<QuotaProviderType, QuotaProviderMetadata> = {
  antigravity: { quotaMapName: 'antigravityQuota', setterName: 'setAntigravityQuota' },
  claude: { quotaMapName: 'claudeQuota', setterName: 'setClaudeQuota' },
  codex: { quotaMapName: 'codexQuota', setterName: 'setCodexQuota' },
  kimi: { quotaMapName: 'kimiQuota', setterName: 'setKimiQuota' },
  xai: { quotaMapName: 'xaiQuota', setterName: 'setXaiQuota' },
};

export const QUOTA_PROVIDER_TYPES = Object.keys(QUOTA_PROVIDER_METADATA) as QuotaProviderType[];

export function isQuotaProviderType(provider: string): provider is QuotaProviderType {
  return provider in QUOTA_PROVIDER_METADATA;
}

export function getQuotaProviderMapName(provider: QuotaProviderType): QuotaProviderMetadata['quotaMapName'] {
  return QUOTA_PROVIDER_METADATA[provider].quotaMapName;
}

export function getQuotaProviderSetterName(provider: QuotaProviderType): QuotaProviderMetadata['setterName'] {
  return QUOTA_PROVIDER_METADATA[provider].setterName;
}

export function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readStringValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

export function readBooleanValue(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

export function resolveAuthProvider(file: AuthFileItem): string {
  const raw = file.provider ?? file.type ?? file.typo ?? '';
  const key = String(raw).trim().toLowerCase().replace(/_/g, '-');
  if (key === 'x-ai' || key === 'grok') return 'xai';
  return key;
}

export function isAntigravityFile(file: AuthFileItem): boolean {
  return resolveAuthProvider(file) === 'antigravity';
}

export function isClaudeFile(file: AuthFileItem): boolean {
  return resolveAuthProvider(file) === 'claude';
}

export function isClaudeOAuthFile(file: AuthFileItem): boolean {
  if (!isClaudeFile(file)) return false;
  const metadata =
    file && typeof file.metadata === 'object' && file.metadata !== null
      ? (file.metadata as Record<string, unknown>)
      : null;
  const accessToken =
    metadata && typeof metadata.access_token === 'string'
      ? metadata.access_token.trim()
      : '';
  return accessToken.includes('sk-ant-oat');
}

export function isCodexFile(file: AuthFileItem): boolean {
  return resolveAuthProvider(file) === 'codex';
}

export function isKimiFile(file: AuthFileItem): boolean {
  return resolveAuthProvider(file) === 'kimi';
}

export function isXaiFile(file: AuthFileItem): boolean {
  return resolveAuthProvider(file) === 'xai';
}

export function isRuntimeOnlyAuthFile(file: AuthFileItem): boolean {
  const raw = file['runtime_only'] ?? file.runtimeOnly;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return raw.trim().toLowerCase() === 'true';
  return false;
}

export function isDisabledAuthFile(file: AuthFileItem): boolean {
  const raw = (file as { disabled?: unknown }).disabled;
  const statusRaw = file.status ?? file.state;
  const normalizedStatus =
    typeof statusRaw === 'string' ? statusRaw.trim().toLowerCase() : '';
  if (normalizedStatus === 'disabled' || normalizedStatus === 'inactive') {
    return true;
  }
  return readBooleanValue(raw);
}

export function isQuotaLowState(quota: unknown, usedPercentThreshold = 100): boolean {
  if (!isRecordValue(quota)) return false;
  if (quota.status !== 'success') return false;

  return ['windows', 'groups', 'buckets', 'rows'].some((key) => {
    const value = quota[key];
    return Array.isArray(value) && value.some((window) => isQuotaLowWindow(window, usedPercentThreshold));
  });
}

function isQuotaLowWindow(window: unknown, usedPercentThreshold: number): boolean {
  if (!isRecordValue(window)) return false;
  if (readBooleanValue(window.limitReached ?? window.limit_reached)) return true;
  if (window.allowed !== undefined && !readBooleanValue(window.allowed, true)) return true;
  const threshold = Number.isFinite(usedPercentThreshold) ? usedPercentThreshold : 100;
  const usedPercent = normalizeNumberValue(window.usedPercent ?? window.used_percent);
  if (usedPercent !== null && usedPercent >= threshold) return true;
  const remainingFraction = normalizeNumberValue(window.remainingFraction ?? window.remaining_fraction);
  if (remainingFraction !== null && remainingFraction <= 0) return true;
  const remainingAmount = normalizeNumberValue(window.remainingAmount ?? window.remaining_amount ?? window.remaining);
  if (remainingAmount !== null && remainingAmount <= 0) return true;
  const limit = normalizeNumberValue(window.limit);
  const used = normalizeNumberValue(window.used);
  return limit !== null && limit > 0 && used !== null && used >= limit;
}
