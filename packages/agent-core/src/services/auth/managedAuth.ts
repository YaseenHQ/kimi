import { readConfigFile, writeConfigFile } from '../../config';
import type { KimiConfig, OAuthRef } from '../../config';
import type { OAuthTokenProviderResolver } from '../../session/provider-manager';
import {
  applyManagedKimiCodeConfig,
  applyManagedKimiCodeLogoutConfig,
  applyOpenAICodexConfig,
  ANTHROPIC_OAUTH_KEY,
  ANTHROPIC_PROVIDER_NAME,
  GITHUB_COPILOT_OAUTH_KEY,
  GITHUB_COPILOT_PROVIDER_NAME,
  KIMI_CODE_PROVIDER_NAME,
  KimiOAuthToolkit,
  OPENAI_CODEX_OAUTH_KEY,
  OPENAI_CODEX_PROVIDER_NAME,
  resolveKimiCodeLoginAuth,
  resolveKimiCodeRuntimeAuth,
  XAI_OAUTH_KEY,
  XAI_PROVIDER_NAME,
  type BearerTokenProvider,
  type KimiOAuthLoginOptions,
  type ManagedKimiConfigShape,
} from '@moonshot-ai/kimi-code-oauth';

import type { IEnvironmentService } from '../environment/environment';

type ServicesManagedConfig = KimiConfig & ManagedKimiConfigShape;

type ServicesAuthLoginOptions = Omit<KimiOAuthLoginOptions, 'provisionConfig'>;

interface ServicesAuthLoginResult {
  readonly providerName: string;
  readonly ok: true;
  readonly defaultModel: string;
  readonly defaultThinking: boolean;
  readonly configPath?: string | undefined;
}

interface ServicesAuthLogoutResult {
  readonly providerName: string;
  readonly ok: true;
}

export interface ServicesAuthFacade {
  login(
    providerName?: string | undefined,
    options?: ServicesAuthLoginOptions,
  ): Promise<ServicesAuthLoginResult>;
  logout(providerName?: string | undefined): Promise<ServicesAuthLogoutResult>;
  getCachedAccessToken(
    providerName?: string,
    oauthRef?: OAuthRef | undefined,
  ): Promise<string | undefined>;
  readonly resolveOAuthTokenProvider: OAuthTokenProviderResolver;
}

class ServicesManagedAuthFacade implements ServicesAuthFacade {
  private readonly toolkit: KimiOAuthToolkit<ServicesManagedConfig>;

  constructor(
    private readonly options: Pick<IEnvironmentService, 'homeDir' | 'configPath'>,
  ) {
    this.toolkit = new KimiOAuthToolkit<ServicesManagedConfig>({
      homeDir: options.homeDir,
      configAdapter: {
        configPath: options.configPath,
        read: () => readConfigFile(options.configPath) as ServicesManagedConfig,
        write: async (config) => {
          await writeConfigFile(options.configPath, config);
        },
        apply: applyManagedKimiCodeConfig,
        remove: applyManagedKimiCodeLogoutConfig,
      },
    });
  }

  async login(
    providerName: string | undefined = KIMI_CODE_PROVIDER_NAME,
    options: ServicesAuthLoginOptions = {},
  ): Promise<ServicesAuthLoginResult> {
    if (providerName === OPENAI_CODEX_PROVIDER_NAME) {
      const oauthRef = this.resolveProviderOAuthRef(providerName);
      await this.toolkit.login(providerName, {
        ...options,
        oauthRef,
        provisionConfig: false,
      });
      const config = readConfigFile(this.options.configPath);
      const provision = applyOpenAICodexConfig(config, {
        oauthRef,
        preserveDefaultModel: config.defaultModel !== undefined,
      });
      await writeConfigFile(this.options.configPath, config);
      return {
        providerName,
        ok: true,
        defaultModel: provision.defaultModel,
        defaultThinking: provision.defaultThinking,
        configPath: this.options.configPath,
      };
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
  ): Promise<ServicesAuthLogoutResult> {
    const result = await this.toolkit.logout(
      providerName,
      this.resolveProviderOAuthRef(providerName),
    );
    return {
      providerName: result.providerName,
      ok: result.ok,
    };
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
    return {
      getAccessToken: (options) => provider.getAccessToken(options),
      getRequestAuth: async (options) => {
        return provider.getRequestAuth !== undefined
          ? provider.getRequestAuth(options)
          : { apiKey: await provider.getAccessToken(options) };
      },
    };
  };

  private resolveManagedAuth(providerName?: string | undefined): {
    readonly oauthRef?: OAuthRef | undefined;
    readonly baseUrl?: string | undefined;
  } {
    const name = providerName ?? KIMI_CODE_PROVIDER_NAME;
    const config = readConfigFile(this.options.configPath);
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
    if ((providerName ?? KIMI_CODE_PROVIDER_NAME) !== KIMI_CODE_PROVIDER_NAME) {
      return oauthRef;
    }
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
}

export function createManagedAuthFacade(
  env: Pick<IEnvironmentService, 'homeDir' | 'configPath'>,
): ServicesAuthFacade {
  return new ServicesManagedAuthFacade(env);
}
