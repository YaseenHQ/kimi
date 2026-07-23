import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyManagedKimiCodeConfig,
  ANTHROPIC_PROVIDER_NAME,
  GITHUB_COPILOT_PROVIDER_NAME,
  KIMI_CODE_PROVIDER_NAME,
  KimiOAuthToolkit,
  OPENAI_CODEX_OAUTH_FLOW_CONFIG,
  resolveKimiCodeOAuthKey,
  resolveKimiTokenStorageName,
  XAI_OAUTH_FLOW_CONFIG,
  type ManagedKimiConfigShape,
  type TokenInfo,
  type TokenStorage,
} from '../src';

class MemoryTokenStorage implements TokenStorage {
  readonly tokens = new Map<string, TokenInfo>();

  async load(name: string): Promise<TokenInfo | undefined> {
    return this.tokens.get(name);
  }

  async save(name: string, token: TokenInfo): Promise<void> {
    this.tokens.set(name, token);
  }

  async remove(name: string): Promise<void> {
    this.tokens.delete(name);
  }

  async list(): Promise<string[]> {
    return [...this.tokens.keys()];
  }
}

function token(accessToken: string): TokenInfo {
  return {
    accessToken,
    refreshToken: `refresh-${accessToken}`,
    expiresAt: 10_000,
    scope: '',
    tokenType: 'Bearer',
    expiresIn: 3600,
  };
}

