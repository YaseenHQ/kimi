/**
 * Local loopback OAuth callback server, shared by every browser / PKCE flow
 * (Anthropic on :53692, OpenAI Codex on :1455). Each browser flow races this
 * server against a manual-paste prompt so the user is never blocked when the
 * redirect cannot be captured automatically.
 *
 * Design choices:
 *   - `node:http` (Node-only). These flows are CLI-only; browser bundles never
 *     load this module. The provider adapters that depend on it are Node-only.
 *   - On listen failure (typically `EADDRINUSE`) we reject. The caller's race
 *     falls back to manual paste, but we surface the error rather than silently
 *     resolving `null` — a stale server from a crashed session should be
 *     visible, not hidden.
 *   - `waitForCode` resolves `{ code, state }` on a valid callback, or `null`
 *     when cancelled (the manual arm won the race). It is one-shot: subsequent
 *     callbacks are ignored after the first settle.
 *   - To stay reachable when the OS resolves `localhost` to either IPv4 or IPv6,
 *     we listen on both `127.0.0.1` and `::1` whenever the requested host is a
 *     loopback address. The advertised redirect URI remains `localhost` to match
 *     the OAuth providers' registered allow-lists.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { oauthErrorHtml, oauthSuccessHtml } from './oauth-page';

export interface CallbackServerOptions {
  /** Bind host. Must be a loopback address; the redirect carries the auth code. */
  readonly host: string;
  /** Bind port, provider-specific (53692 for Anthropic, 1455 for Codex). */
  readonly port: number;
  /** Path the OAuth provider redirects to (`/callback` or `/auth/callback`). */
  readonly path: string;
  /** Expected `state` query parameter; validated against every callback. */
  readonly expectedState: string;
  /** Success page body text, provider-branded. */
  readonly successMessage: string;
  /** Provider name for error messages. */
  readonly providerLabel: string;
}

export interface CallbackResult {
  readonly code: string;
  readonly state: string;
}

export interface CallbackServerHandle {
  /** The redirect URI registered with the OAuth provider. */
  readonly redirectUri: string;
  /** Resolves `{ code, state }` on capture, or `null` if cancelled. One-shot. */
  readonly waitForCode: () => Promise<CallbackResult | null>;
  /** Cancel a pending wait; the manual-paste arm of the race calls this on win. */
  readonly cancelWait: () => void;
  /** Stop listening and free the socket. Idempotent; safe in `finally`. */
  readonly close: () => void;
}

/** Loopback hosts only — the OAuth redirect carries the authorization code. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** Addresses we bind to for loopback callbacks so `localhost` works on IPv4- and IPv6-first systems. */
const LOOPBACK_BIND_HOSTS = ['127.0.0.1', '::1'];

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

export function runOAuthCallbackServer(options: CallbackServerOptions): Promise<CallbackServerHandle> {
  if (!isLoopbackHost(options.host)) {
    return Promise.reject(
      new Error(
        `OAuth callback host must be loopback (got ${options.host}); the redirect carries the authorization code.`,
      ),
    );
  }

  let settleWait: ((value: CallbackResult | null) => void) | undefined;
  const waitForCodePromise = new Promise<CallbackResult | null>((resolveWait) => {
    let settled = false;
    settleWait = (value: CallbackResult | null): void => {
      if (settled) return;
      settled = true;
      resolveWait(value);
    };
  });

  const bindHosts = LOOPBACK_BIND_HOSTS;

  const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
    try {
      const url = new URL(req.url ?? '', 'http://localhost');
      if (req.method !== undefined && req.method !== 'GET') {
        res.writeHead(405, { Allow: 'GET', 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Method Not Allowed');
        return;
      }
      if (url.pathname !== options.path) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(oauthErrorHtml('Callback route not found.'));
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error !== null) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          oauthErrorHtml(
            `${options.providerLabel} authentication did not complete.`,
            `Error: ${error}`,
          ),
        );
        return;
      }

      if (code === null || code.length === 0 || state === null) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(oauthErrorHtml('Missing code or state parameter.'));
        return;
      }

      if (state !== options.expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(oauthErrorHtml('State mismatch.'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(oauthSuccessHtml(options.successMessage));
      settleWait?.({ code, state });
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal error');
    }
  };

  return new Promise<CallbackServerHandle>((resolve, reject) => {
    const servers: Server[] = [];
    let listening = 0;
    let pending = bindHosts.length;
    let firstError: Error | undefined;
    let resolved = false;

    const closeAll = (): void => {
      for (const server of servers) {
        try {
          server.close();
        } catch {
          // already closed — safe in finally blocks
        }
      }
    };

    const maybeResolve = (): void => {
      if (resolved) return;
      if (pending !== 0) return;
      if (listening > 0) {
        resolved = true;
        const redirectUri = `http://localhost:${options.port}${options.path}`;
        resolve({
          redirectUri,
          waitForCode: () => waitForCodePromise,
          cancelWait: () => {
            settleWait?.(null);
          },
          close: closeAll,
        });
      } else {
        closeAll();
        resolved = true;
        reject(firstError ?? new Error('Unable to start OAuth callback server.'));
      }
    };

    function startOneServer(host: string): void {
      const server = createServer(requestHandler);
      servers.push(server);
      let startupSettled = false;

      const finishStartup = (ok: boolean, error?: Error): void => {
        if (startupSettled) return;
        startupSettled = true;
        pending -= 1;
        if (ok) listening += 1;
        else firstError ??= error;
        maybeResolve();
      };

      server.on('error', (err: NodeJS.ErrnoException) => {
        finishStartup(false, err);
      });

      server.listen(options.port, host, () => {
        finishStartup(true);
      });
    }

    for (const host of bindHosts) {
      startOneServer(host);
    }
  });
}
