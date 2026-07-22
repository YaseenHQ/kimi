/** Anthropic Claude Pro/Max PKCE OAuth adapter. */

import { runOAuthCallbackServer, type CallbackServerHandle } from './callback-server';
import { OAuthConnectionError, OAuthError, OAuthUnauthorizedError, RetryableRefreshError } from './errors';
import { generatePKCE } from './pkce';
import type { TokenInfo } from './types';
import { isRecord } from './utils';

export const ANTHROPIC_PROVIDER_NAME = 'anthropic';
export const ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_OAUTH_KEY = 'oauth/anthropic';

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PORT = 53692;
const CALLBACK_PATH = '/callback';
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES =
  'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
const HTTP_TIMEOUT_MS = 30_000;

export interface BrowserAuthorization {
  /** Authorize URL the host should open in a browser. */
  readonly url: string;
  /** Manual-paste fallback instructions. */
  readonly instructions: string;
  /** Redirect URI, shown as the paste placeholder. */
  readonly placeholder: string;
  /**
   * Aborts the manual-paste prompt. The owning login flow aborts this signal
   * when the local callback server captures the code, so the TUI dialog can
   * resolve and unmount. When undefined (no server racing), the prompt behaves
   * as a plain modal.
   */
  readonly signal?: AbortSignal | undefined;
}

function parseAuthorizationInput(input: string): { code: string; state?: string } {
  const value = input.trim();
  if (value.length === 0) throw new OAuthError('Anthropic authorization code is empty.');
  try {
    const url = new URL(value);
    const code = url.searchParams.get('code');
    if (code !== null && code.length > 0) {
      return { code, state: url.searchParams.get('state') ?? undefined };
    }
  } catch {
    // Accept the code, code#state, or query-string forms below.
  }
  if (value.includes('#')) {
    const [code, state] = value.split('#', 2);
    if (code !== undefined && code.length > 0) return { code, state };
  }
  if (value.includes('code=')) {
    const params = new URLSearchParams(value);
    const code = params.get('code');
    if (code !== null && code.length > 0) {
      return { code, state: params.get('state') ?? undefined };
    }
  }
  return { code: value };
}

async function postToken(body: Record<string, string>): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    throw new OAuthConnectionError('Anthropic OAuth token request failed.', { cause: error });
  }
  const text = await response.text();
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) data = parsed;
  } catch {
    // Status-aware error below includes the response body.
  }
  if (!response.ok) {
    const message = `Anthropic OAuth token request failed (HTTP ${response.status})${text.length > 0 ? `: ${text}` : ''}`;
    if (response.status === 401 || response.status === 403) throw new OAuthUnauthorizedError(message);
    if (response.status === 429 || response.status >= 500) throw new RetryableRefreshError(message);
    throw new OAuthError(message);
  }
  return data;
}

function tokenFromResponse(data: Record<string, unknown>, previousRefreshToken?: string): TokenInfo {
  const accessToken = data['access_token'];
  const refreshToken = data['refresh_token'] ?? previousRefreshToken;
  const expiresIn = data['expires_in'];
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string' || typeof expiresIn !== 'number') {
    throw new OAuthError('Anthropic OAuth token response is missing required fields.');
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

/**
 * Anthropic Claude Pro/Max login via PKCE + a local callback server on :53692.
 *
 * This function owns the server lifecycle and the race against the caller's
 * manual-paste prompt. The `authorize` callback shows the URL + a paste dialog
 * and returns the pasted value (or `undefined` on cancel); the `signal` on the
 * authorization object is aborted when the server captures the redirect, so the
 * caller can unmount the dialog. Whichever arm wins, its code is exchanged
 * directly — no stringification round-trip.
 *
 * On a bind failure (e.g. :53692 in use), the server start rejects and we fall
 * back to manual-paste only (no server arm in the race).
 */
export async function loginAnthropic(
  authorize: (authorization: BrowserAuthorization) => Promise<string | undefined>,
  signal?: AbortSignal | undefined,
): Promise<TokenInfo> {
  const { verifier, challenge } = await generatePKCE();
  // Anthropic reuses the PKCE verifier as the OAuth state (pi does the same).
  const state = verifier;

  // Try to start the callback server; degrade gracefully to manual-paste only.
  let server: CallbackServerHandle | undefined;
  try {
    server = await runOAuthCallbackServer({
      host: CALLBACK_HOST,
      port: CALLBACK_PORT,
      path: CALLBACK_PATH,
      expectedState: state,
      successMessage: 'Anthropic authentication completed. You can close this window.',
      providerLabel: 'Anthropic',
    });
  } catch {
    server = undefined;
  }

  // Per-flow abort: aborted when the server captures the code OR when the
  // caller's external signal fires (Ctrl-C), so the manual dialog resolves
  // and unmounts in both cases. Matches the Codex browser-flow wiring.
  const manualAbort = new AbortController();
  const externalSignal = signal;
  if (externalSignal !== undefined) {
    if (externalSignal.aborted) manualAbort.abort();
    else externalSignal.addEventListener('abort', () => manualAbort.abort(), { once: true });
  }
  try {
    externalSignal?.throwIfAborted();
    const params = new URLSearchParams({
      code: 'true',
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    });

    const serverPromise =
      server !== undefined ? server.waitForCode() : Promise.resolve(null);
    const manualPromise = authorize({
      url: `${AUTHORIZE_URL}?${params.toString()}`,
      instructions:
        'Complete login in your browser. If it does not close automatically, paste the final redirect URL or authorization code here.',
      placeholder: REDIRECT_URI,
      signal: manualAbort.signal,
    });

    // Race: whichever arm resolves first wins. Tag each so we can tell which
    // fired. Awaiting the race unblocks on the first resolution; the loser is
    // torn down in the finally block (cancelWait + manualAbort).
    const winner = await Promise.race([
      serverPromise.then((result) => ({ kind: 'server' as const, result })),
      manualPromise.then((input) => ({ kind: 'manual' as const, input })),
    ]);

    if (winner.kind === 'server' && winner.result !== null) {
      manualAbort.abort();
      return tokenFromResponse(
        await postToken({
          grant_type: 'authorization_code',
          client_id: CLIENT_ID,
          code: winner.result.code,
          state: winner.result.state,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
        }),
      );
    }
    // Server lost/cancelled/never-started, or server arm returned null — use
    // the manual paste. Await it explicitly in case the server arm won the
    // race but returned null (manual may still be pending).
    const input = winner.kind === 'manual' ? winner.input : await manualPromise;
    externalSignal?.throwIfAborted();
    if (input === undefined) throw new OAuthError('Anthropic login cancelled.');
    const parsed = parseAuthorizationInput(input);
    if (parsed.state !== undefined && parsed.state !== verifier) {
      throw new OAuthError('Anthropic OAuth state mismatch.');
    }
    return tokenFromResponse(
      await postToken({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code: parsed.code,
        state: parsed.state ?? verifier,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
    );
  } finally {
    manualAbort.abort();
    server?.cancelWait();
    server?.close();
  }
}

export async function refreshAnthropicAccessToken(
  _config: unknown,
  refreshToken: string,
): Promise<TokenInfo> {
  return tokenFromResponse(
    await postToken({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: refreshToken }),
    refreshToken,
  );
}

export function anthropicOAuthRequestHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
    'user-agent': 'claude-cli/2.1.75',
    'x-app': 'cli',
  };
}
