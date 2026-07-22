import {
  loadRuntimeConfigSafe,
  readConfigFile,
  readConfigFileForUpdate,
  writeConfigFile,
  type KimiConfig,
  type OAuthRef,
} from '@moonshot-ai/agent-core';
import {
  applyManagedKimiCodeConfig,
  applyManagedKimiCodeLogoutConfig,
  applyOpenAICodexConfig,
  ANTHROPIC_OAUTH_KEY,
  ANTHROPIC_PROVIDER_NAME,
  anthropicOAuthRequestHeaders,
  GITHUB_COPILOT_OAUTH_KEY,
  GITHUB_COPILOT_PROVIDER_NAME,
  enableGitHubCopilotModelsForIds,
  fetchGitHubCopilotModelIds,
  githubCopilotApiBaseUrl,
  normalizeGitHubDomain,
  githubCopilotRequestHeaders,
  KIMI_CODE_PROVIDER_NAME,
  KimiOAuthToolkit,
  OPENAI_CODEX_OAUTH_KEY,
  OPENAI_CODEX_PROVIDER_NAME,
  XAI_API_BASE_URL,
  XAI_OAUTH_KEY,
  XAI_PROVIDER_NAME,
  resolveKimiCodeLoginAuth,
  resolveKimiCodeRuntimeAuth,
  xaiWireTypeForModel,
  type AuthManagedUsageResult,
  type AuthStatus,
  type BearerTokenProvider,
  type FetchCompleteFeedbackUploadResult,
  type FetchFeedbackUploadError,
  type FetchSubmitFeedbackResult,
  type KimiHostIdentity,
  type KimiOAuthLoginOptions,
  type ManagedKimiConfigShape,
  type OAuthRefreshOutcome,
  openAICodexRequestHeaders,
} from '@moonshot-ai/kimi-code-oauth';

import { mapOAuthTokenError } from '#/oauth-error';
import {
  catalogModelToAlias,
  catalogProviderModels,
  DEFAULT_CATALOG_URL,
  fetchCatalog,
  resolveCatalogImport,
} from '#/catalog';

export interface KimiAuthSubmitFeedbackInput {
  readonly content: string;
  readonly sessionId: string;
  readonly version: string;
  readonly os: string;
  readonly model: string | null;
  readonly contact?: string;
  readonly info?: Record<string, unknown>;
}

export interface KimiAuthCreateFeedbackUploadUrlInput {
  readonly feedbackId: number;
  readonly filename: string;
  readonly size: number;
  readonly sha256: string;
}

export interface KimiAuthCompleteFeedbackUploadPart {
  readonly partNumber: number;
  readonly etag: string;
}

export interface KimiAuthCompleteFeedbackUploadInput {
  readonly uploadId: number;
  readonly parts: readonly KimiAuthCompleteFeedbackUploadPart[];
}

export interface KimiAuthFeedbackUploadPart {
  readonly partNumber: number;
  readonly url: string;
  readonly method: string;
  readonly size: number;
}

export interface KimiAuthCreateFeedbackUploadUrlOk {
  readonly kind: 'ok';
  readonly uploadId: number;
  readonly parts: readonly KimiAuthFeedbackUploadPart[];
}

export type KimiAuthCreateFeedbackUploadUrlResult =
  | KimiAuthCreateFeedbackUploadUrlOk
  | FetchFeedbackUploadError;

export type KimiAuthLoginOptions = Omit<KimiOAuthLoginOptions, 'provisionConfig'>;

export interface KimiAuthLoginResult {
  readonly providerName: string;
  readonly ok: true;
  readonly defaultModel: string;
  readonly defaultThinking: boolean;
  readonly configPath?: string | undefined;
}

export interface KimiAuthLogoutResult {
  readonly providerName: string;
  readonly ok: true;
}

export interface KimiAuthLogoutOptions {
  /** Keep the provider and model definitions while removing only the credential. */
  readonly deprovisionConfig?: boolean | undefined;
}

export interface KimiAuthFacadeOptions {
  readonly homeDir: string;
  readonly configPath: string;
  readonly identity?: KimiHostIdentity | undefined;
  readonly onConfigUpdated?: ((config: KimiConfig) => void) | undefined;
  readonly onRefresh?: ((outcome: OAuthRefreshOutcome) => void) | undefined;
}

type SDKManagedConfig = KimiConfig & ManagedKimiConfigShape;

export class KimiAuthFacade {
  private readonly toolkit: KimiOAuthToolkit<SDKManagedConfig>;

