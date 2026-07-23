import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { handleLogoutCommand } from '#/tui/commands/auth';

const promptState = vi.hoisted(() => ({
  selected: undefined as string | undefined,
  options: [] as readonly { value: string; label: string; description?: string }[],
  removalOptions: [] as readonly { value: string; label: string; description?: string }[],
  removalSelected: undefined as string | undefined,
  confirmRemoval: false,
}));

vi.mock('#/tui/commands/prompts', () => ({
  promptLogoutProviderSelection: vi.fn(async (_host, options) => {
    promptState.options = options;
    return promptState.selected;
  }),
  promptProviderConfigurationRemoval: vi.fn(async (_host, options) => {
    promptState.removalOptions = options;
    return promptState.removalSelected;
  }),
  promptConfirmProviderConfigurationRemoval: vi.fn(async () => promptState.confirmRemoval),
}));

function makeHost() {
  const config = {
    providers: {
      anthropic: { type: 'anthropic', oauth: { storage: 'file', key: 'anthropic' } },
      qwen: { type: 'anthropic', baseUrl: 'https://example.test', apiKey: 'secret' },
      deepseek: {
        type: 'openai',
        baseUrl: 'https://api.deepseek.test',
        apiKey: '',
        env: { OPENAI_API_KEY: 'fallback-secret', OPENAI_BASE_URL: 'https://fallback.test' },
      },
      alpha: {
        type: 'openai',
        source: {
          kind: 'apiJson',
          url: 'https://registry.test/api.json',
          apiKey: 'registry-secret',
        },
      },
      beta: {
        type: 'anthropic',
        source: {
          kind: 'apiJson',
          url: 'https://registry.test/api.json',
          apiKey: 'registry-secret',
        },
      },
    },
    models: {
      'anthropic/claude': { provider: 'anthropic', model: 'claude' },
      'qwen/coder': { provider: 'qwen', model: 'coder' },
    },
  };
  const updated = { providers: {}, models: {} };
  const harness = {
    getConfig: vi.fn(async (options?: { reload?: boolean }) =>
      options?.reload === true ? updated : config,
    ),
    auth: {
      status: vi.fn(async (providerName: string) => ({
        providers: [{ providerName, hasToken: providerName === 'anthropic' }],
      })),
      logout: vi.fn(async () => ({ ok: true })),
    },
    setConfig: vi.fn(async () => undefined),
    removeProvider: vi.fn(async () => updated),
  };
  const host = {
    harness,
    state: {
      appState: {
        model: 'anthropic/claude',
        availableModels: config.models,
      },
    },
    authFlow: {
      refreshConfigAfterLogout: vi.fn(async () => undefined),
      clearActiveSessionAfterLogout: vi.fn(async () => undefined),
    },
    setAppState: vi.fn(),
    track: vi.fn(),
    showStatus: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, harness, config, updated };
}

