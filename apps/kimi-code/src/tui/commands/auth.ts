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
    options.push({
      value: id,
      label: id,
      description:
        provider?.apiKey !== undefined
          ? 'API key'
          : provider?.baseUrl !== undefined
            ? provider.baseUrl
            : 'Config.toml provider',
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
  }
  if (config.providers[target] !== undefined) {
    await host.harness.removeProvider(target);
  }

  if (target === currentProvider) {
    await host.authFlow.refreshConfigAfterLogout();
    await host.authFlow.clearActiveSessionAfterLogout();
  } else {
    const updated = await host.harness.getConfig({ reload: true });
    host.setAppState({
      availableModels: updated.models ?? {},
      availableProviders: updated.providers ?? {},
    });
  }

  host.track('logout', { provider: target });
  const label = OAUTH_PROVIDERS.find((provider) => provider.id === target)?.label ?? target;
  host.showStatus(`Logged out from ${label}.`);
}
