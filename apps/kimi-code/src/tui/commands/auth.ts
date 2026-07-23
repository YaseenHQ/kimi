import type { ChoiceOption } from '../components/dialogs/choice-picker';
import type { SlashCommandHost } from './dispatch';
import { handleProviderAdd } from './provider';
import { OAUTH_PROVIDERS } from './provider-login';
import {
  promptConfirmProviderConfigurationRemoval,
  promptLogoutProviderSelection,
  promptProviderConfigurationRemoval,
} from './prompts';

// ---------------------------------------------------------------------------
// Auth: login / logout
// ---------------------------------------------------------------------------

export async function handleLoginCommand(host: SlashCommandHost): Promise<void> {
  await handleProviderAdd(host);
}

export async function handleLogoutCommand(host: SlashCommandHost): Promise<void> {
  const config = await host.harness.getConfig();
  const oauthIds = new Set(OAUTH_PROVIDERS.map((provider) => provider.id));
  const oauthTargets: CredentialTarget[] = [];
  for (const provider of OAUTH_PROVIDERS) {
    const status = await host.harness.auth.status(provider.id);
    const hasToken = status.providers.some(
      (entry) => entry.providerName === provider.id && entry.hasToken,
    );
    if (hasToken) {
      oauthTargets.push({
        id: provider.id,
        value: `oauth:${provider.id}`,
        label: `${provider.label} (OAuth)`,
        kind: 'oauth',
      });
    }
  }
  const apiKeyTargets: CredentialTarget[] = [];
  for (const id of Object.keys(config.providers).toSorted()) {
    const provider = config.providers[id];
    if (provider === undefined || !hasConfiguredApiKey(provider)) continue;
    apiKeyTargets.push({
      id,
      value: `api-key:${id}`,
      label: `${id} (API key)`,
      kind: 'api-key',
    });
  }

  const targets = [...oauthTargets, ...apiKeyTargets];
  const options = credentialLogoutOptions(oauthTargets, apiKeyTargets);
  const removalGroups = providerRemovalGroups(config.providers, oauthIds);
  if (removalGroups.length > 0) {
    options.push({
      value: REMOVE_CONFIGURATION,
      label: 'Remove saved provider configuration…',
      description: 'Permanently delete provider and model entries.',
      descriptionTone: 'warning',
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

  if (target === REMOVE_CONFIGURATION) {
    await handleProviderConfigurationRemoval(host, removalGroups, currentProvider, oauthIds);
    return;
  }

  const selectedTargets = resolveCredentialTargets(target, targets, oauthTargets, apiKeyTargets);
  if (selectedTargets.length === 0) return;
  await logoutCredentialTargets(host, config, selectedTargets, currentProvider);

  if (selectedTargets.length === 1) {
    host.track('logout', { provider: selectedTargets[0]!.id });
    host.showStatus(`Logged out from ${selectedTargets[0]!.label}.`);
  } else {
    host.track('logout', {
      providers: selectedTargets.map((entry) => entry.id),
      scope: 'bundle',
    });
    host.showStatus(`Logged out from ${String(selectedTargets.length)} providers.`);
  }
}

const ALL_OAUTH = '__logout_all_oauth__';
const ALL_API_KEYS = '__logout_all_api_keys__';
const ALL_CREDENTIALS = '__logout_all_credentials__';
const REMOVE_CONFIGURATION = '__remove_provider_configuration__';

interface CredentialTarget {
  readonly id: string;
  readonly value: string;
  readonly label: string;
  readonly kind: 'oauth' | 'api-key';
}

interface ProviderRemovalGroup {
  readonly value: string;
  readonly label: string;
  readonly providerIds: readonly string[];
  readonly providerLabels: readonly string[];
}

function credentialLogoutOptions(
  oauthTargets: readonly CredentialTarget[],
  apiKeyTargets: readonly CredentialTarget[],
): ChoiceOption[] {
  const options: ChoiceOption[] = [...oauthTargets, ...apiKeyTargets].map((target) => ({
    value: target.value,
    label: target.label,
    description: target.kind === 'oauth' ? 'OAuth account' : 'API key',
  }));
  if (oauthTargets.length > 1) {
    options.push(bundleOption(ALL_OAUTH, 'All OAuth accounts', oauthTargets));
  }
  if (apiKeyTargets.length > 1) {
    options.push(bundleOption(ALL_API_KEYS, 'All API-key providers', apiKeyTargets));
  }
  if (oauthTargets.length > 0 && apiKeyTargets.length > 0) {
    options.push(bundleOption(ALL_CREDENTIALS, 'All credentials', [...oauthTargets, ...apiKeyTargets]));
  }
  return options;
}

function bundleOption(
  value: string,
  label: string,
  targets: readonly CredentialTarget[],
): ChoiceOption {
  return {
    value,
    label,
    description: `Includes: ${targets.map((target) => target.label).join(', ')}`,
    descriptionTone: 'warning',
  };
}

function resolveCredentialTargets(
  value: string,
  allTargets: readonly CredentialTarget[],
  oauthTargets: readonly CredentialTarget[],
  apiKeyTargets: readonly CredentialTarget[],
): readonly CredentialTarget[] {
  if (value === ALL_OAUTH) return oauthTargets;
  if (value === ALL_API_KEYS) return apiKeyTargets;
  if (value === ALL_CREDENTIALS) return allTargets;
  const target = allTargets.find((entry) => entry.value === value);
  return target === undefined ? [] : [target];
}

async function logoutCredentialTargets(
  host: SlashCommandHost,
  config: Awaited<ReturnType<SlashCommandHost['harness']['getConfig']>>,
  targets: readonly CredentialTarget[],
  currentProvider: string | undefined,
): Promise<void> {
  const providerPatches: typeof config.providers = {};
  for (const target of targets) {
    if (target.kind === 'oauth') {
      await host.harness.auth.logout(target.id, { deprovisionConfig: false });
      continue;
    }
    const provider = config.providers[target.id];
    if (provider === undefined) continue;
    const env = { ...provider.env };
    for (const key of apiKeyEnvNames(provider.type)) {
      if (env[key] !== undefined) env[key] = '';
    }
    providerPatches[target.id] = {
      ...provider,
      apiKey: '',
      ...(provider.env === undefined ? {} : { env }),
    };
  }

  if (Object.keys(providerPatches).length > 0) {
    await host.harness.setConfig({ providers: providerPatches });
    await host.authFlow.refreshConfigAfterLogout();
  }
  if (targets.some((target) => target.id === currentProvider && target.kind === 'api-key')) {
    await host.authFlow.clearActiveSessionAfterLogout();
  }
}

function providerRemovalGroups(
  providers: Awaited<ReturnType<SlashCommandHost['harness']['getConfig']>>['providers'],
  oauthIds: ReadonlySet<string>,
): readonly ProviderRemovalGroup[] {
  const groups: ProviderRemovalGroup[] = [];
  const registryGroups = new Map<string, number>();
  for (const [id, provider] of Object.entries(providers).toSorted(([a], [b]) => a.localeCompare(b))) {
    const source = provider.source;
    if (
      source?.['kind'] === 'apiJson' &&
      typeof source['url'] === 'string' &&
      typeof source['apiKey'] === 'string'
    ) {
      const key = `${source['url']}\u0000${source['apiKey']}`;
      const existing = registryGroups.get(key);
      if (existing !== undefined) {
        const group = groups[existing]!;
        groups[existing] = {
          ...group,
          providerIds: [...group.providerIds, id],
          providerLabels: [...group.providerLabels, providerLabel(id, oauthIds)],
        };
        continue;
      }
      registryGroups.set(key, groups.length);
      groups.push({
        value: `registry:${String(groups.length)}`,
        label: `Registry: ${registryLabel(source['url'])}`,
        providerIds: [id],
        providerLabels: [providerLabel(id, oauthIds)],
      });
      continue;
    }
    groups.push({
      value: `provider:${id}`,
      label: providerLabel(id, oauthIds),
      providerIds: [id],
      providerLabels: [providerLabel(id, oauthIds)],
    });
  }
  return groups;
}

async function handleProviderConfigurationRemoval(
  host: SlashCommandHost,
  groups: readonly ProviderRemovalGroup[],
  currentProvider: string | undefined,
  oauthIds: ReadonlySet<string>,
): Promise<void> {
  const currentValue = groups.find((group) => group.providerIds.includes(currentProvider ?? ''))?.value;
  const selected = await promptProviderConfigurationRemoval(
    host,
    groups.map((group) => ({
      value: group.value,
      label: group.label,
      description:
        group.providerLabels.length > 1
          ? `Includes: ${group.providerLabels.join(', ')}`
          : 'Delete provider, models, and credentials.',
      descriptionTone: 'warning',
    })),
    currentValue,
  );
  const group = groups.find((entry) => entry.value === selected);
  if (group === undefined) return;
  if (!(await promptConfirmProviderConfigurationRemoval(host, group.label, group.providerLabels))) return;

  let updated = await host.harness.getConfig();
  for (const providerId of group.providerIds) {
    if (oauthIds.has(providerId)) {
      await host.harness.auth.logout(providerId, { deprovisionConfig: false });
    }
    updated = await host.harness.removeProvider(providerId);
  }
  if (group.providerIds.includes(currentProvider ?? '')) {
    await host.authFlow.refreshConfigAfterLogout();
    await host.authFlow.clearActiveSessionAfterLogout();
  } else {
    host.setAppState({
      availableProviders: updated.providers ?? {},
      availableModels: updated.models ?? {},
    });
  }
  host.track('provider_remove', { providers: group.providerIds });
  host.showStatus(`Removed ${group.label}.`);
}

function providerLabel(id: string, oauthIds: ReadonlySet<string>): string {
  if (!oauthIds.has(id)) return id;
  return OAUTH_PROVIDERS.find((provider) => provider.id === id)?.label ?? id;
}

function registryLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url;
  }
}

function hasConfiguredApiKey(provider: {
  readonly type: string;
  readonly apiKey?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
}): boolean {
  if (provider.apiKey?.trim()) return true;
  return apiKeyEnvNames(provider.type).some((key) => provider.env?.[key]?.trim());
}

function apiKeyEnvNames(providerType: string): readonly string[] {
  switch (providerType) {
    case 'anthropic':
      return ['ANTHROPIC_API_KEY'];
    case 'openai':
    case 'openai_responses':
      return ['OPENAI_API_KEY'];
    case 'kimi':
      return ['KIMI_API_KEY'];
    case 'google-genai':
      return ['GOOGLE_API_KEY'];
    case 'vertexai':
      return ['VERTEXAI_API_KEY', 'GOOGLE_API_KEY'];
    default:
      return [];
  }
}
