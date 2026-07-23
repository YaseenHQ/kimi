/** OpenAI Codex (ChatGPT account) OAuth adapter: device-code and browser (PKCE) flows. */

import {
  OAuthConnectionError,
  OAuthError,
  OAuthUnauthorizedError,
  RetryableRefreshError,
} from './errors';
import { runOAuthCallbackServer, type CallbackServerHandle } from './callback-server';
import { generatePKCE } from './pkce';
import type { BrowserAuthorization } from './anthropic';
import type { DevicePollResult } from './oauth';
import type { DeviceAuthorization, OAuthFlowConfig, TokenInfo } from './types';
import { isRecord } from './utils';

export const OPENAI_CODEX_PROVIDER_NAME = 'openai-codex';
export const OPENAI_CODEX_API_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const OPENAI_CODEX_OAUTH_KEY = 'oauth/openai-codex';
export const OPENAI_CODEX_OAUTH_FLOW_CONFIG: OAuthFlowConfig = {
  name: OPENAI_CODEX_PROVIDER_NAME,
  oauthHost: 'https://auth.openai.com',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
};

export interface OpenAICodexConfigShape {
  providers: Record<string, unknown>;
  models?: Record<string, unknown>;
  defaultModel?: string;
  thinking?: { enabled?: boolean; effort?: string; [key: string]: unknown };
}

const OPENAI_CODEX_MODELS = [
  ['gpt-5.3-codex-spark', 'GPT-5.3 Codex Spark', 128_000, false, false],
  ['gpt-5.4', 'GPT-5.4', 272_000, true, true],
  ['gpt-5.4-mini', 'GPT-5.4 mini', 272_000, true, true],
  ['gpt-5.5', 'GPT-5.5', 272_000, true, true],
  ['gpt-5.6-luna', 'GPT-5.6 Luna', 272_000, true, true],
  ['gpt-5.6-sol', 'GPT-5.6 Sol', 272_000, true, true],
  ['gpt-5.6-terra', 'GPT-5.6 Terra', 272_000, true, true],
] as const;

/** Apply Pi's explicit ChatGPT Codex model list to Kimi's existing config shape. */
export function applyOpenAICodexConfig(
  config: OpenAICodexConfigShape,
  options: {
    readonly preserveDefaultModel?: boolean;
    readonly oauthRef?: { readonly storage: 'file' | 'keyring'; readonly key: string };
  } = {},
): { readonly defaultModel: string; readonly defaultThinking: boolean } {
  config.providers[OPENAI_CODEX_PROVIDER_NAME] = {
    type: 'openai_responses',
    baseUrl: OPENAI_CODEX_API_BASE_URL,
    oauth: options.oauthRef ?? { storage: 'file', key: OPENAI_CODEX_OAUTH_KEY },
  };
  const aliases = config.models ?? {};
  for (const [alias, value] of Object.entries(aliases)) {
    if (
      isRecord(value) &&
      value['provider'] === OPENAI_CODEX_PROVIDER_NAME
    ) {
      delete aliases[alias];
    }
  }
  for (const [id, name, context, image, dynamicTools] of OPENAI_CODEX_MODELS) {
    const efforts = id.includes('5.6')
      ? ['low', 'medium', 'high', 'xhigh', 'max']
      : ['low', 'medium', 'high', 'xhigh'];
    aliases[`${OPENAI_CODEX_PROVIDER_NAME}/${id}`] = {
      provider: OPENAI_CODEX_PROVIDER_NAME,
      model: id,
      displayName: name,
      maxContextSize: context,
      maxOutputSize: 128_000,
      capabilities: [
        ...(image ? ['image_in'] : []),
        'thinking',
        'tool_use',
        ...(dynamicTools ? ['dynamically_loaded_tools'] : []),
      ],
      supportEfforts: efforts,
      defaultEffort: 'medium',
    };
  }
  config.models = aliases;

  const configuredDefault = config.defaultModel;
  const preserve =
    options.preserveDefaultModel === true &&
    configuredDefault !== undefined &&
    aliases[configuredDefault] !== undefined;
  const defaultModel = preserve
    ? configuredDefault
    : `${OPENAI_CODEX_PROVIDER_NAME}/gpt-5.4`;
  if (!preserve) {
    config.defaultModel = defaultModel;
    config.thinking = { ...config.thinking, enabled: true, effort: 'medium' };
  }
  return { defaultModel, defaultThinking: config.thinking?.enabled ?? false };
}

