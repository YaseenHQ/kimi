/** GitHub Copilot device-code OAuth adapter, with GitHub Enterprise (GHES) support. */

import { OAuthConnectionError, OAuthError, OAuthUnauthorizedError, RetryableRefreshError } from './errors';
import type { DevicePollResult } from './oauth';
import type { DeviceAuthorization, OAuthFlowConfig, TokenInfo } from './types';
import { isRecord } from './utils';

export const GITHUB_COPILOT_PROVIDER_NAME = 'github-copilot';
export const GITHUB_COPILOT_OAUTH_KEY = 'oauth/github-copilot';
export const GITHUB_COPILOT_API_BASE_URL = 'https://api.individual.githubcopilot.com';
export const GITHUB_COPILOT_OAUTH_FLOW_CONFIG: OAuthFlowConfig = {
  name: GITHUB_COPILOT_PROVIDER_NAME,
  oauthHost: 'https://github.com',
  clientId: 'Iv1.b507a08c87ecfe98',
};

const COPILOT_HEADERS = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
} as const;
const COPILOT_API_VERSION = '2026-06-01';
const DEFAULT_DOMAIN = 'github.com';

/**
 * Resolve the GitHub hostname for OAuth endpoints from a raw user input or the
 * flow config's `oauthHost`. Returns a bare hostname (e.g. `github.com` or
 * `company.ghe.com`) so it can be templated into both `github.com/login/...`
 * and `api.github.com/...` endpoints. Returns `null` for empty/invalid input.
 */
export function normalizeGitHubDomain(input: string | undefined): string | null {
  if (input === undefined) return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  // Strip a scheme if present so the URL constructor treats it as absolute.
  const candidate = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
  try {
    const hostname = new URL(candidate).hostname;
    return hostname.length > 0 ? hostname : null;
  } catch {
    return null;
  }
}

/** Resolve `github.com` vs an enterprise hostname from the flow config. */
function domainFromConfig(config: OAuthFlowConfig): string {
  return normalizeGitHubDomain(config.oauthHost) ?? DEFAULT_DOMAIN;
}

/** Templated endpoint set for a given domain (public or enterprise). */
function githubUrls(domain: string): {
  readonly deviceCodeUrl: string;
  readonly accessTokenUrl: string;
  readonly copilotTokenUrl: string;
} {
  return {
    deviceCodeUrl: `https://${domain}/login/device/code`,
    accessTokenUrl: `https://${domain}/login/oauth/access_token`,
    copilotTokenUrl: `https://api.${domain}/copilot_internal/v2/token`,
  };
}

/**
 * Resolve the Copilot models API base URL for a request:
 *   1. If the short-lived Copilot token carries a `proxy-ep` segment, derive
 *      `api.<host>` from it (the public individual routing).
 *   2. Else for an enterprise domain, use `copilot-api.<domain>` (GHES
 *      convention; differs from the api.<domain> token endpoint).
 *   3. Else the public default.
 *
 * Re-derived per request so a token refresh that rotates `proxy-ep` does not
 * strand requests on a dead proxy (the persisted config baseUrl is a fallback
 * only).
 */
export function githubCopilotApiBaseUrl(
  accessToken?: string | undefined,
  enterpriseDomain?: string | undefined,
): string {
  const proxyHost = accessToken?.match(/(?:^|;)proxy-ep=([^;]+)/)?.[1];
  if (proxyHost !== undefined && proxyHost.length > 0) {
    return `https://${proxyHost.replace(/^proxy\./, 'api.')}`;
  }
  if (enterpriseDomain !== undefined && enterpriseDomain.length > 0) {
    return `https://copilot-api.${enterpriseDomain}`;
  }
  return GITHUB_COPILOT_API_BASE_URL;
}