  constructor(private readonly options: KimiAuthFacadeOptions) {
    this.toolkit = new KimiOAuthToolkit<SDKManagedConfig>({
      homeDir: options.homeDir,
      identity: options.identity,
      onRefresh: options.onRefresh,
      configAdapter: {
        configPath: options.configPath,
        // Write-path base read: strict (a salvaged base would drop the user's
        // broken-but-fixable sections on rewrite) with an actionable message.
        read: () => readConfigFileForUpdate(options.configPath) as SDKManagedConfig,
        write: async (config) => {
          await writeConfigFile(options.configPath, config);
        },
        apply: applyManagedKimiCodeConfig,
        remove: applyManagedKimiCodeLogoutConfig,
      },
    });
  }

  async status(providerName?: string | undefined): Promise<AuthStatus> {
    return this.toolkit.status(providerName, this.resolveProviderOAuthRef(providerName));
  }

  async login(
    providerName: string | undefined = KIMI_CODE_PROVIDER_NAME,
    options: KimiAuthLoginOptions = {},
  ): Promise<KimiAuthLoginResult> {
    if (providerName === XAI_PROVIDER_NAME) {
      return this.loginWithXai(options);
    }
    if (providerName === OPENAI_CODEX_PROVIDER_NAME) {
      return this.loginWithOpenAICodex(options);
    }
    if (
      providerName === ANTHROPIC_PROVIDER_NAME ||
      providerName === GITHUB_COPILOT_PROVIDER_NAME
    ) {
      return this.loginWithCatalogOAuth(providerName, options);
    }
    const auth = this.resolveManagedAuth(providerName);
    const loginAuth = resolveKimiCodeLoginAuth({
      configuredBaseUrl: auth.baseUrl,
      configuredOAuthRef: auth.oauthRef,
      requestedBaseUrl: options.baseUrl,
      requestedOAuthHost: options.oauthHost,
    });
    const result = await this.toolkit.login(providerName, {
      ...options,
      baseUrl: loginAuth.baseUrl,
      oauthHost: loginAuth.oauthHost,
      oauthRef: options.oauthRef ?? loginAuth.oauthRef,
      provisionConfig: true,
    });
    if (result.provision === undefined) {
      throw new Error('Kimi auth login did not provision model config.');
    }
    const updated = readConfigFile(this.options.configPath);
    this.options.onConfigUpdated?.(updated);
    return {
      providerName: result.providerName,
      ok: true,
      defaultModel: result.provision.defaultModel,
      defaultThinking: result.provision.defaultThinking,
      configPath: result.provision.configPath,
    };
  }

  async logout(
    providerName?: string | undefined,
    options: KimiAuthLogoutOptions = {},
  ): Promise<KimiAuthLogoutResult> {
    const result = await this.toolkit.logout(
      providerName,
      this.resolveProviderOAuthRef(providerName),
      { deprovisionConfig: options.deprovisionConfig },
    );
    const updated = readConfigFile(this.options.configPath);
    this.options.onConfigUpdated?.(updated);
    return {
      providerName: result.providerName,
      ok: result.ok,
    };
  }

  async getManagedUsage(providerName?: string | undefined): Promise<AuthManagedUsageResult> {
    const auth = this.resolveRuntimeManagedAuth(providerName);
    return this.toolkit.getManagedUsage(providerName, {
      oauthRef: auth.oauthRef,
      baseUrl: auth.baseUrl,
    });
  }

  async submitFeedback(
    input: KimiAuthSubmitFeedbackInput,
    providerName?: string | undefined,
  ): Promise<FetchSubmitFeedbackResult> {
    const auth = this.resolveRuntimeManagedAuth(providerName);
    return this.toolkit.submitFeedback(
      {
        session_id: input.sessionId,
        content: input.content,
        version: input.version,
        os: input.os,
        model: input.model,
        contact: input.contact,
        info: input.info,
      },
      providerName,
      {
        oauthRef: auth.oauthRef,
        baseUrl: auth.baseUrl,
      },
    );
  }