describe('/logout', () => {
  beforeEach(() => {
    promptState.selected = undefined;
    promptState.options = [];
    promptState.removalOptions = [];
    promptState.removalSelected = undefined;
    promptState.confirmRemoval = false;
  });

  it('removes only the OAuth credential and preserves the active session config', async () => {
    const { host, harness } = makeHost();
    promptState.selected = 'oauth:anthropic';

    await handleLogoutCommand(host);

    expect(harness.auth.logout).toHaveBeenCalledWith('anthropic', {
      deprovisionConfig: false,
    });
    expect(harness.removeProvider).not.toHaveBeenCalled();
    expect(host.authFlow.refreshConfigAfterLogout).not.toHaveBeenCalled();
    expect(host.authFlow.clearActiveSessionAfterLogout).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Logged out from Anthropic (OAuth).');
  });

  it('clears an API key without removing its provider or a different active session', async () => {
    const { host, harness } = makeHost();
    promptState.selected = 'api-key:qwen';

    await handleLogoutCommand(host);

    expect(harness.auth.logout).not.toHaveBeenCalled();
    expect(harness.removeProvider).not.toHaveBeenCalled();
    expect(harness.setConfig).toHaveBeenCalledWith({
      providers: {
        qwen: { type: 'anthropic', baseUrl: 'https://example.test', apiKey: '' },
      },
    });
    expect(host.authFlow.clearActiveSessionAfterLogout).not.toHaveBeenCalled();
    expect(host.authFlow.refreshConfigAfterLogout).toHaveBeenCalledOnce();
  });

  it('clears a config.toml env-table credential without removing other env values', async () => {
    const { host, harness } = makeHost();
    promptState.selected = 'api-key:deepseek';

    await handleLogoutCommand(host);

    expect(harness.setConfig).toHaveBeenCalledWith({
      providers: {
        deepseek: {
          type: 'openai',
          baseUrl: 'https://api.deepseek.test',
          apiKey: '',
          env: { OPENAI_API_KEY: '', OPENAI_BASE_URL: 'https://fallback.test' },
        },
      },
    });
    expect(harness.removeProvider).not.toHaveBeenCalled();
  });

  it('can clear an API key whose provider id is also a known OAuth provider', async () => {
    const { host, harness, config } = makeHost();
    (config.providers.anthropic as typeof config.providers.anthropic & { apiKey: string }).apiKey =
      'anthropic-api-key';
    harness.auth.status.mockImplementation(async (providerName: string) => ({
      providers: [{ providerName, hasToken: false }],
    }));
    promptState.selected = 'api-key:anthropic';

    await handleLogoutCommand(host);

    expect(promptState.options).toContainEqual(
      expect.objectContaining({
        value: 'api-key:anthropic',
        label: 'anthropic (API key)',
      }),
    );
    expect(harness.auth.logout).not.toHaveBeenCalled();
    expect(harness.setConfig).toHaveBeenCalledWith({
      providers: {
        anthropic: {
          type: 'anthropic',
          oauth: { storage: 'file', key: 'anthropic' },
          apiKey: '',
        },
      },
    });
  });

  it('shows OAuth and API-key credentials separately when both share a provider id', async () => {
    const { host, config } = makeHost();
    (config.providers.anthropic as typeof config.providers.anthropic & { apiKey: string }).apiKey =
      'anthropic-api-key';

    await handleLogoutCommand(host);

    expect(promptState.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 'oauth:anthropic',
          label: 'Anthropic (OAuth)',
        }),
        expect.objectContaining({
          value: 'api-key:anthropic',
          label: 'anthropic (API key)',
        }),
      ]),
    );
  });

  it('shows and executes credential bundles with their included providers', async () => {
    const { host, harness } = makeHost();
    promptState.selected = '__logout_all_credentials__';

    await handleLogoutCommand(host);

    expect(promptState.options).toContainEqual(
      expect.objectContaining({
        value: '__logout_all_credentials__',
        label: 'All credentials',
        description: 'Includes: Anthropic (OAuth), deepseek (API key), qwen (API key)',
      }),
    );
    expect(harness.auth.logout).toHaveBeenCalledWith('anthropic', {
      deprovisionConfig: false,
    });
    expect(harness.setConfig).toHaveBeenCalledWith({
      providers: expect.objectContaining({ qwen: expect.any(Object), deepseek: expect.any(Object) }),
    });
  });

  it('removes saved provider configuration only after explicit confirmation', async () => {
    const { host, harness, updated } = makeHost();
    promptState.selected = '__remove_provider_configuration__';
    promptState.removalSelected = 'provider:qwen';
    promptState.confirmRemoval = true;

    await handleLogoutCommand(host);

    expect(harness.removeProvider).toHaveBeenCalledWith('qwen');
    expect(host.setAppState).toHaveBeenCalledWith({
      availableProviders: updated.providers,
      availableModels: updated.models,
    });
  });

  it('groups custom-registry provider configuration and shows every member', async () => {
    const { host, harness } = makeHost();
    promptState.selected = '__remove_provider_configuration__';
    promptState.removalSelected = 'registry:0';
    promptState.confirmRemoval = true;

    await handleLogoutCommand(host);

    expect(promptState.removalOptions).toContainEqual(
      expect.objectContaining({
        value: 'registry:0',
        label: 'Registry: registry.test/api.json',
        description: 'Includes: alpha, beta',
      }),
    );
    expect(harness.removeProvider).toHaveBeenNthCalledWith(1, 'alpha');
    expect(harness.removeProvider).toHaveBeenNthCalledWith(2, 'beta');
  });
});