const DEVICE_VERIFICATION_URI = 'https://auth.openai.com/codex/device';
const DEVICE_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback';
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;
const DEFAULT_INTERVAL_SECONDS = 5;
const HTTP_TIMEOUT_MS = 30_000;
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';

// Browser (authorization-code + PKCE) flow constants. The local server on
// :1455 captures the redirect; the authorize URL uses the shared CLIENT_ID,
// whose OpenAI-side allowlist is keyed on the `originator` value pi uses
// ('pi'), so we keep it rather than risk a rejection with 'kimi-code'.
const BROWSER_CALLBACK_HOST = '127.0.0.1';
const BROWSER_CALLBACK_PORT = 1455;
const BROWSER_CALLBACK_PATH = '/auth/callback';
const BROWSER_REDIRECT_URI = `http://localhost:${BROWSER_CALLBACK_PORT}${BROWSER_CALLBACK_PATH}`;
const BROWSER_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const BROWSER_SCOPE = 'openid profile email offline_access';

interface HttpResponse {
  readonly status: number;
  readonly data: Record<string, unknown>;
}

interface DeviceState {
  readonly deviceAuthId: string;
  readonly userCode: string;
}

async function postJson(url: string, body: Record<string, string>): Promise<HttpResponse> {
  return request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
}

async function postForm(url: string, body: Record<string, string>): Promise<HttpResponse> {
  return request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(body),
  });
}

async function request(url: string, init: RequestInit): Promise<HttpResponse> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (error) {
    throw new OAuthConnectionError(`OpenAI Codex OAuth request to ${url} failed.`, {
      cause: error,
    });
  }
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (isRecord(parsed)) data = parsed;
  } catch {
    // The status-aware caller reports a useful error for non-JSON responses.
  }
  return { status: response.status, data };
}

function requiredString(data: Record<string, unknown>, field: string): string {
  const value = data[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new OAuthError(`OpenAI Codex OAuth response missing ${field}.`);
  }
  return value;
}

function failureMessage(action: string, response: HttpResponse): string {
  const error = response.data['error'];
  const code =
    typeof error === 'string'
      ? error
      : isRecord(error) && typeof error['code'] === 'string'
        ? error['code']
        : undefined;
  const description =
    typeof response.data['error_description'] === 'string'
      ? response.data['error_description']
      : undefined;
  const detail = [code, description].filter(Boolean).join(': ');
  return `OpenAI Codex OAuth ${action} failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`;
}

function tokenFromResponse(data: Record<string, unknown>, previousRefreshToken?: string): TokenInfo {
  const accessToken = requiredString(data, 'access_token');
  const refreshToken =
    data['refresh_token'] === undefined && previousRefreshToken !== undefined
      ? previousRefreshToken
      : requiredString(data, 'refresh_token');
  const expiresIn = Number(data['expires_in']);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new OAuthError('OpenAI Codex OAuth response missing or invalid expires_in.');
  }
  return {
    accessToken,
    refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    expiresIn,
    scope: typeof data['scope'] === 'string' ? data['scope'] : '',
    tokenType: typeof data['token_type'] === 'string' ? data['token_type'] : 'Bearer',
  };
}

function encodeDeviceState(state: DeviceState): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

function decodeDeviceState(value: string): DeviceState {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      isRecord(parsed) &&
      typeof parsed['deviceAuthId'] === 'string' &&
      typeof parsed['userCode'] === 'string'
    ) {
      return { deviceAuthId: parsed['deviceAuthId'], userCode: parsed['userCode'] };
    }
  } catch {
    // Fall through to the protocol error below.
  }
  throw new OAuthError('OpenAI Codex OAuth device state is invalid.');
}