const TEST_IDENTITY = {
  userAgentProduct: 'kimi-code-cli',
  version: '0.0.0-test',
} as const;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function managedModelsResponse(): Response {
  return new Response(
    JSON.stringify({
      data: [
        {
          id: 'kimi-for-coding',
          context_length: 262144,
          supports_reasoning: true,
        },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function fetchInputUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  throw new TypeError('expected fetch input to be a string, URL, or Request');
}

describe('resolveKimiTokenStorageName', () => {
  it('maps config oauth keys to the file storage token name', () => {
    expect(
      resolveKimiTokenStorageName({
        providerName: KIMI_CODE_PROVIDER_NAME,
        oauthKey: 'oauth/kimi-code',
      }),
    ).toBe('kimi-code');
    expect(resolveKimiTokenStorageName({ oauthKey: 'kimi-code' })).toBe('kimi-code');
  });

  it('accepts non-managed providers with a valid key and rejects unsafe token keys', () => {
    expect(
      resolveKimiTokenStorageName({
        providerName: 'custom',
        oauthKey: 'oauth/kimi-code',
      }),
    ).toBe('kimi-code');
    expect(
      resolveKimiTokenStorageName({
        providerName: 'kimi-code-anthropic',
        oauthKey: 'oauth/kimi-code',
      }),
    ).toBe('kimi-code');
    expect(() => resolveKimiTokenStorageName({ oauthKey: '../kimi-code' })).toThrow(/Invalid/);
  });
});

describe('KimiOAuthToolkit', () => {
  it('replaces an existing token only after a forced token flow succeeds', async () => {
    const storage = new MemoryTokenStorage();
    storage.tokens.set('anthropic', token('old-access'));
    const toolkit = new KimiOAuthToolkit({ storage, now: () => 100 });

    const acquire = vi.fn(async () => token('new-access'));
    await toolkit.loginWithToken(
      ANTHROPIC_PROVIDER_NAME,
      { key: 'oauth/anthropic' },
      acquire,
      { forceLogin: true },
    );

    expect(acquire).toHaveBeenCalledOnce();
    expect(storage.tokens.get('anthropic')?.accessToken).toBe('new-access');
  });

  it('preserves the existing token when a forced token flow fails', async () => {
    const storage = new MemoryTokenStorage();
    storage.tokens.set('anthropic', token('old-access'));
    const toolkit = new KimiOAuthToolkit({ storage, now: () => 100 });

    await expect(
      toolkit.loginWithToken(
        ANTHROPIC_PROVIDER_NAME,
        { key: 'oauth/anthropic' },
        async () => {
          throw new Error('cancelled');
        },
        { forceLogin: true },
      ),
    ).rejects.toThrow('cancelled');
    expect(storage.tokens.get('anthropic')?.accessToken).toBe('old-access');
  });

  it('can be constructed without host identity', async () => {
    const storage = new MemoryTokenStorage();
    storage.tokens.set('kimi-code', token('access-1'));
    const toolkit = new KimiOAuthToolkit({
      homeDir: join('/tmp', 'kimi-oauth-toolkit-test'),
      storage,
      now: () => 100,
    });

    await expect(toolkit.tokenProvider().getAccessToken()).resolves.toBe('access-1');
  });

  it('reports status and exposes a bearer token provider', async () => {
    const storage = new MemoryTokenStorage();
    storage.tokens.set('kimi-code', token('access-1'));
    const toolkit = new KimiOAuthToolkit({
      homeDir: join('/tmp', 'kimi-oauth-toolkit-test'),
      identity: TEST_IDENTITY,
      storage,
      now: () => 100,
    });

    await expect(toolkit.status()).resolves.toEqual({
      providers: [{ providerName: KIMI_CODE_PROVIDER_NAME, hasToken: true }],
    });
    await expect(toolkit.tokenProvider().getAccessToken()).resolves.toBe('access-1');
  });

  it('derives provider-specific request auth from each fresh OAuth token', async () => {
    const storage = new MemoryTokenStorage();
    const codexAccess = `header.${Buffer.from(
      JSON.stringify({
        'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' },
      }),
    ).toString('base64url')}.signature`;
    storage.tokens.set('openai-codex', token(codexAccess));
    storage.tokens.set('anthropic', token('anthropic-access'));
    storage.tokens.set(
      'github-copilot',
      token('copilot-access;proxy-ep=proxy.enterprise.example;other=value'),
    );
    const toolkit = new KimiOAuthToolkit({ storage, now: () => 100 });

    await expect(
      toolkit
        .tokenProvider('openai-codex', { key: 'oauth/openai-codex' })
        .getRequestAuth?.(),
    ).resolves.toMatchObject({
      apiKey: codexAccess,
      headers: { 'chatgpt-account-id': 'account-1', originator: 'kimi-code' },
    });
    await expect(
      toolkit
        .tokenProvider(ANTHROPIC_PROVIDER_NAME, { key: 'oauth/anthropic' })
        .getRequestAuth?.(),
    ).resolves.toMatchObject({
      apiKey: 'anthropic-access',
      headers: {
        authorization: 'Bearer anthropic-access',
        'anthropic-beta': expect.stringContaining('oauth-2025-04-20'),
      },
    });
    await expect(
      toolkit
        .tokenProvider(GITHUB_COPILOT_PROVIDER_NAME, {
          key: 'oauth/github-copilot',
          oauthHost: 'https://github.enterprise.example',
        })
        .getRequestAuth?.(),
    ).resolves.toMatchObject({
      apiKey: 'copilot-access;proxy-ep=proxy.enterprise.example;other=value',
      baseUrl: 'https://api.enterprise.example',
      headers: { Authorization: expect.stringContaining('Bearer ') },
    });
  });

  it('runs xAI through Kimi token storage and OAuthManager lifecycle', async () => {
    const storage = new MemoryTokenStorage();
    const responses = [
      new Response(
        JSON.stringify({
          device_code: 'xai-device',
          user_code: 'XAI-CODE',
          verification_uri: 'https://auth.x.ai/device',
          expires_in: 600,
          interval: 1,
        }),
        { status: 200 },
      ),
      new Response(
        JSON.stringify({
          access_token: 'xai-access',
          refresh_token: 'xai-refresh',
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    ];
    vi.stubGlobal('fetch', vi.fn(async () => responses.shift()!));
    const toolkit = new KimiOAuthToolkit({
      homeDir: join('/tmp', 'kimi-oauth-toolkit-test'),
      storage,
      sleep: async () => {},
    });

    const oauthRef = { key: 'oauth/xai' };
    const onDeviceCode = vi.fn();
    await toolkit.login(XAI_OAUTH_FLOW_CONFIG.name, {
      oauthRef,
      onDeviceCode,
      provisionConfig: false,
    });

    expect(onDeviceCode).toHaveBeenCalledWith(
      expect.objectContaining({ userCode: 'XAI-CODE' }),
    );
    await expect(toolkit.status(XAI_OAUTH_FLOW_CONFIG.name, oauthRef)).resolves.toEqual({
      providers: [{ providerName: 'xai', hasToken: true }],
    });
    await expect(
      toolkit.tokenProvider(XAI_OAUTH_FLOW_CONFIG.name, oauthRef).getAccessToken(),
    ).resolves.toBe('xai-access');
    await toolkit.logout(XAI_OAUTH_FLOW_CONFIG.name, oauthRef);
    await expect(toolkit.status(XAI_OAUTH_FLOW_CONFIG.name, oauthRef)).resolves.toEqual({
      providers: [{ providerName: 'xai', hasToken: false }],
    });
  });

  it('runs OpenAI Codex through Kimi token storage and OAuthManager lifecycle', async () => {
    const storage = new MemoryTokenStorage();
    const responses = [
      new Response(
        JSON.stringify({
          device_auth_id: 'device-auth',
          user_code: 'OPENAI-CODE',
          interval: 1,
        }),
        { status: 200 },
      ),
      new Response(
        JSON.stringify({ authorization_code: 'authorization', code_verifier: 'verifier' }),
        { status: 200 },
      ),
      new Response(
        JSON.stringify({
          access_token: 'header.payload.signature',
          refresh_token: 'codex-refresh',
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    ];
    vi.stubGlobal('fetch', vi.fn(async () => responses.shift()!));
    const toolkit = new KimiOAuthToolkit({
      homeDir: join('/tmp', 'kimi-oauth-toolkit-test'),
      storage,
      sleep: async () => {},
    });

    const oauthRef = { key: 'oauth/openai-codex' };
    const onDeviceCode = vi.fn();
    await toolkit.login(OPENAI_CODEX_OAUTH_FLOW_CONFIG.name, {
      oauthRef,
      onDeviceCode,
      provisionConfig: false,
    });

    expect(onDeviceCode).toHaveBeenCalledWith(
      expect.objectContaining({ userCode: 'OPENAI-CODE' }),
    );
    await expect(
      toolkit
        .tokenProvider(OPENAI_CODEX_OAUTH_FLOW_CONFIG.name, oauthRef)
        .getAccessToken(),
    ).resolves.toBe('header.payload.signature');
  });

  it('runs Anthropic PKCE login through the browser authorization callback', async () => {
    const storage = new MemoryTokenStorage();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            access_token: 'sk-ant-oat-test',
            refresh_token: 'anthropic-refresh',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    const toolkit = new KimiOAuthToolkit({
      homeDir: join('/tmp', 'kimi-oauth-toolkit-test'),
      storage,
    });
    const onBrowserAuthorization = vi.fn(async ({ url }: { url: string }) => {
      const state = new URL(url).searchParams.get('state');
      return `authorization-code#${state ?? ''}`;
    });

    await toolkit.login(ANTHROPIC_PROVIDER_NAME, {
      oauthRef: { key: 'oauth/anthropic' },
      onBrowserAuthorization,
      provisionConfig: false,
    });

    expect(onBrowserAuthorization).toHaveBeenCalledOnce();
    await expect(
      toolkit
        .tokenProvider(ANTHROPIC_PROVIDER_NAME, { key: 'oauth/anthropic' })
        .getAccessToken(),
    ).resolves.toBe('sk-ant-oat-test');
  });

  it('resolves bearer token providers using the configured oauth key', async () => {
    const storage = new MemoryTokenStorage();
    storage.tokens.set('custom-kimi-code', token('custom-access'));
    const toolkit = new KimiOAuthToolkit({
      homeDir: join('/tmp', 'kimi-oauth-toolkit-test'),
      identity: TEST_IDENTITY,
      storage,
      now: () => 100,
    });

    await expect(
      toolkit
        .tokenProvider(KIMI_CODE_PROVIDER_NAME, { key: 'oauth/custom-kimi-code' })
        .getAccessToken(),
    ).resolves.toBe('custom-access');
  });

  it('refreshes configured bearer token refs against their OAuth host', async () => {
    const storage = new MemoryTokenStorage();
    const oauthHost = 'https://auth.dev.example.test';
    const oauthKey = resolveKimiCodeOAuthKey({
      oauthHost,
      baseUrl: 'https://api.dev.example.test/coding/v1',
    });
    storage.tokens.set(resolveKimiTokenStorageName({ oauthKey }), {
      ...token('expired-dev-access'),
      expiresAt: 100,
    });
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(fetchInputUrl(input)).toBe(`${oauthHost}/api/oauth/token`);
      if (typeof init?.body !== 'string') throw new TypeError('expected form body');
      expect(new URLSearchParams(init.body).get('grant_type')).toBe('refresh_token');
      return new Response(
        JSON.stringify({
          access_token: 'rotated-dev-access',
          refresh_token: 'rotated-dev-refresh',
          expires_in: 3600,
          scope: '',
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchImpl);
    const toolkit = new KimiOAuthToolkit({
      homeDir: join('/tmp', 'kimi-oauth-toolkit-test'),
      identity: TEST_IDENTITY,
      storage,
      now: () => 1_000,
      flowConfig: {
        name: 'kimi-code',
        oauthHost: 'https://auth.kimi.com',
        clientId: 'test-client-id',
      },
    });

    await expect(
      toolkit
        .tokenProvider(KIMI_CODE_PROVIDER_NAME, { key: oauthKey, oauthHost })
        .getAccessToken(),
    ).resolves.toBe('rotated-dev-access');
  });

  it('does not reuse a cached OAuth manager across different hosts for the same token key', async () => {
    const storage = new MemoryTokenStorage();
    storage.tokens.set('custom-kimi-code', {
      ...token('expired-custom-access'),
      expiresAt: 100,
    });
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: unknown) => {
      requests.push(fetchInputUrl(input));
      return new Response(
        JSON.stringify({
          access_token: `rotated-${String(requests.length)}`,
          refresh_token: `refresh-${String(requests.length)}`,
          expires_in: 3600,
          scope: '',
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchImpl);
    const toolkit = new KimiOAuthToolkit({
      homeDir: join('/tmp', 'kimi-oauth-toolkit-test'),
      identity: TEST_IDENTITY,
      storage,
      now: () => 1_000,
      flowConfig: {
        name: 'kimi-code',
        oauthHost: 'https://auth.kimi.com',
        clientId: 'test-client-id',
      },
    });

    await expect(
      toolkit
        .tokenProvider(KIMI_CODE_PROVIDER_NAME, {
          key: 'oauth/custom-kimi-code',
          oauthHost: 'https://auth.one.test/',
        })
        .getAccessToken({ force: true }),
    ).resolves.toBe('rotated-1');
    await expect(
      toolkit
        .tokenProvider(KIMI_CODE_PROVIDER_NAME, {
          key: 'oauth/custom-kimi-code',
          oauthHost: 'https://auth.two.test',
        })
        .getAccessToken({ force: true }),
    ).resolves.toBe('rotated-2');

    expect(requests).toEqual([
      'https://auth.one.test/api/oauth/token',
      'https://auth.two.test/api/oauth/token',
    ]);
  });

  it('returns the cached access token without refreshing it', async () => {
    const storage = new MemoryTokenStorage();
    storage.tokens.set('kimi-code', {
      ...token('cached-access'),
      expiresAt: 1,
    });
    const toolkit = new KimiOAuthToolkit({
      homeDir: join('/tmp', 'kimi-oauth-toolkit-test'),
      identity: TEST_IDENTITY,
      storage,
      now: () => 10_000,
    });

    await expect(toolkit.getCachedAccessToken()).resolves.toBe('cached-access');
  });

  it('resolves cached access tokens using the configured oauth key', async () => {
    const storage = new MemoryTokenStorage();
    storage.tokens.set('custom-kimi-code', token('custom-cached-access'));
    const toolkit = new KimiOAuthToolkit({
      homeDir: join('/tmp', 'kimi-oauth-toolkit-test'),
      identity: TEST_IDENTITY,
      storage,
      now: () => 100,
    });

    await expect(
      toolkit.getCachedAccessToken(KIMI_CODE_PROVIDER_NAME, { key: 'oauth/custom-kimi-code' }),
    ).resolves.toBe('custom-cached-access');
  });

  it('returns undefined when no cached access token exists', async () => {
    const toolkit = new KimiOAuthToolkit({
      homeDir: join('/tmp', 'kimi-oauth-toolkit-test'),
      identity: TEST_IDENTITY,
      storage: new MemoryTokenStorage(),
      now: () => 100,
    });

    await expect(toolkit.getCachedAccessToken()).resolves.toBeUndefined();
  });

  it('provisions managed config after login when an adapter is configured', async () => {
    const storage = new MemoryTokenStorage();
    const write = vi.fn();
    const fetchImpl = vi.fn(async () => managedModelsResponse()) as unknown as typeof fetch;
    const config = { providers: {} };
    const toolkit = new KimiOAuthToolkit({
      homeDir: join('/tmp', 'kimi-oauth-toolkit-test'),
      identity: TEST_IDENTITY,
      storage,
      now: () => 100,
      fetchImpl,
      configAdapter: {
        read: () => config,
        write,
        apply: (target, input) => {
          target.providers[KIMI_CODE_PROVIDER_NAME] = {
            type: 'kimi',
            apiKey: '',
          };
          return {
            defaultModel: `kimi-code/${input.models[0]?.id ?? 'unknown'}`,
            defaultThinking: true,
          };
        },
      },
    });

    storage.tokens.set('kimi-code', token('access-1'));
    await expect(toolkit.login()).resolves.toMatchObject({
      providerName: KIMI_CODE_PROVIDER_NAME,
      ok: true,
      provision: {
        defaultModel: 'kimi-code/kimi-for-coding',
      },
    });
    expect(write).toHaveBeenCalledWith(config);
  });

  it.each([401, 402])(
    'force-refreshes a stored token when managed model provisioning rejects cached auth with HTTP %i',
    async (status) => {
      const storage = new MemoryTokenStorage();
      const write = vi.fn();
      const onDeviceCode = vi.fn();
      const config = { providers: {} };
      const oauthHost = 'https://auth.test';
      const oauthKey = resolveKimiCodeOAuthKey({ oauthHost });
      storage.tokens.set(resolveKimiTokenStorageName({ oauthKey }), token('stale-access'));
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              error: { message: 'The API Key appears to be invalid or may have expired.' },
            }),
            { status, headers: { 'Content-Type': 'application/json' } },
          ),
        )
        .mockResolvedValueOnce(managedModelsResponse());
      const fetchImpl = fetchMock as unknown as typeof fetch;
      const oauthFetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
        if (typeof init?.body !== 'string') throw new TypeError('expected form body');
        const body = new URLSearchParams(init.body);
        if (body.get('grant_type') !== 'refresh_token') {
          throw new Error(`unexpected OAuth grant: ${body.get('grant_type') ?? '<missing>'}`);
        }
        return new Response(
          JSON.stringify({
            access_token: 'rotated-access',
            refresh_token: 'rotated-refresh',
            expires_in: 3600,
            scope: '',
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });
      vi.stubGlobal('fetch', oauthFetch);
      const toolkit = new KimiOAuthToolkit({
        homeDir: join('/tmp', 'kimi-oauth-toolkit-test'),
        identity: TEST_IDENTITY,
        storage,
        now: () => 100,
        fetchImpl,
        flowConfig: {
          name: 'kimi-code',
          oauthHost,
          clientId: 'test-client-id',
        },
        configAdapter: {
          read: () => config,
          write,
          apply: (target, input) => {
            target.providers[KIMI_CODE_PROVIDER_NAME] = {
              type: 'kimi',
              apiKey: '',
            };
            return {
              defaultModel: `kimi-code/${input.models[0]?.id ?? 'unknown'}`,
              defaultThinking: true,
            };
          },
        },
      });

      await expect(toolkit.login(undefined, { onDeviceCode })).resolves.toMatchObject({
        providerName: KIMI_CODE_PROVIDER_NAME,
        ok: true,
        provision: {
          defaultModel: 'kimi-code/kimi-for-coding',
        },
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const firstModelRequest = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
      const secondModelRequest = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
      expect(new Headers(firstModelRequest?.headers).get('authorization')).toBe(
        'Bearer stale-access',
      );
      expect(new Headers(secondModelRequest?.headers).get('authorization')).toBe(
        'Bearer rotated-access',
      );
      expect(oauthFetch).toHaveBeenCalledTimes(1);
      expect(onDeviceCode).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledWith(config);
    },
  );

  it('uses a scoped credential slot for non-default OAuth login environments', async () => {
    const storage = new MemoryTokenStorage();
    storage.tokens.set('kimi-code', token('prod-access'));
    const config: ManagedKimiConfigShape = { providers: {} };
    const devBaseUrl = 'https://api.dev.example.test/coding/v1';
    const devOauthHost = 'https://auth.dev.example.test';
    const devOauthKey = resolveKimiCodeOAuthKey({
      oauthHost: devOauthHost,
      baseUrl: devBaseUrl,
    });
    const devStorageName = resolveKimiTokenStorageName({ oauthKey: devOauthKey });
    const write = vi.fn();
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      managedModelsResponse(),
    );
    const oauthFetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new TypeError('expected form body');
      const body = new URLSearchParams(init.body);
      if (body.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
        return new Response(
          JSON.stringify({
            access_token: 'dev-access',
            refresh_token: 'dev-refresh',
            expires_in: 3600,
            scope: '',
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          user_code: 'WDJB-MJHT',
          device_code: 'device-code',
          verification_uri: `${devOauthHost}/verify`,
          verification_uri_complete: `${devOauthHost}/verify?user_code=WDJB-MJHT`,
          expires_in: 600,
          interval: 1,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', oauthFetch);
    const toolkit = new KimiOAuthToolkit({
      homeDir: join('/tmp', 'kimi-oauth-toolkit-test'),
      identity: TEST_IDENTITY,
      storage,
      now: () => 100,
      fetchImpl: fetchMock as unknown as typeof fetch,
      flowConfig: {
        name: 'kimi-code',
        oauthHost: devOauthHost,
        clientId: 'test-client-id',
      },
      configAdapter: {
        read: () => config,
        write,
        apply: applyManagedKimiCodeConfig,
      },
    });

    await expect(toolkit.login(undefined, { baseUrl: devBaseUrl })).resolves.toMatchObject({
      providerName: KIMI_CODE_PROVIDER_NAME,
      ok: true,
    });
    expect(oauthFetch).toHaveBeenCalledTimes(2);
    expect(storage.tokens.get('kimi-code')?.accessToken).toBe('prod-access');
    expect(storage.tokens.get(devStorageName)?.accessToken).toBe('dev-access');
    expect(config.providers[KIMI_CODE_PROVIDER_NAME]?.oauth).toEqual({
      storage: 'file',
      key: devOauthKey,
      oauthHost: devOauthHost,
    });
    const modelRequest = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(new Headers(modelRequest?.headers).get('authorization')).toBe('Bearer dev-access');
    expect(write).toHaveBeenCalledWith(config);
  });

  it('starts a new device flow when the stored refresh token is invalid', async () => {
    const storage = new MemoryTokenStorage();
    const oauthHost = 'https://auth.test';
    const oauthKey = resolveKimiCodeOAuthKey({ oauthHost });
    const storageName = resolveKimiTokenStorageName({ oauthKey });
    storage.tokens.set(storageName, {
      ...token('stale-access'),
      refreshToken: 'revoked-refresh',
      expiresAt: 101,
    });
    const onDeviceCode = vi.fn();
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new TypeError('expected form body');
      const body = new URLSearchParams(init.body);
      if (body.get('grant_type') === 'refresh_token') {
        return new Response(
          JSON.stringify({
            error: 'invalid_grant',
            error_description: 'The provided authorization grant is invalid',
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (body.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
        return new Response(
          JSON.stringify({
            access_token: 'fresh-access',
            refresh_token: 'fresh-refresh',
            expires_in: 3600,
            scope: '',
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          user_code: 'WDJB-MJHT',
          device_code: 'device-code',
          verification_uri: 'https://auth.test/verify',
          verification_uri_complete: 'https://auth.test/verify?user_code=WDJB-MJHT',
          expires_in: 600,
          interval: 1,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);
    const toolkit = new KimiOAuthToolkit({
      homeDir: join('/tmp', 'kimi-oauth-toolkit-test'),
      identity: TEST_IDENTITY,
      storage,
      now: () => 100,
      flowConfig: {
        name: 'kimi-code',
        oauthHost,
        clientId: 'test-client-id',
      },
    });

    await expect(toolkit.login(undefined, { onDeviceCode })).resolves.toMatchObject({
      providerName: KIMI_CODE_PROVIDER_NAME,
      ok: true,
    });
    expect(onDeviceCode).toHaveBeenCalledTimes(1);
    expect((await storage.load(storageName))?.accessToken).toBe('fresh-access');
  });

  it('propagates extraUsage from the managed usage response', async () => {
    const storage = new MemoryTokenStorage();
    storage.tokens.set('kimi-code', token('access-1'));
    const fetchImpl = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          usage: { used: 10, limit: 100, name: 'Weekly limit' },
          limits: [],
          boosterWallet: {
            balance: {
              type: 'BOOSTER',
              amount: '20000000000',
              amountLeft: '10000000000',
            },
            monthlyChargeLimitEnabled: true,
            monthlyChargeLimit: { currency: 'USD', priceInCents: '20000' },
            monthlyUsed: { currency: 'USD', priceInCents: '5000' },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);
    const toolkit = new KimiOAuthToolkit({
      homeDir: join('/tmp', 'kimi-oauth-toolkit-test'),
      identity: TEST_IDENTITY,
      storage,
      now: () => 100,
    });

    await expect(toolkit.getManagedUsage()).resolves.toMatchObject({
      kind: 'ok',
      summary: { label: 'Weekly limit', used: 10, limit: 100 },
      limits: [],
      extraUsage: {
        balanceCents: 10000,
        totalCents: 20000,
        monthlyChargeLimitEnabled: true,
        monthlyChargeLimitCents: 20000,
        monthlyUsedCents: 5000,
        currency: 'USD',
      },
    });
  });

  it('returns null extraUsage when the payload has no boosterWallet', async () => {
    const storage = new MemoryTokenStorage();
    storage.tokens.set('kimi-code', token('access-1'));
    const fetchImpl = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          usage: { used: 10, limit: 100, name: 'Weekly limit' },
          limits: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);
    const toolkit = new KimiOAuthToolkit({
      homeDir: join('/tmp', 'kimi-oauth-toolkit-test'),
      identity: TEST_IDENTITY,
      storage,
      now: () => 100,
    });

    await expect(toolkit.getManagedUsage()).resolves.toMatchObject({
      kind: 'ok',
      summary: { label: 'Weekly limit', used: 10, limit: 100 },
      limits: [],
      extraUsage: null,
    });
  });

  it('removes managed config on logout when an adapter supports cleanup', async () => {
    const storage = new MemoryTokenStorage();
    storage.tokens.set('kimi-code', token('access-1'));
    const config = { providers: { [KIMI_CODE_PROVIDER_NAME]: { type: 'kimi' } } };
    const write = vi.fn();
    const remove = vi.fn();
    const toolkit = new KimiOAuthToolkit({
      homeDir: join('/tmp', 'kimi-oauth-toolkit-test'),
      identity: TEST_IDENTITY,
      storage,
      now: () => 100,
      configAdapter: {
        read: () => config,
        write,
        apply: () => ({ defaultModel: 'kimi-code/kimi-for-coding', defaultThinking: true }),
        remove,
      },
    });

    await expect(toolkit.logout()).resolves.toMatchObject({
      providerName: KIMI_CODE_PROVIDER_NAME,
      ok: true,
    });
    expect(remove).toHaveBeenCalledWith(config);
    expect(write).toHaveBeenCalledWith(config);
    await expect(storage.load('kimi-code')).resolves.toBeUndefined();
  });
});
