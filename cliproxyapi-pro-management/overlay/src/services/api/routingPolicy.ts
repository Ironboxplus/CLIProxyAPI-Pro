import { apiClient } from './client';

export const ROUTING_POLICY_PROVIDERS = [
  'antigravity',
  'xai',
  'codex',
  'gemini-cli',
  'gemini',
  'gemini-interactions',
  'vertex',
  'aistudio',
  'claude',
  'kimi',
] as const;

export type RoutingPolicyProvider = (typeof ROUTING_POLICY_PROVIDERS)[number];
export type RoutingProtectionMode = 'observe' | 'enforce';

export interface RoutingPolicyGlobalSettings {
  strategy: 'round-robin' | 'fill-first';
  sessionAffinity: boolean;
  sessionAffinityTTL: string;
  requestRetry: number;
  maxRetryCredentials: number;
  maxRetryInterval: number;
  coolingEnabled: boolean;
  saveCooldownStatus: boolean;
  transientErrorCooldownSeconds: number;
  quotaSwitchProject: boolean;
  quotaSwitchPreviewModel: boolean;
  quotaAntigravityCredits: boolean;
  codexIdentityConfuse: boolean;
}

export interface RoutingProtectionProviderPolicy {
  enabled: boolean;
  statusCodes: number[];
  confirmations: number;
  confirmationWindowSeconds: number;
  autoEnable: boolean;
  fallbackDisableMinutes: number;
  requireQuotaEvidence: boolean;
}

export interface RoutingRequestProtectionConfig {
  enabled: boolean;
  mode: RoutingProtectionMode;
  providers: Record<RoutingPolicyProvider, RoutingProtectionProviderPolicy>;
}

export interface RoutingProtectedAccount {
  provider: string;
  authId: string;
  authIndex: string;
  fileName: string;
  statusCode: number;
  reason: string;
  triggeredAt: number;
  releaseAt: number;
}

export interface RoutingProtectionEvent {
  id: string;
  provider: string;
  authId: string;
  authIndex: string;
  fileName: string;
  statusCode: number;
  mode: RoutingProtectionMode;
  action: 'pending' | 'observe' | 'disabled' | 'released' | 'error' | string;
  reason: string;
  count: number;
  required: number;
  triggeredAt: number;
  releaseAt: number;
}

export interface RoutingPolicyResponse {
  global: RoutingPolicyGlobalSettings;
  requestProtection: RoutingRequestProtectionConfig;
  availableProviders: RoutingPolicyProvider[];
  active: RoutingProtectedAccount[];
  recentEvents: RoutingProtectionEvent[];
}

export interface RoutingPolicyUpdate {
  global: RoutingPolicyGlobalSettings;
  requestProtection: RoutingRequestProtectionConfig;
}

type RoutingPolicyRawResponse = Omit<
  RoutingPolicyResponse,
  'availableProviders' | 'active' | 'recentEvents'
> & {
  availableProviders?: string[] | null;
  active?: RoutingProtectedAccount[] | null;
  recentEvents?: RoutingProtectionEvent[] | null;
};

const isRoutingPolicyProvider = (provider: string): provider is RoutingPolicyProvider =>
  ROUTING_POLICY_PROVIDERS.some((candidate) => candidate === provider);

const normalizeRoutingPolicyResponse = (
  response: RoutingPolicyRawResponse
): RoutingPolicyResponse => ({
  ...response,
  availableProviders: Array.isArray(response.availableProviders)
    ? response.availableProviders.filter(isRoutingPolicyProvider)
    : [...ROUTING_POLICY_PROVIDERS],
  active: Array.isArray(response.active) ? response.active : [],
  recentEvents: Array.isArray(response.recentEvents) ? response.recentEvents : [],
});

export const routingPolicyApi = {
  async get(): Promise<RoutingPolicyResponse> {
    return normalizeRoutingPolicyResponse(
      await apiClient.get<RoutingPolicyRawResponse>('/routing-policy')
    );
  },
  async update(payload: RoutingPolicyUpdate): Promise<RoutingPolicyResponse> {
    return normalizeRoutingPolicyResponse(
      await apiClient.put<RoutingPolicyRawResponse>('/routing-policy', payload)
    );
  },
  async release(authIndex: string): Promise<RoutingPolicyResponse> {
    return normalizeRoutingPolicyResponse(
      await apiClient.post<RoutingPolicyRawResponse>('/routing-policy/release', { authIndex })
    );
  },
};