async function request(url: string, init: RequestInit): Promise<{ status: number; data: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new OAuthConnectionError(`GitHub Copilot OAuth request to ${url} failed.`, { cause: error });
  }
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (isRecord(parsed)) data = parsed;
  } catch {
    // Callers provide a status-aware error.
  }
  return { status: response.status, data };
}

function requiredString(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value !== 'string' || value.length === 0) throw new OAuthError(`GitHub OAuth response missing ${key}.`);
  return value;
}

/** Exchange the (long-lived) GitHub OAuth token for a short-lived Copilot token. */
async function exchangeCopilotToken(githubToken: string, domain: string): Promise<TokenInfo> {
  const urls = githubUrls(domain);
  const response = await request(urls.copilotTokenUrl, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${githubToken}`, ...COPILOT_HEADERS },
  });
  if (response.status < 200 || response.status >= 300) {
    const message = `GitHub Copilot token exchange failed (HTTP ${response.status}).`;
    if (response.status === 401 || response.status === 403) throw new OAuthUnauthorizedError(message);
    if (response.status === 429 || response.status >= 500) throw new RetryableRefreshError(message);
    throw new OAuthError(message);
  }
  const expiresAt = response.data['expires_at'];
  if (typeof expiresAt !== 'number') throw new OAuthError('GitHub Copilot token response missing expires_at.');
  const now = Math.floor(Date.now() / 1000);
  return {
    accessToken: requiredString(response.data, 'token'),
    refreshToken: githubToken,
    expiresAt,
    expiresIn: Math.max(1, expiresAt - now),
    scope: '',
    tokenType: 'Bearer',
  };
}

export async function requestGitHubCopilotDeviceAuthorization(
  config: OAuthFlowConfig,
): Promise<DeviceAuthorization> {
  const urls = githubUrls(domainFromConfig(config));
  const response = await request(urls.deviceCodeUrl, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', ...COPILOT_HEADERS },
    body: new URLSearchParams({ client_id: config.clientId, scope: 'read:user' }),
  });
  if (response.status < 200 || response.status >= 300) throw new OAuthError(`GitHub device authorization failed (HTTP ${response.status}).`);
  const verificationUri = requiredString(response.data, 'verification_uri');
  const expiresIn = response.data['expires_in'];
  const interval = response.data['interval'];
  return {
    userCode: requiredString(response.data, 'user_code'),
    deviceCode: requiredString(response.data, 'device_code'),
    verificationUri,
    verificationUriComplete: verificationUri,
    expiresIn: typeof expiresIn === 'number' ? expiresIn : 900,
    interval: typeof interval === 'number' ? interval : 5,
  };
}

export async function pollGitHubCopilotDeviceToken(
  config: OAuthFlowConfig,
  deviceCode: string,
): Promise<DevicePollResult> {
  const urls = githubUrls(domainFromConfig(config));
  const response = await request(urls.accessTokenUrl, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', ...COPILOT_HEADERS },
    body: new URLSearchParams({
      client_id: config.clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  const error = response.data['error'];
  if (error === 'authorization_pending' || error === 'slow_down') {
    return { kind: 'pending', errorCode: error, description: '' };
  }
  if (error === 'expired_token') return { kind: 'expired' };
  if (error === 'access_denied') return { kind: 'denied', description: '' };
  if (response.status < 200 || response.status >= 300 || typeof error === 'string') {
    throw new OAuthError(`GitHub device token polling failed (HTTP ${response.status}).`);
  }
  return { kind: 'success', token: await exchangeCopilotToken(requiredString(response.data, 'access_token'), domainFromConfig(config)) };
}

export async function refreshGitHubCopilotAccessToken(
  config: OAuthFlowConfig,
  githubToken: string,
): Promise<TokenInfo> {
  return exchangeCopilotToken(githubToken, domainFromConfig(config));
}

export function githubCopilotRequestHeaders(accessToken: string): Record<string, string> {
  return {
    ...COPILOT_HEADERS,
    Authorization: `Bearer ${accessToken}`,
    'X-GitHub-Api-Version': COPILOT_API_VERSION,
  };
}

/**
 * POST the chat-policy acceptance for one Copilot model. Some models (Claude,
 * Grok via Copilot) require this one-time enablement before they can be used.
 * Best-effort: swallows network/HTTP errors and returns false. Mirrors pi's
 * `enableGitHubCopilotModel` (references/pi/.../github-copilot.ts:294-312).
 */
export async function enableGitHubCopilotModel(
  accessToken: string,
  modelId: string,
  enterpriseDomain?: string | undefined,
): Promise<boolean> {
  const baseUrl = githubCopilotApiBaseUrl(accessToken, enterpriseDomain);
  try {
    const response = await fetch(`${baseUrl}/models/${encodeURIComponent(modelId)}/policy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        ...COPILOT_HEADERS,
        'openai-intent': 'chat-policy',
        'x-interaction-type': 'chat-policy',
      },
      body: JSON.stringify({ state: 'enabled' }),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Fire-and-forget policy enablement over a set of model ids. Should be called
 * BEFORE discovery filtering: the discovery call (`fetchGitHubCopilotModelIds`)
 * drops models whose `policy.state === 'disabled'`, so enabling must run first
 * or gated models never enter the provisioned set. Swallows per-model failures.
 */
export async function enableGitHubCopilotModelsForIds(
  accessToken: string,
  modelIds: readonly string[],
  enterpriseDomain?: string | undefined,
): Promise<void> {
  await Promise.all(
    modelIds.map((id) => enableGitHubCopilotModel(accessToken, id, enterpriseDomain)),
  );
}

/** Fetch the raw model list from the Copilot `/models` endpoint (no policy filter). */
export async function fetchGitHubCopilotRawModelIds(
  accessToken: string,
  enterpriseDomain?: string | undefined,
  signal?: AbortSignal | undefined,
): Promise<readonly string[]> {
  const baseUrl = githubCopilotApiBaseUrl(accessToken, enterpriseDomain);
  const response = await request(`${baseUrl}/models`, {
    headers: { Accept: 'application/json', ...githubCopilotRequestHeaders(accessToken) },
    signal,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new OAuthError(`GitHub Copilot model discovery failed (HTTP ${response.status}).`);
  }
  const data = response.data['data'];
  if (!Array.isArray(data)) throw new OAuthError('GitHub Copilot model discovery returned invalid data.');
  const ids: string[] = [];
  for (const value of data) {
    if (isRecord(value) && typeof value['id'] === 'string') {
      ids.push(value['id']);
    }
  }
  return ids;
}

export async function fetchGitHubCopilotModelIds(
  accessToken: string,
  signal?: AbortSignal | undefined,
  enterpriseDomain?: string | undefined,
): Promise<readonly string[]> {
  const baseUrl = githubCopilotApiBaseUrl(accessToken, enterpriseDomain);
  const response = await request(`${baseUrl}/models`, {
    headers: { Accept: 'application/json', ...githubCopilotRequestHeaders(accessToken) },
    signal,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new OAuthError(`GitHub Copilot model discovery failed (HTTP ${response.status}).`);
  }
  const data = response.data['data'];
  if (!Array.isArray(data)) throw new OAuthError('GitHub Copilot model discovery returned invalid data.');
  const ids: string[] = [];
  for (const value of data) {
    if (!isRecord(value) || typeof value['id'] !== 'string') continue;
    const policy = isRecord(value['policy']) ? value['policy'] : undefined;
    const capabilities = isRecord(value['capabilities']) ? value['capabilities'] : undefined;
    const supports = isRecord(capabilities?.['supports']) ? capabilities['supports'] : undefined;
    if (
      value['model_picker_enabled'] === true &&
      policy?.['state'] !== 'disabled' &&
      supports?.['tool_calls'] !== false
    ) {
      ids.push(value['id']);
    }
  }
  return ids;
}
