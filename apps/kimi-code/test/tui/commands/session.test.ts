import { describe, expect, it, vi } from 'vitest';

import type { SessionTurn } from '@moonshot-ai/kimi-code-sdk';
import {
  createSessionTreeChoices,
  handleTreeCommand,
} from '#/tui/commands/session';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { findBuiltInSlashCommand, resolveSlashCommandAvailability } from '#/tui/commands';

const { copyTextToClipboard } = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn(async () => 'native' as const),
}));
vi.mock('#/utils/clipboard/clipboard-text', () => ({ copyTextToClipboard }));

type MountedPanel = {
  handleInput(data: string): void;
  render(width: number): string[];
};

const ANSI_SGR = /\u001B\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function userTurn(prompt: string, turnIndex: number): SessionTurn {
  return { prompt, turnIndex };
}

function makeHost(turns: readonly SessionTurn[]) {
  let mountedPanel: MountedPanel | null = null;
  const source = {
    id: 'source-session',
    summary: { title: 'Original session' },
    listTurns: vi.fn(async () => turns),
  };
  const forked = { id: 'forked-session' };
  const harness = {
    forkSession: vi.fn(async () => forked),
  };
  const host = {
    state: {
      appState: {
        sessionTitle: 'Original session',
        streamingPhase: 'idle',
        isCompacting: false,
      },
    },
    session: source,
    harness,
    mountEditorReplacement: vi.fn((panel: MountedPanel) => {
      mountedPanel = panel;
    }),
    restoreEditor: vi.fn(() => {
      mountedPanel = null;
    }),
    switchToSession: vi.fn(async () => {}),
    showStatus: vi.fn(),
    showError: vi.fn(),
  } as unknown as SlashCommandHost & {
    session: typeof source;
    harness: typeof harness;
    restoreEditor: ReturnType<typeof vi.fn>;
    switchToSession: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
  };
  return { host, source, forked, getMountedPanel: () => mountedPanel };
}

describe('/tree', () => {
  it('is registered as an idle-only built-in', () => {
    const command = findBuiltInSlashCommand('tree');
    expect(command).toBeDefined();
    expect(resolveSlashCommandAvailability(command!, '')).toBe('idle-only');
  });

  it('builds one indexed tree row per user turn', () => {
    const choices = createSessionTreeChoices([
      userTurn('first prompt', 0),
      userTurn('second prompt', 1),
    ]);

    expect(choices).toEqual([
      { value: '0', turnIndex: 0, copyText: 'first prompt', label: '├─ first prompt' },
      { value: '1', turnIndex: 1, copyText: 'second prompt', label: '└─ second prompt' },
    ]);
  });

  it('renders a searchable Kimi-style selector and forks at the selected turn', async () => {
    const turns = [
      userTurn('first prompt', 0),
      userTurn('second prompt', 1),
      userTurn('third prompt', 2),
    ];
    const { host, source, forked, getMountedPanel } = makeHost(turns);

    await handleTreeCommand(host, '');
    const panel = getMountedPanel();
    expect(panel).not.toBeNull();
    const rendered = panel?.render(100).map(strip) ?? [];
    expect(rendered).toContain('  ❯ └─ third prompt ← current');
    expect(rendered.join('\n')).toContain('Fork from a turn  (type to search)');
    expect(rendered.join('\n')).toContain('↑↓ navigate · Ctrl-X copy · Enter select · Esc cancel');

    panel?.handleInput('\u0018');
    await vi.waitFor(() => {
      expect(copyTextToClipboard).toHaveBeenCalledWith('third prompt');
      expect(host.showStatus).toHaveBeenCalledWith('Copied selected turn to clipboard.');
    });

    panel?.handleInput('\u001B[A');
    panel?.handleInput('\r');

    await vi.waitFor(() => {
      expect(host.harness.forkSession).toHaveBeenCalledWith({
        id: source.id,
        title: 'Fork: Original session',
        turnIndex: 1,
      });
    });
    await vi.waitFor(() => {
      expect(host.switchToSession).toHaveBeenCalledWith(
        forked,
        expect.stringContaining('Session forked from turn 2'),
      );
    });
  });

  it('reports an empty session without mounting a selector', async () => {
    const { host } = makeHost([]);

    await handleTreeCommand(host, '');

    expect(host.showStatus).toHaveBeenCalledWith('No user turns in this session.', 'warning');
    expect(host.showError).not.toHaveBeenCalled();
  });
});
