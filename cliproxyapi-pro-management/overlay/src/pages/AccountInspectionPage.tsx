import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
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
import {
  ACCOUNT_INSPECTION_SETTING_LIMITS,
  applyAccountInspectionExecutionResult,
  buildExecutionFailureMessage,
  clearAccountInspectionConfigurableSettings,
  DEFAULT_ACCOUNT_INSPECTION_SETTINGS,
  formatAccountInspectionIdentity,
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
import { useAuthStore, useConfigStore, useNotificationStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import styles from './AccountInspectionPage.module.scss';

type RunStatus = 'idle' | 'running' | 'paused' | 'success' | 'error';

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

type AuthFilesResponse = {
  files: AuthFileItem[];
  total?: number;
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

const summaryToneClass: Record<NonNullable<SummaryCard['tone']>, string> = {
  neutral: '',
  good: styles.summaryGood,
  warn: styles.summaryWarn,
  bad: styles.summaryBad,
};

const INSPECTION_TARGET_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'antigravity', label: 'Antigravity' },
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'gemini-cli', label: 'Gemini CLI' },
  { value: 'kimi', label: 'Kimi' },
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

const createIdleProgressSnapshot = (): AccountInspectionProgressSnapshot => ({
  total: 0,
  completed: 0,
  inFlight: 0,
  pending: 0,
  percent: 0,
  status: 'idle',
  summary: {
    totalFiles: 0,
    probeSetCount: 0,
    sampledCount: 0,
    disabledCount: 0,
    enabledCount: 0,
    deleteCount: 0,
    disableCount: 0,
    enableCount: 0,
    keepCount: 0,
    errorCount: 0,
  },
  startedAt: Date.now(),
  updatedAt: Date.now(),
});

const backendResultToFrontendItem = (
  item: NonNullable<AccountInspectionScheduleResponse['status']['results']>[number]
): AccountInspectionResultItem => ({
  key: item.key,
  fileName: item.fileName,
  displayAccount: item.displayName,
  email: item.email,
  name: item.name,
  authIndex: item.authIndex || null,
  accountId: null,
  provider: item.provider,
  disabled: item.disabled,
  status: '',
  state: '',
  raw: {
    name: item.fileName,
    type: item.provider,
    provider: item.provider,
    authIndex: item.authIndex,
    disabled: item.disabled,
  },
  action: item.action,
  actionReason: item.actionReason,
  statusCode: item.statusCode ?? null,
  usedPercent: item.usedPercent ?? null,
  isQuota: item.isQuota,
  error: item.executeError || item.error || '',
});

const backendProgressStatus = (status: AccountInspectionScheduleResponse['status']): AccountInspectionProgressSnapshot['status'] => {
  if (status.state === 'paused') return 'paused';
  if (status.state === 'running' || status.state === 'stopping') return 'running';
  if (status.state === 'stopped') return 'stopped';
  if (status.state === 'completed' || status.state === 'partial' || status.lastFinishedAt > 0) return 'completed';
  return 'idle';
};

const backendRunStatus = (status: AccountInspectionScheduleResponse['status']): RunStatus => {
  if (status.state === 'paused') return 'paused';
  if (status.state === 'running' || status.state === 'stopping') return 'running';
  if (status.state === 'failed') return 'error';
  if (status.state === 'stopped') return 'idle';
  if (status.state === 'completed' || status.state === 'partial' || status.lastFinishedAt > 0) {
    return status.lastError ? 'error' : 'success';
  }
  return 'idle';
};

const applyIfChanged = <T,>(setValue: Dispatch<SetStateAction<T>>, isEqual: (next: T, previous: T) => boolean) =>
  (next: T) => setValue((previous) => (isEqual(next, previous) ? previous : next));

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

const applyBackendInspectionResponse = (
  response: AccountInspectionScheduleResponse,
  setters: {
    setInspectionSettings: (settings: AccountInspectionConfigurableSettings) => void;
    setSettingsDraft: (draft: InspectionSettingsDraft) => void;
    setScheduleDraft: (draft: ScheduleDraft) => void;
    setScheduleResponse: (response: AccountInspectionScheduleResponse) => void;
    setAutoExecutionCounts: (counts: AutoExecutionCounts) => void;
    setLogs: (logs: InspectionLogEntry[]) => void;
    setResult: (result: AccountInspectionRunResult | null) => void;
    setProgress: (progress: AccountInspectionProgressSnapshot) => void;
    setRunStatus?: (status: RunStatus) => void;
  }
) => {
  const settings = response.schedule.settings;
  setters.setInspectionSettings(settings);
  setters.setSettingsDraft(toSettingsDraft(settings));
  setters.setScheduleDraft({
    enabled: response.schedule.enabled,
    intervalMinutes: String(response.schedule.intervalMinutes),
  });
  setters.setScheduleResponse(response);
  const isSnapshot = Array.isArray(response.status.logs) || Array.isArray(response.status.results);
  if (isSnapshot) {
    setters.setLogs(
      (response.status.logs ?? []).map((entry, index) => ({
        id: `backend-${entry.time}-${index}`,
        level: entry.level,
        message: entry.message,
        timestamp: entry.time,
      }))
    );
  }

  const startedAt = response.status.lastStartedAt || Date.now();
  const finishedAt = response.status.lastFinishedAt || startedAt;
  const backendResults = (response.status.results ?? []).map(backendResultToFrontendItem);
  setters.setAutoExecutionCounts({
    delete: response.status.summary.executedDeleteCount ?? 0,
    disable: response.status.summary.executedDisableCount ?? 0,
    enable: response.status.summary.executedEnableCount ?? 0,
  });
  if (backendResults.length > 0 || response.status.lastFinishedAt > 0) {
    setters.setResult({
      settings: {
        baseUrl: '',
        token: '',
        targetType: settings.targetType,
        workers: settings.workers,
        deleteWorkers: settings.deleteWorkers,
        timeout: settings.timeout,
        retries: settings.retries,
        usedPercentThreshold: settings.usedPercentThreshold,
        sampleSize: settings.sampleSize,
      },
      files: [],
      results: backendResults,
      summary: {
        ...response.status.summary,
        usedPercentThreshold: settings.usedPercentThreshold,
        sampled: settings.sampleSize > 0,
        plannedActionPreview: backendResults
          .filter((item) => item.action !== 'keep')
          .slice(0, 10)
          .map((item) => `${formatAccountInspectionIdentity(item)} -> ${item.action}`),
      },
      startedAt,
      finishedAt,
    });
  }
  const backendProgress = response.status.progress;
  const total = backendProgress?.total ?? response.status.summary.sampledCount ?? backendResults.length;
  const isBackendActive = response.status.state === 'running' || response.status.state === 'paused' || response.status.state === 'stopping';
  const completed = backendProgress?.completed ?? (isBackendActive ? 0 : total);
  const inFlight = backendProgress?.inFlight ?? (response.status.state === 'running' ? 1 : 0);
  const pending = backendProgress?.pending ?? Math.max(0, total - completed - inFlight);
  const progressStatus = backendProgressStatus(response.status);
  setters.setProgress({
    total,
    completed,
    inFlight,
    pending,
    percent: total > 0 ? Math.round((completed / total) * 100) : progressStatus === 'completed' ? 100 : 0,
    status: progressStatus,
    summary: response.status.summary,
    startedAt,
    updatedAt: Date.now(),
  });
  setters.setRunStatus?.(backendRunStatus(response.status));
};

export function AccountInspectionPage() {
  const { t, i18n } = useTranslation();
  const config = useConfigStore((state) => state.config);
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);

  const [inspectionSettings, setInspectionSettings] = useState<AccountInspectionConfigurableSettings>(() =>
    loadAccountInspectionConfigurableSettings(config)
  );
  const [settingsDraft, setSettingsDraft] = useState<InspectionSettingsDraft>(() =>
    toSettingsDraft(loadAccountInspectionConfigurableSettings(config))
  );
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft>({ enabled: false, intervalMinutes: '360' });
  const [scheduleResponse, setScheduleResponse] = useState<AccountInspectionScheduleResponse | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [logs, setLogs] = useState<InspectionLogEntry[]>([]);
  const [logsCollapsed, setLogsCollapsed] = useState(false);
  const [runStatus, setRunStatus] = useState<RunStatus>('idle');
  const [progress, setProgress] = useState<AccountInspectionProgressSnapshot>(createIdleProgressSnapshot);
  const [result, setResult] = useState<AccountInspectionRunResult | null>(null);
  const [executing, setExecuting] = useState(false);
  const [exportingAuthFiles, setExportingAuthFiles] = useState(false);
  const [autoExecutionCounts, setAutoExecutionCounts] = useState<AutoExecutionCounts>(emptyAutoExecutionCounts);
  const logListRef = useRef<HTMLDivElement | null>(null);
  const refreshedBackendFinishedAtRef = useRef(0);

  useEffect(() => {
    const nextSettings = loadAccountInspectionConfigurableSettings(config);
    setInspectionSettings(nextSettings);
    if (!isSettingsModalOpen) {
      setSettingsDraft(toSettingsDraft(nextSettings));
    }
  }, [config, isSettingsModalOpen]);

  const applyBackendResponse = useCallback((response: AccountInspectionScheduleResponse) => {
    applyBackendInspectionResponse(response, {
      setInspectionSettings,
      setSettingsDraft,
      setScheduleDraft,
      setScheduleResponse,
      setAutoExecutionCounts: applyIfChanged(setAutoExecutionCounts, sameAutoExecutionCounts),
      setLogs,
      setResult,
      setProgress: applyIfChanged(setProgress, sameProgressSnapshot),
      setRunStatus: applyIfChanged(setRunStatus, sameRunStatus),
    });

    if (
      response.status.state !== 'running' &&
      response.status.state !== 'paused' &&
      response.status.state !== 'stopping' &&
      response.status.lastFinishedAt > 0 &&
      refreshedBackendFinishedAtRef.current !== response.status.lastFinishedAt
    ) {
      refreshedBackendFinishedAtRef.current = response.status.lastFinishedAt;
      quotaPersistenceMiddleware.markStale(response.status.lastFinishedAt);
    }
  }, []);

  const loadBackendSchedule = useCallback(async () => {
    if (connectionStatus !== 'connected') return;
    try {
      const response = await accountInspectionApi.getStatus();
      applyBackendResponse(response);
    } catch {
      setScheduleResponse(null);
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
          setLogs((previous) => [
            ...previous,
            {
              id: `backend-${message.log!.time}-${previous.length}`,
              level: message.log!.level,
              message: message.log!.message,
              timestamp: message.log!.time,
            },
          ]);
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
    setLogs((previous) => [
      ...previous,
      {
        id: `${Date.now()}-${previous.length}`,
        level,
        message,
        timestamp: Date.now(),
      },
    ]);
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
        setLogs([]);
      }
      if (introMessage) {
        appendLog('info', introMessage);
      }

      setResult(null);
      setRunStatus('running');
      setLogsCollapsed(false);
      setAutoExecutionCounts(emptyAutoExecutionCounts());
      setProgress({ ...createIdleProgressSnapshot(), status: 'running', startedAt: Date.now(), updatedAt: Date.now() });

      try {
        const response = await accountInspectionApi.runNow();
        applyBackendResponse(response);
      } catch (error) {
        handleAccountInspectionControlError(error, appendLog, showNotification, t('common.unknown_error'));
        setRunStatus('error');
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
        setAutoExecutionCounts(emptyAutoExecutionCounts());
      })
      .catch((error) => handleAccountInspectionControlError(error, appendLog, showNotification, t('common.unknown_error')));
  }, [appendLog, applyBackendResponse, showNotification, t]);

  const executeItems = useCallback(
    async (items: AccountInspectionResultItem[]) => {
      const currentResult = result;
      if (!currentResult) return;
      const targets = items.filter(isSuggestedAction);
      if (targets.length === 0) {
        showNotification(t('monitoring.account_inspection_no_pending_actions'), 'info');
        return;
      }

      setExecuting(true);
      setLogsCollapsed(false);
      appendLog('info', t('monitoring.account_inspection_execute_started'));

      try {
        const response = await accountInspectionApi.executeActions(targets);
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
        setResult(nextResult);
      } finally {
        setExecuting(false);
      }
    },
    [appendLog, result, showNotification, t]
  );

  const actionableResults = useMemo(
    () => (result ? result.results.filter(isSuggestedAction) : []),
    [result]
  );

  const handleExecutePlanned = useCallback(() => {
    if (!result) return;

    const targets = actionableResults;
    const counts = countActions(targets);
    showConfirmation({
      title: t('monitoring.account_inspection_execute_confirm_title'),
      message: t('monitoring.account_inspection_execute_confirm_body', {
        total: targets.length,
        delete: counts.delete,
        disable: counts.disable,
        enable: counts.enable,
      }),
      confirmText: t('monitoring.account_inspection_execute_now'),
      cancelText: t('common.cancel'),
      variant: 'danger',
      onConfirm: () => executeItems(targets),
    });
  }, [actionableResults, executeItems, result, showConfirmation, t]);

  const handleExecuteSingle = useCallback(
    (item: AccountInspectionResultItem) => {
      const actionLabel = formatActionLabel(item.action, t);
      showConfirmation({
        title: t('monitoring.account_inspection_execute_single_title'),
        message: t('monitoring.account_inspection_execute_single_body', {
          account: formatAccountInspectionIdentity(item),
          action: actionLabel,
        }),
        confirmText: actionLabel,
        cancelText: t('common.cancel'),
        variant: item.action === 'delete' ? 'danger' : 'primary',
        onConfirm: () => executeItems([item]),
      });
    },
    [executeItems, showConfirmation, t]
  );

  const accountSummaryCards = useMemo<SummaryCard[]>(() => {
    const summarySource =
      result?.summary ?? (runStatus === 'running' || runStatus === 'paused' ? progress.summary : null);

    if (!summarySource) {
      return [
        { key: 'total', label: t('monitoring.account_inspection_total_accounts'), value: '--' },
        { key: 'sampled', label: t('monitoring.account_inspection_sampled_accounts'), value: '--' },
        { key: 'enabled', label: t('monitoring.account_inspection_enabled_current_count'), value: '--' },
        { key: 'disabled', label: t('monitoring.account_inspection_disabled_current_count'), value: '--' },
        { key: 'errors', label: t('monitoring.account_inspection_error_count'), value: '--' },
      ];
    }

    return [
      {
        key: 'total',
        label: t('monitoring.account_inspection_total_accounts'),
        value: String(summarySource.probeSetCount),
      },
      {
        key: 'sampled',
        label: t('monitoring.account_inspection_sampled_accounts'),
        value: String(summarySource.sampledCount),
      },
      {
        key: 'enabled',
        label: t('monitoring.account_inspection_enabled_current_count'),
        value: String(summarySource.enabledCount),
        tone: summarySource.enabledCount > 0 ? 'good' : 'neutral',
      },
      {
        key: 'disabled',
        label: t('monitoring.account_inspection_disabled_current_count'),
        value: String(summarySource.disabledCount),
        tone: summarySource.disabledCount > 0 ? 'warn' : 'neutral',
      },
      {
        key: 'errors',
        label: t('monitoring.account_inspection_error_count'),
        value: String(summarySource.errorCount),
        tone: summarySource.errorCount > 0 ? 'bad' : 'neutral',
      },
    ];
  }, [progress.summary, result, runStatus, t]);

  const actionSummaryCards = useMemo<SummaryCard[]>(() => {
    const summarySource =
      result?.summary ?? (runStatus === 'running' || runStatus === 'paused' ? progress.summary : null);
    const hasAutoExecutePolicy = hasAccountInspectionAutoExecutePolicies(inspectionSettings);
    const deleteLabel = hasAutoExecutePolicy
      ? t('monitoring.account_inspection_deleted_count')
      : t('monitoring.account_inspection_delete_count');
    const disableLabel = hasAutoExecutePolicy
      ? t('monitoring.account_inspection_disabled_count')
      : t('monitoring.account_inspection_disable_count');
    const enableLabel = hasAutoExecutePolicy
      ? t('monitoring.account_inspection_enabled_count')
      : t('monitoring.account_inspection_enable_count');

    if (!summarySource) {
      return [
        { key: 'delete', label: deleteLabel, value: '--' },
        { key: 'disable', label: disableLabel, value: '--' },
        { key: 'enable', label: enableLabel, value: '--' },
      ];
    }

    const deleteCount = hasAutoExecutePolicy ? autoExecutionCounts.delete : summarySource.deleteCount;
    const disableCount = hasAutoExecutePolicy ? autoExecutionCounts.disable : summarySource.disableCount;
    const enableCount = hasAutoExecutePolicy ? autoExecutionCounts.enable : summarySource.enableCount;

    return [
      {
        key: 'delete',
        label: deleteLabel,
        value: String(deleteCount),
        tone: deleteCount > 0 ? 'bad' : 'neutral',
      },
      {
        key: 'disable',
        label: disableLabel,
        value: String(disableCount),
        tone: disableCount > 0 ? 'warn' : 'neutral',
      },
      {
        key: 'enable',
        label: enableLabel,
        value: String(enableCount),
        tone: enableCount > 0 ? 'good' : 'neutral',
      },
    ];
  }, [autoExecutionCounts, inspectionSettings, progress.summary, result, runStatus, t]);

  const pendingActionCount = actionableResults.length;
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
    setSettingsDraft(toSettingsDraft(inspectionSettings));
    setIsSettingsModalOpen(true);
  }, [inspectionSettings]);

  const handleSettingsDraftChange = useCallback(
    (field: InspectionSettingsDraftField, value: string) => {
      setSettingsDraft((previous) => ({
        ...previous,
        [field]: value,
      }));
    },
    []
  );

  const handleAutoExecuteQuotaLimitChange = useCallback((value: boolean) => {
    setSettingsDraft((previous) => ({
      ...previous,
      autoExecuteQuotaLimitDisable: value,
    }));
  }, []);

  const handleAutoExecuteQuotaRecoveryChange = useCallback((value: boolean) => {
    setSettingsDraft((previous) => ({
      ...previous,
      autoExecuteQuotaRecoveryEnable: value,
    }));
  }, []);

  const handleAutoExecuteAccountErrorActionChange = useCallback((value: string) => {
    setSettingsDraft((previous) => ({
      ...previous,
      autoExecuteAccountErrorAction:
        value === 'disable' || value === 'delete' ? value : 'none',
    }));
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
    setInspectionSettings(nextSettings);
    setSettingsDraft(toSettingsDraft(nextSettings));
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
              onClick={handleExportAuthFiles}
              loading={exportingAuthFiles}
              disabled={exportingAuthFiles || connectionStatus !== 'connected'}
            >
              {t('monitoring.account_inspection_auth_files_export')}
            </Button>
            <Button
              variant="secondary"
              onClick={openSettingsModal}
              disabled={(runStatus === 'running' || runStatus === 'paused') || executing}
            >
              {t('monitoring.account_inspection_settings_button')}
            </Button>
          </div>
        </div>

        <div className={styles.metaRow}>
          <span className={styles.metaPill}>{`${t('monitoring.account_inspection_target_type')}: ${inspectionSettings.targetType}`}</span>
          <span className={styles.metaPill}>{`${t('monitoring.account_inspection_threshold')}: ${inspectionSettings.usedPercentThreshold}%`}</span>
          <span className={styles.metaPill}>{`${t('monitoring.account_inspection_workers')}: ${inspectionSettings.workers}`}</span>
          <span className={styles.metaPill}>{`${t('monitoring.account_inspection_delete_workers')}: ${inspectionSettings.deleteWorkers}`}</span>
          <span className={styles.metaPill}>{`${t('monitoring.account_inspection_sample_size')}: ${inspectionSettings.sampleSize}`}</span>
          <span className={styles.metaPill}>
            {`${t('monitoring.account_inspection_settings_auto_execute_quota_limit_disable_label')}: ${
              inspectionSettings.autoExecuteQuotaLimitDisable ? t('common.yes') : t('common.no')
            }`}
          </span>
          <span className={styles.metaPill}>
            {`${t('monitoring.account_inspection_settings_auto_execute_quota_recovery_enable_label')}: ${
              inspectionSettings.autoExecuteQuotaRecoveryEnable ? t('common.yes') : t('common.no')
            }`}
          </span>
          <span className={styles.metaPill}>
            {`${t('monitoring.account_inspection_settings_auto_execute_account_error_action_label')}: ${
              t(`monitoring.account_inspection_settings_account_error_action_${inspectionSettings.autoExecuteAccountErrorAction}`)
            }`}
          </span>
          <span className={styles.metaPill}>
            {`${t('monitoring.account_inspection_schedule_status')}: ${
              scheduleResponse?.schedule.enabled ? t('common.yes') : t('common.no')
            }`}
          </span>
          {scheduleResponse?.schedule.enabled ? (
            <span className={styles.metaPill}>
              {`${t('monitoring.account_inspection_schedule_next_run')}: ${
                scheduleResponse.schedule.nextRunAt ? formatTimestamp(scheduleResponse.schedule.nextRunAt, i18n.language) : '--'
              }`}
            </span>
          ) : null}
          <span className={styles.metaPill}>{`${t('monitoring.account_inspection_timeout')}: ${inspectionSettings.timeout}ms`}</span>
        </div>
        <div className={styles.progressSection}>
          <div className={styles.progressHeader}>
            <strong>{t('monitoring.account_inspection_progress_title')}</strong>
            <span>{`${progress.percent}%`}</span>
          </div>
          <div className={styles.progressTrack}>
            <span className={styles.progressBar} style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }} />
          </div>
          <div className={styles.progressFooter}>
            <div className={styles.progressMeta}>
              <span>{progressLabel}</span>
              {runStatus === 'paused' ? <strong>{t('monitoring.account_inspection_paused')}</strong> : null}
            </div>
            <div className={styles.progressActions}>
              <Button
                variant="secondary"
                onClick={handleRunInspection}
                loading={runStatus === 'running'}
                disabled={runStatus === 'running' || executing || connectionStatus !== 'connected'}
              >
                {runStatus === 'paused'
                  ? t('monitoring.account_inspection_resume')
                  : runStatus === 'running'
                    ? t('monitoring.account_inspection_running')
                    : t('monitoring.account_inspection_run')}
              </Button>
              <Button
                variant="secondary"
                onClick={handlePauseInspection}
                disabled={runStatus !== 'running' || executing}
              >
                {t('monitoring.account_inspection_pause')}
              </Button>
              <Button
                variant="danger"
                onClick={handleStopInspection}
                disabled={(runStatus !== 'running' && runStatus !== 'paused') || executing}
              >
                {t('monitoring.account_inspection_stop')}
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <section className={styles.summarySection}>
        <div className={styles.summarySectionHeader}>
          <h2>{t('monitoring.account_inspection_account_summary_title')}</h2>
        </div>
        <div className={styles.summaryGrid}>
          {accountSummaryCards.map((card) => (
            <Card
              key={card.key}
              className={[styles.summaryCard, summaryToneClass[card.tone ?? 'neutral']]
                .filter(Boolean)
                .join(' ')}
            >
              <span>{card.label}</span>
              <strong>{card.value}</strong>
            </Card>
          ))}
        </div>
      </section>

      <section className={styles.summarySection}>
        <div className={styles.summarySectionHeader}>
          <h2>{t('monitoring.account_inspection_action_summary_title')}</h2>
        </div>
        <div className={styles.summaryGridCompact}>
          {actionSummaryCards.map((card) => (
            <Card
              key={card.key}
              className={[styles.summaryCard, summaryToneClass[card.tone ?? 'neutral']]
                .filter(Boolean)
                .join(' ')}
            >
              <span>{card.label}</span>
              <strong>{card.value}</strong>
            </Card>
          ))}
        </div>
      </section>

      <Card className={styles.panel}>
        <div className={styles.panelHeader}>
          <div>
            <h2 className={styles.panelTitle}>{t('monitoring.account_inspection_logs_title')}</h2>
            <p className={styles.panelSubtitle}>{t('monitoring.account_inspection_logs_desc')}</p>
          </div>
          <div className={styles.panelActions}>
            <button
              type="button"
              className={styles.foldButton}
              onClick={() => setLogsCollapsed((previous) => !previous)}
              disabled={logs.length === 0}
            >
              {logsCollapsed ? <IconChevronDown size={16} /> : <IconChevronUp size={16} />}
              <span>
                {logsCollapsed
                  ? t('monitoring.account_inspection_expand_logs')
                  : t('monitoring.account_inspection_fold_logs')}
              </span>
            </button>
          </div>
        </div>

        {!logsCollapsed ? (
          <div ref={logListRef} className={styles.logList}>
            {logs.length > 0 ? (
              logs.map((entry) => (
                <div key={entry.id} className={`${styles.logRow} ${levelClassMap[entry.level]}`}>
                  <span className={styles.logTime}>{formatTimestamp(entry.timestamp, i18n.language)}</span>
                  <span className={styles.logMessage}>{entry.message}</span>
                </div>
              ))
            ) : (
              <div className={styles.emptyBlock}>{t('monitoring.account_inspection_logs_empty')}</div>
            )}
          </div>
        ) : (
          <div className={styles.logCollapsedBar}>
            <span>{t('monitoring.account_inspection_logs_collapsed', { count: logs.length })}</span>
          </div>
        )}
      </Card>

      <Card className={styles.panel}>
        <div className={styles.panelHeader}>
          <div>
            <h2 className={styles.panelTitle}>{t('monitoring.account_inspection_results_title')}</h2>
            <p className={styles.panelSubtitle}>{t('monitoring.account_inspection_results_desc')}</p>
          </div>
          <div className={styles.resultsHeaderActions}>
            {result ? (
              <div className={styles.panelMeta}>
                <span>{`${t('monitoring.last_sync')}: ${formatTimestamp(result.finishedAt, i18n.language)}`}</span>
                <span>{`${t('monitoring.account_inspection_pending_actions')}: ${pendingActionCount}`}</span>
              </div>
            ) : null}
            <Button
              variant="primary"
              size="sm"
              onClick={handleExecutePlanned}
              loading={executing}
              disabled={!result || runStatus === 'running' || executing || pendingActionCount === 0}
            >
              {executing
                ? t('monitoring.account_inspection_executing')
                : t('monitoring.account_inspection_execute_now')}
            </Button>
          </div>
        </div>

        {result ? (
          <>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <colgroup>
                  <col className={styles.accountColumn} />
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
                  {actionableResults.length > 0 ? (
                    actionableResults.map((item) => (
                    <tr key={item.key}>
                      <td>
                        <div className={styles.primaryCell}>
                          <span>{formatAccountInspectionIdentity(item)}</span>
                          <small>{item.provider}</small>
                        </div>
                      </td>
                      <td>{formatCurrentStateLabel(item, t)}</td>
                      <td>{item.statusCode === null ? '--' : item.statusCode}</td>
                      <td>{formatPercent(item.usedPercent)}</td>
                      <td>
                        <span className={`${styles.actionBadge} ${actionToneClass[item.action]}`}>
                          {formatActionLabel(item.action, t)}
                        </span>
                      </td>
                      <td>{item.actionReason}</td>
                      <td className={item.error ? styles.errorText : styles.mutedText}>{item.error || '--'}</td>
                      <td>
                        <Button
                          size="sm"
                          variant={item.action === 'delete' ? 'danger' : 'secondary'}
                          onClick={() => handleExecuteSingle(item)}
                          disabled={runStatus === 'running' || executing}
                        >
                          {formatActionLabel(item.action, t)}
                        </Button>
                      </td>
                    </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={8}>
                        <div className={styles.emptyBlockSmall}>{t('monitoring.account_inspection_no_pending_actions')}</div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className={styles.emptyBlock}>{t('monitoring.account_inspection_empty')}</div>
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
              onChange={(value) => setScheduleDraft((previous) => ({ ...previous, enabled: value }))}
              ariaLabel={t('monitoring.account_inspection_schedule_enabled_label')}
            />
          </div>
          <div className={styles.settingsGrid}>
            <div className={styles.settingsField}>
              <Input
                label={t('monitoring.account_inspection_schedule_interval_label')}
                type="number"
                value={scheduleDraft.intervalMinutes}
                onChange={(event) => setScheduleDraft((previous) => ({ ...previous, intervalMinutes: event.target.value }))}
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
