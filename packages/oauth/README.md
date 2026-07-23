# @moonshot-ai/kimi-code-oauth

Kimi Code's OAuth and managed-auth toolkit.

Part of the [Kimi Code](https://github.com/MoonshotAI/kimi-code) monorepo.

See the main repository for documentation, issues, and contribution guidelines.

## Provider OAuth adaptations

Kimi Code owns the authentication architecture. External implementations may
be used as protocol references, but they are not imported as authentication
frameworks.

When adapting another provider's OAuth flow:

- keep `config.toml` and Kimi's provider/model records as the configuration
  source of truth;
- keep credential persistence behind this package's token-storage boundary;
- expose login, logout, status, refresh, and request authentication through the
  existing Kimi SDK and service layers;
- keep provider/model discovery in Kimi's existing catalog refresh path;
- keep CLI and TUI interaction in `apps/kimi-code` rather than copying another
  application's login UI; and
- port only provider-specific authorization, refresh, and request-auth behavior.

The ignored `references/` checkouts are source references only. They must not
become workspace packages, production dependencies, configuration loaders, or
credential stores.

Add a shared abstraction only after a concrete provider requires behavior the
existing Kimi interfaces cannot represent. Document that requirement here and
cover the compatibility boundary with tests before adding another provider.

The first adaptations are xAI, OpenAI Codex, Anthropic, and GitHub Copilot. They are
expressed through the callback seam already provided by Kimi's `OAuthManager`;
token storage, refresh locking, status, logout, configuration, and UI remain
owned by the existing Kimi layers. Anthropic adds a browser/manual-code callback;
Codex, Anthropic, and Copilot derive their provider-specific request headers from
the fresh access token through the existing request-auth boundary.

## License

MIT
