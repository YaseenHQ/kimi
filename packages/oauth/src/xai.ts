/**
 * xAI OAuth protocol adapter.
 *
 * The endpoint behavior is adapted from pi's xAI device-code flow, while
 * lifecycle, persistence, locking, and UI orchestration remain owned by Kimi
 * Code's existing OAuthManager and callers.
 */

import {
  OAuthConnectionError,
  OAuthError,
  OAuthUnauthorizedError,
  RetryableRefreshError,
} from './errors';
import type { DevicePollResult } from './oauth';
import type { DeviceAuthorization, OAuthFlowConfig, TokenInfo } from './types';
import { isRecord } from './utils';

export const XAI_PROVIDER_NAME = 'xai';
export const XAI_API_BASE_URL = 'https://api.x.ai/v1';
export const XAI_OAUTH_KEY = 'oauth/xai';

export const XAI_OAUTH_FLOW_CONFIG: OAuthFlowConfig = {
  name: XAI_PROVIDER_NAME,
  oauthHost: 'https://auth.x.ai/oauth2',
  clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
};

const XAI_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const DEFAULT_INTERVAL_SECONDS = 5;

/**
 * xAI models that speak the OpenAI Responses API (`/v1/responses`). All other
 * xAI models speak Chat Completions (`/v1/chat/completions`). models.dev does
 * not expose per-model wire type, so this mirrors pi's authoritative table at
 * references/pi/packages/ai/src/providers/xai.models.ts.
 *
 * Update this set when xAI ships a new Responses-speaking model.
 */
const XAI_RESPONSES_MODELS: ReadonlySet<string> = new Set(['grok-4.5']);

/** Resolve the kosong wire type for an xAI model id. */
export function xaiWireTypeForModel(modelId: string): 'openai' | 'openai_responses' {
  return XAI_RESPONSES_MODELS.has(modelId) ? 'openai_responses' : 'openai';
}
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;
const HTTP_TIMEOUT_MS = 30_000;

interface XaiHttpResponse {
  readonly status: number;
  readonly data: Record<string, unknown>;
}

async function postForm(
  url: string,
  fields: Record<string, string>,
): Promise<XaiHttpResponse> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(fields),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    throw new OAuthConnectionError(`xAI OAuth request to ${url} failed.`, { cause: error });
  }

  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (isRecord(parsed)) data = parsed;
  } catch {
    throw new OAuthError(`xAI OAuth returned invalid JSON (HTTP ${response.status}).`);
  }
  return { status: response.status, data };
}

function requiredString(data: Record<string, unknown>, field: string): string {
  const value = data[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new OAuthError(`xAI OAuth response missing ${field}.`);
  }
  return value;
}

function positiveNumber(data: Record<string, unknown>, field: string): number {
  const value = data[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new OAuthError(`xAI OAuth response missing or invalid ${field}.`);
  }
  return value;
}

function verificationUrl(data: Record<string, unknown>, field: string): string {
  const value = requiredString(data, field);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthError('xAI OAuth returned an untrusted verification URL.');
  }
  if (url.protocol !== 'https:') {
    throw new OAuthError('xAI OAuth returned an untrusted verification URL.');
  }
  return url.href;
}

function failureMessage(action: string, response: XaiHttpResponse): string {
  const error = typeof response.data['error'] === 'string' ? response.data['error'] : undefined;
  const description =
    typeof response.data['error_description'] === 'string'
      ? response.data['error_description']
      : undefined;
  const detail = [error, description].filter(Boolean).join(': ');
  return `xAI OAuth ${action} failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`;
}

function tokenFromResponse(
  data: Record<string, unknown>,
  previousRefreshToken?: string,
): TokenInfo {
  const accessToken = requiredString(data, 'access_token');
  const refreshToken =
    data['refresh_token'] === undefined && previousRefreshToken !== undefined
      ? previousRefreshToken
      : requiredString(data, 'refresh_token');
  const expiresIn =
    data['expires_in'] === undefined
      ? DEFAULT_TOKEN_LIFETIME_SECONDS
      : positiveNumber(data, 'expires_in');
  return {
    accessToken,
    refreshToken,
    // Kimi's OAuthManager owns early-refresh policy through its dynamic
    // threshold. Persist the provider-reported lifetime without pi's skew.
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    expiresIn,
    scope: typeof data['scope'] === 'string' ? data['scope'] : '',
    tokenType: typeof data['token_type'] === 'string' ? data['token_type'] : 'Bearer',
  };
}

export async function requestXaiDeviceAuthorization(
  config: OAuthFlowConfig,
): Promise<DeviceAuthorization> {
  const response = await postForm(`${config.oauthHost.replace(/\/+$/, '')}/device/code`, {
    client_id: config.clientId,
    scope: XAI_SCOPE,
    referrer: 'pi',
  });
  if (response.status < 200 || response.status >= 300) {
    throw new OAuthError(failureMessage('device authorization', response));
  }

  const verificationUri = verificationUrl(response.data, 'verification_uri');
  const complete = response.data['verification_uri_complete'];
  const interval = response.data['interval'];
  return {
    userCode: requiredString(response.data, 'user_code'),
    deviceCode: requiredString(response.data, 'device_code'),
    verificationUri,
    verificationUriComplete:
      typeof complete === 'string' && complete.length > 0
        ? verificationUrl(response.data, 'verification_uri_complete')
        : verificationUri,
    expiresIn: positiveNumber(response.data, 'expires_in'),
    interval:
      typeof interval === 'number' && Number.isFinite(interval) && interval > 0
        ? interval
        : DEFAULT_INTERVAL_SECONDS,
  };
}

export async function pollXaiDeviceToken(
  config: OAuthFlowConfig,
  deviceCode: string,
): Promise<DevicePollResult> {
  const response = await postForm(`${config.oauthHost.replace(/\/+$/, '')}/token`, {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: config.clientId,
    device_code: deviceCode,
  });
  if (response.status >= 200 && response.status < 300) {
    return { kind: 'success', token: tokenFromResponse(response.data) };
  }

  const error = response.data['error'];
  const description =
    typeof response.data['error_description'] === 'string'
      ? response.data['error_description']
      : '';
  if (error === 'authorization_pending' || error === 'slow_down') {
    return { kind: 'pending', errorCode: error, description };
  }
  if (error === 'expired_token') return { kind: 'expired' };
  if (error === 'access_denied' || error === 'authorization_denied') {
    return { kind: 'denied', description };
  }
  throw new OAuthError(failureMessage('device token polling', response));
}

export async function refreshXaiAccessToken(
  config: OAuthFlowConfig,
  refreshToken: string,
): Promise<TokenInfo> {
  const response = await postForm(`${config.oauthHost.replace(/\/+$/, '')}/token`, {
    grant_type: 'refresh_token',
    client_id: config.clientId,
    refresh_token: refreshToken,
  });
  if (response.status >= 200 && response.status < 300) {
    return tokenFromResponse(response.data, refreshToken);
  }
  const message = failureMessage('token refresh', response);
  if (response.status === 401 || response.status === 403) {
    throw new OAuthUnauthorizedError(message);
  }
  if (response.status === 429 || response.status >= 500) {
    throw new RetryableRefreshError(message);
  }
  throw new OAuthError(message);
}
