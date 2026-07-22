import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { handleLogoutCommand } from '#/tui/commands/auth';

const promptState = vi.hoisted(() => ({ selected: undefined as string | undefined }));

vi.mock('#/tui/commands/prompts', () => ({
  promptLogoutProviderSelection: vi.fn(async () => promptState.selected),
}));

function makeHost() {
  const config = {
    providers: {
      anthropic: { type: 'anthropic', oauth: { storage: 'file', key: 'anthropic' } },
      qwen: { type: 'anthropic', baseUrl: 'https://example.test', apiKey: 'secret' },
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
    removeProvider: vi.fn(async () => undefined),
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
  return { host, harness, updated };
}

describe('/logout', () => {
  beforeEach(() => {
    promptState.selected = undefined;
  });

  it('removes only the OAuth credential and preserves the active session config', async () => {
    const { host, harness } = makeHost();
    promptState.selected = 'anthropic';

    await handleLogoutCommand(host);

    expect(harness.auth.logout).toHaveBeenCalledWith('anthropic', {
      deprovisionConfig: false,
    });
    expect(harness.removeProvider).not.toHaveBeenCalled();
    expect(host.authFlow.refreshConfigAfterLogout).not.toHaveBeenCalled();
    expect(host.authFlow.clearActiveSessionAfterLogout).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Logged out from Anthropic.');
  });

  it('clears an API key without removing its provider or a different active session', async () => {
    const { host, harness } = makeHost();
    promptState.selected = 'qwen';

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
});