  async createFeedbackUploadUrl(
    input: KimiAuthCreateFeedbackUploadUrlInput,
    providerName?: string | undefined,
  ): Promise<KimiAuthCreateFeedbackUploadUrlResult> {
    const auth = this.resolveRuntimeManagedAuth(providerName);
    const result = await this.toolkit.createFeedbackUploadUrl(
      {
        file_hash: input.sha256,
        file_name: input.filename,
        file_size: input.size,
        feedback_id: input.feedbackId,
      },
      providerName,
      {
        oauthRef: auth.oauthRef,
        baseUrl: auth.baseUrl,
      },
    );
    if (result.kind !== 'ok') return result;
    return {
      kind: 'ok',
      uploadId: result.upload_id,
      parts: result.parts.map((part) => ({
        partNumber: part.part_number,
        url: part.url,
        method: part.method,
        size: part.size,
      })),
    };
  }

  async completeFeedbackUpload(
    input: KimiAuthCompleteFeedbackUploadInput,
    providerName?: string | undefined,
  ): Promise<FetchCompleteFeedbackUploadResult> {
    const auth = this.resolveRuntimeManagedAuth(providerName);
    return this.toolkit.completeFeedbackUpload(
      {
        upload_id: input.uploadId,
        parts: input.parts.map((part) => ({ part_number: part.partNumber, etag: part.etag })),
      },
      providerName,
      {
        oauthRef: auth.oauthRef,
        baseUrl: auth.baseUrl,
      },
    );
  }

  async getCachedAccessToken(
    providerName?: string,
    oauthRef?: OAuthRef | undefined,
  ): Promise<string | undefined> {
    return this.toolkit.getCachedAccessToken(
      providerName,
      this.runtimeOAuthRef(providerName, oauthRef),
    );
  }

  readonly resolveOAuthTokenProvider = (
    providerName: string,
    oauthRef?: OAuthRef | undefined,
  ): BearerTokenProvider => {
    const runtimeRef = this.runtimeOAuthRef(providerName, oauthRef);
    const provider = this.toolkit.tokenProvider(
      providerName,
      runtimeRef,
    );
    const getAccessToken = async (options?: { readonly force?: boolean }): Promise<string> => {
      try {
        return await provider.getAccessToken(options);
      } catch (error) {
        // Classify OAuth token failures into the public KimiError protocol;
        // unrecognized errors are rethrown raw (see mapOAuthTokenError).
        throw mapOAuthTokenError(error, providerName) ?? error;
      }
    };
    return {
      getAccessToken,
      getRequestAuth: async (options) => {
        const apiKey = await getAccessToken(options);
        if (providerName === OPENAI_CODEX_PROVIDER_NAME) {
          return { apiKey, headers: openAICodexRequestHeaders(apiKey) };
        }
        if (providerName === ANTHROPIC_PROVIDER_NAME) {
          return { apiKey, headers: anthropicOAuthRequestHeaders(apiKey) };
        }
        if (providerName === GITHUB_COPILOT_PROVIDER_NAME) {
          const enterpriseDomain = normalizeGitHubDomain(runtimeRef?.oauthHost) ?? undefined;
          return {
            apiKey,
            headers: githubCopilotRequestHeaders(apiKey),
            baseUrl: githubCopilotApiBaseUrl(apiKey, enterpriseDomain),
          };
        }
        return { apiKey };
      },
    };
  };

  private resolveManagedAuth(providerName?: string | undefined): {
    readonly oauthRef?: OAuthRef | undefined;
    readonly baseUrl?: string | undefined;
  } {
    const name = providerName ?? KIMI_CODE_PROVIDER_NAME;
    // Read path: token/status resolution must work off a degraded config
    // instead of failing the session when an unrelated section is broken.
    // Write paths (the toolkit's configAdapter.read) stay strict.
    const config = loadRuntimeConfigSafe(this.options.configPath).config;
    const provider = config.providers[name];
    return {
      oauthRef: provider?.oauth,
      baseUrl: provider?.baseUrl,
    };
  }

  private resolveRuntimeManagedAuth(providerName?: string | undefined): {
    readonly oauthRef: OAuthRef;
    readonly baseUrl?: string | undefined;
  } {
    const auth = this.resolveManagedAuth(providerName);
    return resolveKimiCodeRuntimeAuth({
      configuredBaseUrl: auth.baseUrl,
      configuredOAuthRef: auth.oauthRef,
    });
  }

  private runtimeOAuthRef(
    providerName: string | undefined,
    oauthRef?: OAuthRef | undefined,
  ): OAuthRef | undefined {
    if ((providerName ?? KIMI_CODE_PROVIDER_NAME) !== KIMI_CODE_PROVIDER_NAME) return oauthRef;
    const auth = this.resolveManagedAuth(providerName);
    return resolveKimiCodeRuntimeAuth({
      configuredBaseUrl: auth.baseUrl,
      configuredOAuthRef: oauthRef ?? auth.oauthRef,
    }).oauthRef;
  }

