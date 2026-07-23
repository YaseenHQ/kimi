import { describe, expect, it, vi } from 'vitest';

import { handleProviderAdd } from '#/tui/commands/provider';

interface MountedDialog {
  handleInput(data: string): void;
  render(width: number): string[];
}

const ESC = String.fromCodePoint(27);
const DOWN = `${ESC}[B`;
const ENTER = '\r';
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

function render(dialog: MountedDialog): string {
  return dialog.render(120).join('\n').replaceAll(SGR, '');
}

function makeHost(): {
  readonly host: unknown;
  readonly mounted: () => MountedDialog;
} {
  let current: MountedDialog | undefined;
  const host = {
    mountEditorReplacement: vi.fn((dialog: MountedDialog) => {
      current = dialog;
    }),
    restoreEditor: vi.fn(),
  };
  return {
    host,
    mounted: () => {
      if (current === undefined) throw new Error('Expected a mounted dialog.');
      return current;
    },
  };
}

describe('provider connection flow', () => {
  it('routes OAuth to the Kimi, xAI, and Codex account provider list', async () => {
    const { host, mounted } = makeHost();
    const connecting = handleProviderAdd(host as never);

    expect(render(mounted())).toContain('Sign in with an account (OAuth)');
    expect(render(mounted())).toContain('Connect with an API key');
    expect(render(mounted())).not.toContain('Config.toml');

    mounted().handleInput(ENTER);
    await Promise.resolve();

    expect(render(mounted())).toContain('Sign in with an account (OAuth)');
    expect(render(mounted())).toContain('Kimi Code');
    expect(render(mounted())).toContain('xAI');
    expect(render(mounted())).toContain('OpenAI Codex');

    mounted().handleInput(ESC);
    await connecting;
  });

  it('routes API-key sign-in to both Kimi Platform regions and generic providers', async () => {
    const { host, mounted } = makeHost();
    const connecting = handleProviderAdd(host as never);

    mounted().handleInput(DOWN);
    mounted().handleInput(ENTER);
    await Promise.resolve();

    const output = render(mounted());
    expect(output).toContain('Connect with API key');
    expect(output).toContain('platform.kimi.com');
    expect(output).toContain('platform.kimi.ai');
    expect(output).toContain('Known API provider');
    expect(output).toContain('Custom registry (api.json)');

    mounted().handleInput(ESC);
    await connecting;
  });

  it('routes the API-key custom-registry option to registry import', async () => {
    const { host, mounted } = makeHost();
    const connecting = handleProviderAdd(host as never);

    mounted().handleInput(DOWN);
    mounted().handleInput(ENTER);
    await Promise.resolve();

    // Two Kimi Platform regions, known provider, then custom registry.
    mounted().handleInput(DOWN);
    mounted().handleInput(DOWN);
    mounted().handleInput(DOWN);
    mounted().handleInput(ENTER);
    await Promise.resolve();

    expect(render(mounted())).toContain('Import custom provider registry');

    mounted().handleInput(ESC);
    await connecting;
  });
});
