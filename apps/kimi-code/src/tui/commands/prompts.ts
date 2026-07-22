import {
  catalogModelToAlias,
  resolveCatalogImport,
  type Catalog,
  type CatalogModel,
  type ModelAlias,
  type ThinkingEffort,
} from '@moonshot-ai/kimi-code-sdk';
import { capabilitiesForModel } from '@moonshot-ai/kimi-code-oauth';
import type {
  BrowserAuthorization,
  ManagedKimiCodeModelInfo,
  OpenPlatformDefinition,
} from '@moonshot-ai/kimi-code-oauth';

import { ApiKeyInputDialogComponent, type ApiKeyInputResult } from '../components/dialogs/api-key-input-dialog';
import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import { FeedbackInputDialogComponent, type FeedbackInputDialogResult } from '../components/dialogs/feedback-input-dialog';
import { ModelSelectorComponent } from '../components/dialogs/model-selector';
import type { SlashCommandHost } from './dispatch';
import { toTerminalHyperlink } from '#/utils/terminal-hyperlink';

export function promptLogoutProviderSelection(
  host: SlashCommandHost,
  options: readonly ChoiceOption[],
  currentValue: string | undefined,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const picker = new ChoicePickerComponent({
      title: 'Select a provider to log out',
      options,
      currentValue,
      onSelect: (value) => {
        host.restoreEditor();
        resolve(value);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

export interface FeedbackPromptResult {
  readonly value: string;
}

export function promptFeedbackInput(host: SlashCommandHost): Promise<FeedbackPromptResult | undefined> {
  return new Promise((resolve) => {
    const dialog = new FeedbackInputDialogComponent((result: FeedbackInputDialogResult) => {
      host.restoreEditor();
      resolve(result.kind === 'ok' ? { value: result.value } : undefined);
    });
    host.mountEditorReplacement(dialog);
  });
}

export type FeedbackAttachmentLevel = 'none' | 'logs' | 'logs+codebase';

const FEEDBACK_ATTACHMENT_OPTIONS: readonly ChoiceOption[] = [
  { value: 'none', label: 'No attachment', description: 'Text feedback only' },
  {
    value: 'logs',
    label: 'Logs only',
    description: 'Upload wire events and diagnostic logs from this session',
  },
  {
    value: 'logs+codebase',
    label: 'Logs + codebase',
    description:
      'Include your codebase for deeper diagnosis. Sensitive files are automatically excluded — e.g. .env, config files, secret keys. We use attachments only for diagnosis and never share them.',
    descriptionTone: 'warning',
  },
];

export function promptFeedbackAttachment(
  host: SlashCommandHost,
): Promise<FeedbackAttachmentLevel | undefined> {
  return new Promise((resolve) => {
    const picker = new ChoicePickerComponent({
      title: 'Share diagnostic info to help us investigate?',
      options: FEEDBACK_ATTACHMENT_OPTIONS,
      onSelect: (value) => {
        host.restoreEditor();
        resolve(value as FeedbackAttachmentLevel);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

export function promptApiKey(
  host: SlashCommandHost,
  platformName: string,
  subtitleLines: readonly string[] = ['Your key will be saved to ~/.kimi-code/config.toml'],
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const dialog = new ApiKeyInputDialogComponent(
      platformName,
      subtitleLines,
      (result: ApiKeyInputResult) => {
        host.restoreEditor();
        resolve(result.kind === 'ok' ? result.value : undefined);
      },
    );
    host.mountEditorReplacement(dialog);
  });
}

export function promptOAuthAuthorizationCode(
  host: SlashCommandHost,
  providerName: string,
  authorization: BrowserAuthorization,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      host.restoreEditor();
      resolve(value);
    };
    const dialog = new ApiKeyInputDialogComponent(
      providerName,
      [
        authorization.instructions,
        toTerminalHyperlink('Open authorization page', authorization.url),
      ],
      (result: ApiKeyInputResult) => {
        finish(result.kind === 'ok' ? result.value : undefined);
      },
      {
        title: `Complete ${providerName} login`,
        mask: false,
        emptyHint: 'Paste the authorization code or final redirect URL.',
      },
    );
    host.mountEditorReplacement(dialog);
    // When the owning login flow's local callback server captures the code,
    // it aborts this signal; resolve and unmount so the user is not left
    // staring at a now-redundant paste dialog.
    if (authorization.signal !== undefined) {
      if (authorization.signal.aborted) {
        finish(undefined);
      } else {
        authorization.signal.addEventListener(
          'abort',
          () => {
            finish(undefined);
          },
          { once: true },
        );
      }
    }
  });
}

/** Choose the OpenAI Codex login method: browser (PKCE + local server) or device-code. */
export function promptOpenAICodexLoginMethod(
  host: SlashCommandHost,
): Promise<'browser' | 'device_code' | undefined> {
  return new Promise((resolve) => {
    const picker = new ChoicePickerComponent({
      title: 'Select OpenAI Codex login method',
      options: [
        {
          value: 'browser',
          label: 'Browser login (default)',
          description: 'Opens a browser window; auto-captures the redirect.',
        },
        {
          value: 'device_code',
          label: 'Device code login (headless)',
          description: 'For machines without a local browser.',
        },
      ],
      onSelect: (value) => {
        host.restoreEditor();
        resolve(value as 'browser' | 'device_code');
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

/**
 * Asks for the provider endpoint the catalog did not declare (or declared
 * only as an env placeholder) — required for catalog imports whose protocol
 * was guessed, where the built-in default endpoint would point at the wrong
 * host. Esc cancels the import.
 */
export function promptBaseUrl(host: SlashCommandHost, platformName: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const dialog = new ApiKeyInputDialogComponent(
      platformName,
      ['The catalog declares no endpoint for this provider — enter its base URL.'],
      (result: ApiKeyInputResult) => {
        host.restoreEditor();
        resolve(result.kind === 'ok' ? result.value : undefined);
      },
      {
        title: `Enter base URL for ${platformName}`,
        mask: false,
        emptyHint: 'Base URL cannot be empty.',
      },
    );
    host.mountEditorReplacement(dialog);
  });
}

export function promptCatalogProviderSelection(host: SlashCommandHost, catalog: Catalog): Promise<string | undefined> {
  return new Promise((resolve) => {
    const options: ChoiceOption[] = Object.entries(catalog)
      .filter(([, entry]) => resolveCatalogImport(entry).kind !== 'invalid')
      .map(([id, entry]) => ({
        value: id,
        label: entry.name ?? id,
        description:
          typeof entry.api === 'string' && entry.api.length > 0 ? entry.api : undefined,
      }))
      .toSorted((a, b) => a.label.localeCompare(b.label));

    if (options.length === 0) {
      host.showError('Catalog has no providers with supported wire types.');
      resolve(undefined);
      return;
    }

    const picker = new ChoicePickerComponent({
      title: 'Select a provider',
      options,
      searchable: true,
      onSelect: (value) => {
        host.restoreEditor();
        resolve(value);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

export async function promptModelSelectionForOpenPlatform(
  host: SlashCommandHost,
  models: ManagedKimiCodeModelInfo[],
  platform: OpenPlatformDefinition,
): Promise<{ model: ManagedKimiCodeModelInfo; thinking: ThinkingEffort } | undefined> {
  const modelDict: Record<string, ModelAlias> = {};
  for (const m of models) {
    modelDict[`${platform.id}/${m.id}`] = {
      provider: platform.id,
      model: m.id,
      maxContextSize: m.contextLength,
      capabilities: capabilitiesForModel(m),
      displayName: m.displayName,
    };
  }
  const selection = await runModelSelector(host, modelDict);
  if (selection === undefined) return undefined;
  const model = models.find((m) => `${platform.id}/${m.id}` === selection.alias);
  return model ? { model, thinking: selection.thinking } : undefined;
}

export async function promptModelSelectionForCatalog(
  host: SlashCommandHost,
  providerId: string,
  models: CatalogModel[],
): Promise<{ model: CatalogModel; thinking: ThinkingEffort } | undefined> {
  const modelDict: Record<string, ModelAlias> = {};
  for (const m of models) {
    modelDict[`${providerId}/${m.id}`] = catalogModelToAlias(providerId, m);
  }
  const selection = await runModelSelector(host, modelDict);
  if (selection === undefined) return undefined;
  const model = models.find((m) => `${providerId}/${m.id}` === selection.alias);
  return model ? { model, thinking: selection.thinking } : undefined;
}

export function runModelSelector(
  host: SlashCommandHost,
  modelDict: Record<string, ModelAlias>,
): Promise<{ alias: string; thinking: ThinkingEffort } | undefined> {
  return new Promise((resolve) => {
    const firstAlias = Object.keys(modelDict)[0] ?? '';
    const caps = modelDict[firstAlias]?.capabilities ?? [];
    const initialThinking = caps.includes('always_thinking') || caps.includes('thinking');
    const selector = new ModelSelectorComponent({
      models: modelDict,
      currentValue: firstAlias,
      currentThinkingEffort: initialThinking ? 'on' : 'off',
      searchable: true,
      onSelect: ({ alias, thinking }) => {
        host.restoreEditor();
        resolve({ alias, thinking });
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(selector);
  });
}