  private resolveProviderOAuthRef(providerName?: string | undefined): OAuthRef {
    if (providerName === OPENAI_CODEX_PROVIDER_NAME) {
      return (
        this.resolveManagedAuth(providerName).oauthRef ?? {
          storage: 'file',
          key: OPENAI_CODEX_OAUTH_KEY,
        }
      );
    }
    if (providerName === XAI_PROVIDER_NAME) {
      return (
        this.resolveManagedAuth(providerName).oauthRef ?? {
          storage: 'file',
          key: XAI_OAUTH_KEY,
        }
      );
    }
    if (providerName === ANTHROPIC_PROVIDER_NAME) {
      return (
        this.resolveManagedAuth(providerName).oauthRef ?? {
          storage: 'file',
          key: ANTHROPIC_OAUTH_KEY,
        }
      );
    }
    if (providerName === GITHUB_COPILOT_PROVIDER_NAME) {
      return (
        this.resolveManagedAuth(providerName).oauthRef ?? {
          storage: 'file',
          key: GITHUB_COPILOT_OAUTH_KEY,
        }
      );
    }
    return this.resolveRuntimeManagedAuth(providerName).oauthRef;
  }

  private async loginWithCatalogOAuth(
    providerName: typeof ANTHROPIC_PROVIDER_NAME | typeof GITHUB_COPILOT_PROVIDER_NAME,
    options: KimiAuthLoginOptions,
  ): Promise<KimiAuthLoginResult> {
    const oauthRef = this.resolveProviderOAuthRef(providerName);
    await this.toolkit.login(providerName, {
      ...options,
      oauthRef,
      provisionConfig: false,
    });

    const catalog = await fetchCatalog(DEFAULT_CATALOG_URL);
    const entry = catalog[providerName];
    if (entry === undefined) {
      throw new Error(`The models.dev catalog does not contain ${providerName}.`);
    }
    const resolution = resolveCatalogImport(entry);
    if (resolution.kind !== 'ok') {
      throw new Error(`The models.dev ${providerName} entry is not importable.`);
    }
    let models = catalogProviderModels(entry);
    let providerBaseUrl = resolution.baseUrl;
    if (providerName === GITHUB_COPILOT_PROVIDER_NAME) {
      const enterpriseDomain = normalizeGitHubDomain(options.oauthHost) ?? undefined;
      const accessToken = await this.toolkit.getCachedAccessToken(providerName, oauthRef);
      if (accessToken !== undefined) {
        // Re-derive per login; runtime re-derives again per request from the
        // fresh token, so proxy-ep rotation does not strand requests.
        providerBaseUrl = githubCopilotApiBaseUrl(accessToken, enterpriseDomain);
        try {
          // `models` is still the unfiltered static catalog here. Enable those
          // known ids before live discovery removes disabled-policy entries;
          // never mutate arbitrary ids returned only by the remote endpoint.
          await enableGitHubCopilotModelsForIds(
            accessToken,
            models.map((model) => model.id),
            enterpriseDomain,
          );
          const available = new Set(
            await fetchGitHubCopilotModelIds(accessToken, options.signal, enterpriseDomain),
          );
          const filtered = models.filter((model) => available.has(model.id));
          if (filtered.length > 0) models = filtered;
        } catch {
          // The shared catalog remains a safe fallback when discovery is unavailable.
        }
      }
    }
    if (models.length === 0) {
      throw new Error(`The models.dev catalog contains no usable ${providerName} models.`);
    }

    const config = readConfigFileForUpdate(this.options.configPath);
    config.providers[providerName] = {
      type: resolution.wire,
      // Persist a usable initial endpoint; request auth re-derives it from the
      // current token so a refreshed proxy-ep takes effect without re-login.
      baseUrl: providerBaseUrl,
      // Persist the enterprise host (GHES) on the oauth ref so device-auth and
      // token refresh hit the enterprise endpoints on every subsequent session.
      oauth:
        providerName === GITHUB_COPILOT_PROVIDER_NAME && options.oauthHost !== undefined
          ? { ...oauthRef, oauthHost: options.oauthHost }
          : oauthRef,
    };
    const aliases = config.models ?? {};
    for (const [alias, model] of Object.entries(aliases)) {
      if (model.provider === providerName) delete aliases[alias];
    }
    for (const model of models) {
      aliases[`${providerName}/${model.id}`] = catalogModelToAlias(providerName, model);
    }
    config.models = aliases;

    let defaultModel = config.defaultModel;
    if (defaultModel === undefined || aliases[defaultModel] === undefined) {
      defaultModel = `${providerName}/${models[0]!.id}`;
      config.defaultModel = defaultModel;
      const capabilities = aliases[defaultModel]?.capabilities ?? [];
      config.thinking = {
        ...config.thinking,
        enabled: capabilities.includes('thinking') || capabilities.includes('always_thinking'),
      };
    }
    await writeConfigFile(this.options.configPath, config);
    this.options.onConfigUpdated?.(config);
    return {
      providerName,
      ok: true,
      defaultModel,
      defaultThinking: config.thinking?.enabled ?? false,
      configPath: this.options.configPath,
    };
  }

