import type { ChoiceOption } from '../components/dialogs/choice-picker';
import type { SlashCommandHost } from './dispatch';
import { handleProviderAdd } from './provider';
import { OAUTH_PROVIDERS } from './provider-login';
import { promptLogoutProviderSelection } from './prompts';

// ---------------------------------------------------------------------------
// Auth: login / logout
// ---------------------------------------------------------------------------

export async function handleLoginCommand(host: SlashCommandHost): Promise<void> {
  await handleProviderAdd(host);
}

export async function handleLogoutCommand(host: SlashCommandHost): Promise<void> {
  const config = await host.harness.getConfig();

  const options: ChoiceOption[] = [];
  const oauthIds = new Set(OAUTH_PROVIDERS.map((provider) => provider.id));
  for (const provider of OAUTH_PROVIDERS) {
    const status = await host.harness.auth.status(provider.id);
    const hasToken = status.providers.some(
      (entry) => entry.providerName === provider.id && entry.hasToken,
    );
    if (hasToken || config.providers[provider.id] !== undefined) {
      options.push({
        value: provider.id,
        label: provider.label,
        description: hasToken ? 'OAuth account' : 'OAuth login expired',
      });
    }
  }
  for (const id of Object.keys(config.providers).toSorted()) {
    if (oauthIds.has(id)) continue;
    const provider = config.providers[id];
    if (provider?.apiKey === undefined || provider.apiKey.trim().length === 0) continue;
    options.push({
      value: id,
      label: id,
      description: 'API key',
    });
  }

  if (options.length === 0) {
    host.showStatus('Nothing to logout.');
    return;
  }

  const currentModel = host.state.appState.model.trim();
  const currentProvider = host.state.appState.availableModels[currentModel]?.provider;

  const target = await promptLogoutProviderSelection(host, options, currentProvider);
  if (target === undefined) return;

  if (oauthIds.has(target)) {
    await host.harness.auth.logout(target, { deprovisionConfig: false });
  } else {
    await host.harness.setConfig({
      providers: {
        [target]: { ...config.providers[target], apiKey: '' },
      },
    });
    await host.authFlow.refreshConfigAfterLogout();
  }
  if (target === currentProvider && !oauthIds.has(target)) {
    await host.authFlow.clearActiveSessionAfterLogout();
  }

  host.track('logout', { provider: target });
  const label = OAUTH_PROVIDERS.find((provider) => provider.id === target)?.label ?? target;
  host.showStatus(`Logged out from ${label}.`);
}
