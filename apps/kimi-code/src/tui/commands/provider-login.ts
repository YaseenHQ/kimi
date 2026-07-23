import {
  ANTHROPIC_PROVIDER_NAME,
  GITHUB_COPILOT_PROVIDER_NAME,
  applyOpenPlatformConfig,
  fetchOpenPlatformModels,
  filterModelsByPrefix,
  OpenPlatformApiError,
  OPENAI_CODEX_PROVIDER_NAME,
  type ManagedKimiCodeModelInfo,
  type ManagedKimiConfigShape,
  type OpenPlatformDefinition,
  XAI_PROVIDER_NAME,
} from '@moonshot-ai/kimi-code-oauth';
import { log } from '@moonshot-ai/kimi-code-sdk';

import { DEFAULT_OAUTH_PROVIDER_NAME, PRODUCT_NAME } from '../constant/kimi-tui';
import type { LoginProgressSpinnerHandle } from '../types';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';
import {
  promptApiKey,
  promptModelSelectionForOpenPlatform,
  promptExistingOAuthAction,
  promptOAuthAuthorizationCode,
  promptOpenAICodexLoginMethod,
} from './prompts';

export interface OAuthProviderDefinition {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export const OAUTH_PROVIDERS: readonly OAuthProviderDefinition[] = [
  {
    id: DEFAULT_OAUTH_PROVIDER_NAME,
    label: PRODUCT_NAME,
    description: 'Use a Kimi Code membership subscription.',
  },
  {
    id: XAI_PROVIDER_NAME,
    label: 'xAI',
    description: 'Use an xAI account with OAuth.',
  },
  {
    id: OPENAI_CODEX_PROVIDER_NAME,
    label: 'OpenAI Codex',
    description: 'Use a ChatGPT Plus or Pro account with OAuth.',
  },
  {
    id: ANTHROPIC_PROVIDER_NAME,
    label: 'Anthropic',
    description: 'Use a Claude Pro or Max account with OAuth.',
  },
  {
    id: GITHUB_COPILOT_PROVIDER_NAME,
    label: 'GitHub Copilot',
    description: 'Use a GitHub Copilot subscription with device-code OAuth.',
  },
];

export async function handleOAuthLogin(
  host: SlashCommandHost,
  provider: OAuthProviderDefinition,
): Promise<void> {
  const status = await host.harness.auth.status(provider.id);
  const alreadyLoggedIn = status.providers.some(
    (entry) => entry.providerName === provider.id && entry.hasToken,
  );
  const existingAction = alreadyLoggedIn
    ? await promptExistingOAuthAction(host, provider.label)
    : undefined;
  if (alreadyLoggedIn && existingAction === undefined) return;
  const forceLogin = existingAction === 'switch';

  let spinner: LoginProgressSpinnerHandle | undefined;
  const controller = new AbortController();
  const cancelLogin = (): void => {
    controller.abort();
  };
  host.cancelInFlight = cancelLogin;
  try {
    // OpenAI Codex offers browser (PKCE + local server) or device-code.
    let method: 'browser' | 'device_code' | undefined;
    if (provider.id === OPENAI_CODEX_PROVIDER_NAME && (!alreadyLoggedIn || forceLogin)) {
      method = await promptOpenAICodexLoginMethod(host);
      if (method === undefined) return;
    }
    await host.harness.auth.login(provider.id, {
      signal: controller.signal,
      method,
      forceLogin,
      onDeviceCode: (data) => {
        spinner = host.showLoginAuthorizationPrompt(data);
      },
      onBrowserAuthorization: (authorization) =>
        promptOAuthAuthorizationCode(host, provider.label, authorization),
    });
    spinner?.stop({ ok: true, label: 'Logged in.' });
    spinner = undefined;
    try {
      await host.authFlow.refreshConfigAfterLogin();
    } catch (refreshError) {
      const message = formatErrorMessage(refreshError);
      host.showError(`Authentication successful, but failed to refresh config: ${message}`);
      return;
    }
    host.track('login', {
      provider: provider.id,
      method: 'oauth',
      already_logged_in: alreadyLoggedIn,
    });
    if (forceLogin) {
      host.showStatus(`Switched ${provider.label} account.`);
    } else if (alreadyLoggedIn) {
      host.showStatus('Already logged in. Model configuration refreshed.');
    }
  } catch (error) {
    const cancelled = controller.signal.aborted;
    spinner?.stop({
      ok: false,
      label: cancelled ? 'Login cancelled.' : 'Login failed.',
    });
    spinner = undefined;
    if (cancelled) return;
    log.warn('login failed', {
      providerName: provider.id,
      alreadyLoggedIn,
      sessionId: host.session?.id,
      error,
    });
    const message = formatErrorMessage(error);
    host.showError(`Login failed: ${message}`);
  } finally {
    if (host.cancelInFlight === cancelLogin) {
      host.cancelInFlight = undefined;
    }
  }
}

export async function handleKimiCodeOAuthLogin(host: SlashCommandHost): Promise<void> {
  await handleOAuthLogin(host, OAUTH_PROVIDERS[0]!);
}

export async function handleOpenPlatformLogin(
  host: SlashCommandHost,
  platform: OpenPlatformDefinition,
): Promise<void> {
  const consoleHost = platform.consoleUrl?.replace(/^https?:\/\//, '') ?? '';
  const platformName = consoleHost.length > 0 ? `Kimi Platform (${consoleHost})` : 'Kimi Platform';
  const subtitleLines = [
    `${'base_url'.padEnd(12)}${platform.baseUrl}`,
    `${'saved to'.padEnd(12)}~/.kimi-code/config.toml`,
  ];
  const apiKey = await promptApiKey(host, platformName, subtitleLines);
  if (apiKey === undefined) return;

  const controller = new AbortController();
  const cancelLogin = (): void => {
    controller.abort();
  };
  host.cancelInFlight = cancelLogin;

  let models: ManagedKimiCodeModelInfo[];
  try {
    models = await fetchOpenPlatformModels(platform, apiKey, fetch, controller.signal);
    models = filterModelsByPrefix(models, platform);
  } catch (error) {
    if (controller.signal.aborted) return;
    const msg = formatErrorMessage(error);
    host.showError(`Failed to verify API key: ${msg}`);
    if (
      error instanceof OpenPlatformApiError &&
      error.status === 401
    ) {
      host.showStatus(
        'Hint: If your API key was obtained from Kimi Code, please select "Kimi Code" instead.',
      );
    }
    return;
  } finally {
    if (host.cancelInFlight === cancelLogin) {
      host.cancelInFlight = undefined;
    }
  }

  if (models.length === 0) {
    host.showError('No models available for this platform.');
    return;
  }

  const selection = await promptModelSelectionForOpenPlatform(host, models, platform);
  if (selection === undefined) return;

  const existingConfig = await host.harness.getConfig();
  if (existingConfig.providers[platform.id] !== undefined) {
    await host.harness.removeProvider(platform.id);
  }

  const config = await host.harness.getConfig();
  applyOpenPlatformConfig(config as ManagedKimiConfigShape, {
    platform,
    models,
    selectedModel: selection.model,
    thinking: selection.thinking !== 'off',
    effort:
      selection.thinking !== 'off' && selection.thinking !== 'on'
        ? selection.thinking
        : undefined,
    apiKey,
  });

  await host.harness.setConfig({
    providers: config.providers,
    models: config.models,
    defaultModel: config.defaultModel,
    thinking: config.thinking,
  });

  await host.authFlow.refreshConfigAfterLogin();
  host.track('login', { provider: platform.id, method: 'api_key' });
  host.showStatus(`Setup complete: ${platform.name} · ${selection.model.id}`);
}