export async function requestOpenAICodexDeviceAuthorization(
  config: OAuthFlowConfig,
): Promise<DeviceAuthorization> {
  const response = await postJson(`${config.oauthHost}/api/accounts/deviceauth/usercode`, {
    client_id: config.clientId,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new OAuthError(failureMessage('device authorization', response));
  }
  const interval = Number(response.data['interval']);
  const state = {
    deviceAuthId: requiredString(response.data, 'device_auth_id'),
    userCode: requiredString(response.data, 'user_code'),
  };
  return {
    userCode: state.userCode,
    deviceCode: encodeDeviceState(state),
    verificationUri: DEVICE_VERIFICATION_URI,
    verificationUriComplete: DEVICE_VERIFICATION_URI,
    expiresIn: DEVICE_CODE_TIMEOUT_SECONDS,
    interval:
      Number.isFinite(interval) && interval >= 0 ? interval : DEFAULT_INTERVAL_SECONDS,
  };
}

export async function pollOpenAICodexDeviceToken(
  config: OAuthFlowConfig,
  encodedState: string,
): Promise<DevicePollResult> {
  const state = decodeDeviceState(encodedState);
  const response = await postJson(`${config.oauthHost}/api/accounts/deviceauth/token`, {
    device_auth_id: state.deviceAuthId,
    user_code: state.userCode,
  });
  if (response.status === 403 || response.status === 404) {
    return { kind: 'pending', errorCode: 'authorization_pending', description: '' };
  }
  if (response.status < 200 || response.status >= 300) {
    const error = response.data['error'];
    const errorCode =
      typeof error === 'string'
        ? error
        : isRecord(error) && typeof error['code'] === 'string'
          ? error['code']
          : 'unknown_error';
    if (errorCode === 'deviceauth_authorization_pending' || errorCode === 'slow_down') {
      return { kind: 'pending', errorCode, description: '' };
    }
    throw new OAuthError(failureMessage('device token polling', response));
  }

  const exchange = await postForm(`${config.oauthHost}/oauth/token`, {
    grant_type: 'authorization_code',
    client_id: config.clientId,
    code: requiredString(response.data, 'authorization_code'),
    code_verifier: requiredString(response.data, 'code_verifier'),
    redirect_uri: DEVICE_REDIRECT_URI,
  });
  if (exchange.status < 200 || exchange.status >= 300) {
    throw new OAuthError(failureMessage('token exchange', exchange));
  }
  return { kind: 'success', token: tokenFromResponse(exchange.data) };
}

export async function refreshOpenAICodexAccessToken(
  config: OAuthFlowConfig,
  refreshToken: string,
): Promise<TokenInfo> {
  const response = await postForm(`${config.oauthHost}/oauth/token`, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId,
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

/**
 * Browser (authorization-code + PKCE) login for OpenAI Codex. Starts a local
 * callback server on :1455, hands the authorize URL to the caller (which opens
 * a browser and shows a manual-paste fallback), then races the server capture
 * against the manual paste. Distinct from the device flow: the redirect_uri is
 * the loopback, and the PKCE verifier is generated locally.
 *
 * This function owns the server lifecycle and the race. The `authorize`
 * callback shows the URL + a manual-paste dialog and returns the pasted value
 * (or `undefined` if the user cancels); the `signal` on the authorization
 * object is aborted when the server wins, so the caller can unmount the dialog.
 * The winner's code is exchanged directly — no stringification round-trip.
 */
export async function loginOpenAICodexBrowser(
  authorize: (authorization: BrowserAuthorization) => Promise<string | undefined>,
  signal?: AbortSignal | undefined,
): Promise<TokenInfo> {
  const { verifier, challenge } = await generatePKCE();
  // 16-byte hex state. (pi uses node:crypto.randomBytes; Web Crypto equivalent.)
  const stateBytes = new Uint8Array(16);
  crypto.getRandomValues(stateBytes);
  const state = Array.from(stateBytes, (b) => b.toString(16).padStart(2, '0')).join('');

  let server: CallbackServerHandle;
  try {
    server = await runOAuthCallbackServer({
      host: BROWSER_CALLBACK_HOST,
      port: BROWSER_CALLBACK_PORT,
      path: BROWSER_CALLBACK_PATH,
      expectedState: state,
      successMessage: 'OpenAI authentication completed. You can close this window.',
      providerLabel: 'OpenAI Codex',
    });
  } catch {
    // EADDRINUSE / other bind failure: re-throw so the chooser can fall back
    // to device-code.
    throw new OAuthError(
      `OpenAI Codex browser login could not start the local callback server on port ${BROWSER_CALLBACK_PORT}. Use device-code login instead.`,
    );
  }

  // Per-flow abort: aborted when the server captures the code, so the caller's
  // manual-paste dialog resolves and unmounts.
  const manualAbort = new AbortController();
  const externalSignal = signal;
  if (externalSignal !== undefined) {
    if (externalSignal.aborted) manualAbort.abort();
    else externalSignal.addEventListener('abort', () => manualAbort.abort(), { once: true });
  }

  try {
    externalSignal?.throwIfAborted();
    const url = new URL(BROWSER_AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', OPENAI_CODEX_OAUTH_FLOW_CONFIG.clientId);
    url.searchParams.set('redirect_uri', BROWSER_REDIRECT_URI);
    url.searchParams.set('scope', BROWSER_SCOPE);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    url.searchParams.set('id_token_add_organizations', 'true');
    url.searchParams.set('codex_cli_simplified_flow', 'true');
    // originator matches the value the shared CLIENT_ID is registered under;
    // do not change to 'kimi-code' without verifying OpenAI's allowlist.
    url.searchParams.set('originator', 'pi');

    // Race: server capture vs manual paste. The server arm resolves the
    // structured { code }; the manual arm resolves a pasted string (or
    // undefined on cancel). Whichever wins, the other is torn down.
    const serverPromise = server.waitForCode();
    const manualPromise = authorize({
      url: url.toString(),
      instructions:
        'Complete login in your browser. If it does not close automatically, paste the final redirect URL here.',
      placeholder: BROWSER_REDIRECT_URI,
      signal: manualAbort.signal,
    });

    const winner = await Promise.race([
      serverPromise.then((result) => ({ kind: 'server' as const, result })),
      manualPromise.then((input) => ({ kind: 'manual' as const, input })),
    ]);

    if (winner.kind === 'server' && winner.result !== null) {
      manualAbort.abort();
      return await exchangeBrowserCode(winner.result.code, verifier);
    }
    // Server lost/cancelled or returned null — use the manual paste.
    const manualInput = winner.kind === 'manual' ? winner.input : await manualPromise;
    externalSignal?.throwIfAborted();
    if (manualInput === undefined || manualInput.length === 0) {
      throw new OAuthError('OpenAI Codex login cancelled.');
    }
    const code = extractCode(manualInput);
    if (code === undefined) throw new OAuthError('OpenAI Codex authorization code is missing.');
    return await exchangeBrowserCode(code, verifier);
  } finally {
    manualAbort.abort();
    server.cancelWait();
    server.close();
  }
}

/** Exchange an authorization code (from browser capture or paste) for tokens. */
async function exchangeBrowserCode(code: string, verifier: string): Promise<TokenInfo> {
  const exchange = await postForm(`${OPENAI_CODEX_OAUTH_FLOW_CONFIG.oauthHost}/oauth/token`, {
    grant_type: 'authorization_code',
    client_id: OPENAI_CODEX_OAUTH_FLOW_CONFIG.clientId,
    code,
    code_verifier: verifier,
    redirect_uri: BROWSER_REDIRECT_URI,
  });
  if (exchange.status < 200 || exchange.status >= 300) {
    throw new OAuthError(failureMessage('browser token exchange', exchange));
  }
  return tokenFromResponse(exchange.data);
}

/** Accept a bare code, a `code=...` querystring, or a full redirect URL. */
function extractCode(input: string): string | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get('code');
    if (code !== null && code.length > 0) return code;
  } catch {
    // Not a URL — try querystring or bare code below.
  }
  if (trimmed.includes('code=')) {
    const code = new URLSearchParams(trimmed).get('code');
    if (code !== null && code.length > 0) return code;
  }
  return trimmed.length > 0 ? trimmed : undefined;
}

export function openAICodexRequestHeaders(accessToken: string): Record<string, string> {
  let payload: unknown;
  try {
    const encoded = accessToken.split('.')[1];
    if (encoded === undefined) throw new Error('missing JWT payload');
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new OAuthUnauthorizedError('OpenAI Codex access token is not a valid JWT.');
  }
  const auth = isRecord(payload) ? payload[JWT_CLAIM_PATH] : undefined;
  const accountId = isRecord(auth) ? auth['chatgpt_account_id'] : undefined;
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new OAuthUnauthorizedError('OpenAI Codex access token is missing its account ID.');
  }
  return {
    'chatgpt-account-id': accountId,
    originator: 'kimi-code',
    'OpenAI-Beta': 'responses=experimental',
  };
}