  private async loginWithXai(options: KimiAuthLoginOptions): Promise<KimiAuthLoginResult> {
    const oauthRef = this.resolveProviderOAuthRef(XAI_PROVIDER_NAME);
    await this.toolkit.login(XAI_PROVIDER_NAME, {
      ...options,
      oauthRef,
      provisionConfig: false,
    });

    const catalog = await fetchCatalog(DEFAULT_CATALOG_URL);
    const entry = catalog[XAI_PROVIDER_NAME];
    if (entry === undefined) throw new Error('The models.dev catalog does not contain xAI.');
    const models = catalogProviderModels(entry);
    if (models.length === 0) throw new Error('The models.dev catalog contains no usable xAI models.');

    const config = readConfigFileForUpdate(this.options.configPath);
    // Default provider wire is Chat Completions ('openai') — the safe transport
    // for grok-4.3 / grok-build-0.1. Models that speak the Responses API
    // (grok-4.5) override this per-alias via `wire` (honored by the provider
    // manager). models.dev does not expose per-model wire, so we resolve it
    // from xaiWireTypeForModel, which mirrors pi's authoritative model table.
    config.providers[XAI_PROVIDER_NAME] = {
      type: 'openai',
      baseUrl: XAI_API_BASE_URL,
      oauth: oauthRef,
    };
    const aliases = config.models ?? {};
    for (const [alias, model] of Object.entries(aliases)) {
      if (model.provider === XAI_PROVIDER_NAME) delete aliases[alias];
    }
    for (const model of models) {
      const alias = catalogModelToAlias(XAI_PROVIDER_NAME, model);
      const wire = xaiWireTypeForModel(model.id);
      if (wire === 'openai_responses') {
        // Only stamp the override when it differs from the provider default;
        // leaving it unset for Chat-Completions models keeps the alias clean.
        alias.wire = 'openai_responses';
      }
      aliases[`${XAI_PROVIDER_NAME}/${model.id}`] = alias;
    }
    config.models = aliases;

    let defaultModel = config.defaultModel;
    if (defaultModel === undefined || aliases[defaultModel] === undefined) {
      defaultModel = `${XAI_PROVIDER_NAME}/${models[0]!.id}`;
      config.defaultModel = defaultModel;
      const capabilities = aliases[defaultModel]?.capabilities ?? [];
      config.thinking = {
        ...config.thinking,
        enabled: capabilities.includes('thinking') || capabilities.includes('always_thinking'),
      };
    }
    await writeConfigFile(this.options.configPath, config);
    this.options.onConfigUpdated?.(config);
    return {
      providerName: XAI_PROVIDER_NAME,
      ok: true,
      defaultModel,
      defaultThinking: config.thinking?.enabled ?? false,
      configPath: this.options.configPath,
    };
  }

  private async loginWithOpenAICodex(
    options: KimiAuthLoginOptions,
  ): Promise<KimiAuthLoginResult> {
    const oauthRef = this.resolveProviderOAuthRef(OPENAI_CODEX_PROVIDER_NAME);
    await this.toolkit.login(OPENAI_CODEX_PROVIDER_NAME, {
      ...options,
      oauthRef,
      provisionConfig: false,
    });

    const config = readConfigFileForUpdate(this.options.configPath);
    const provision = applyOpenAICodexConfig(config, {
      oauthRef,
      preserveDefaultModel: config.defaultModel !== undefined,
    });
    await writeConfigFile(this.options.configPath, config);
    this.options.onConfigUpdated?.(config);
    return {
      providerName: OPENAI_CODEX_PROVIDER_NAME,
      ok: true,
      defaultModel: provision.defaultModel,
      defaultThinking: provision.defaultThinking,
      configPath: this.options.configPath,
    };
  }
}
