import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Session, SessionTurn } from '@moonshot-ai/kimi-code-sdk';

import { detectInstallSource } from '#/cli/update/source';
import { copyTextToClipboard } from '#/utils/clipboard/clipboard-text';
import { detectShellEnvironment } from '#/utils/process/shell-env';
import { toTerminalHyperlink } from '#/utils/terminal-hyperlink';
import { LLM_NOT_SET_MESSAGE, NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import { isAbortError } from '../utils/errors';
import { formatErrorMessage } from '../utils/event-payload';
import { buildExportMarkdown } from '../utils/export-markdown';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// Session commands
// ---------------------------------------------------------------------------

export async function handleTitleCommand(host: SlashCommandHost, args: string): Promise<void> {
  const title = args.trim();
  if (title.length === 0) {
    const current = host.state.appState.sessionTitle;
    host.showStatus(
      current !== null && current.length > 0
        ? `Session title: ${current}`
        : `Session title: (not set) — id: ${host.state.appState.sessionId}`,
    );
    return;
  }

  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const newTitle = title.slice(0, 200);
  try {
    await host.harness.renameSession({ id: session.id, title: newTitle });
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to set title: ${msg}`);
    return;
  }
  host.showStatus(`Session title set to: ${newTitle}`);
}

export async function handleForkCommand(host: SlashCommandHost, args: string): Promise<void> {
  void args;
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const sourceTitle = forkSourceTitle(host, session);
  let forked: Session;
  try {
    forked = await host.harness.forkSession({
      id: session.id,
      title: `Fork: ${sourceTitle}`,
    });
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to fork session: ${msg}`);
    return;
  }

  try {
    await host.switchToSession(
      forked,
      `Session forked (${forked.id}). To return to the original session: kimi -r ${session.id}`,
    );
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to switch to forked session: ${msg}`);
  }
}

export interface SessionTreeChoice extends ChoiceOption {
  readonly turnIndex: number;
  readonly copyText: string;
}

export function createSessionTreeChoices(
  turns: readonly SessionTurn[],
): readonly SessionTreeChoice[] {
  return turns.map((turn, index) => ({
    value: String(turn.turnIndex),
    turnIndex: turn.turnIndex,
    copyText: turn.prompt,
    label: `${index === turns.length - 1 ? '└─' : '├─'} ${turn.prompt}`,
  }));
}

export async function handleTreeCommand(host: SlashCommandHost, args: string): Promise<void> {
  if (args.trim().length > 0) {
    host.showError('Usage: /tree');
    return;
  }

  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  let choices: readonly SessionTreeChoice[];
  try {
    choices = createSessionTreeChoices(await session.listTurns());
  } catch (error) {
    host.showError(`Failed to load session tree: ${formatErrorMessage(error)}`);
    return;
  }

  if (choices.length === 0) {
    host.showStatus('No user turns in this session.', 'warning');
    return;
  }

  const byValue = new Map(choices.map((choice) => [choice.value, choice]));
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: 'Fork from a turn',
      options: choices,
      currentValue: choices.at(-1)?.value,
      searchable: true,
      onCopy: (option) => {
        const choice = byValue.get(option.value);
        if (choice === undefined) return;
        void copySessionTreeChoice(host, choice);
      },
      onSelect: (value) => {
        const choice = byValue.get(value);
        if (choice === undefined) return;
        host.restoreEditor();
        void forkFromTreeChoice(host, session, choice);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function copySessionTreeChoice(
  host: SlashCommandHost,
  choice: SessionTreeChoice,
): Promise<void> {
  try {
    const method = await copyTextToClipboard(choice.copyText);
    host.showStatus(
      method === 'native'
        ? 'Copied selected turn to clipboard.'
        : 'Copied selected turn via terminal escape sequence (unverified).',
    );
  } catch (error) {
    host.showError(`Failed to copy selected turn: ${formatErrorMessage(error)}`);
  }
}

async function forkFromTreeChoice(
  host: SlashCommandHost,
  source: Session,
  choice: SessionTreeChoice,
): Promise<void> {
  let forked: Session;
  try {
    forked = await host.harness.forkSession({
      id: source.id,
      title: `Fork: ${forkSourceTitle(host, source)}`,
      turnIndex: choice.turnIndex,
    });
  } catch (error) {
    host.showError(`Failed to fork session: ${formatErrorMessage(error)}`);
    return;
  }

  try {
    await host.switchToSession(
      forked,
      `Session forked from turn ${String(choice.turnIndex + 1)} (${forked.id}). ` +
        `To return to the original session: kimi -r ${source.id}`,
    );
  } catch (error) {
    host.showError(`Failed to switch to forked session: ${formatErrorMessage(error)}`);
  }
}

function forkSourceTitle(host: SlashCommandHost, session: Session): string {
  const currentTitle = host.state.appState.sessionTitle?.trim();
  if (currentTitle !== undefined && currentTitle.length > 0) return currentTitle;

  const summaryTitle =
    typeof session.summary?.title === 'string' ? session.summary.title.trim() : '';
  return summaryTitle.length > 0 ? summaryTitle : session.id;
}

export async function handleExportMdCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  host.showStatus('Exporting session as Markdown…');
  try {
    const context = await session.getContext();
    if (context.history.length === 0) {
      host.showError('No messages to export.');
      return;
    }

    const now = new Date();
    const shortId = session.id.slice(0, 8);
    const timestamp = now.toISOString().replaceAll(/[-:]/g, '').replace(/T/, '-').slice(0, 15);
    const defaultName = `kimi-export-${shortId}-${timestamp}.md`;

    const trimmedArgs = args.trim();
    const outputPath = trimmedArgs.length > 0
      ? resolve(trimmedArgs)
      : resolve(host.state.appState.workDir, defaultName);

    const md = buildExportMarkdown({
      sessionId: session.id,
      workDir: host.state.appState.workDir,
      history: context.history,
      tokenCount: context.tokenCount,
      now,
    });

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, md, 'utf-8');

    const linked = toTerminalHyperlink(outputPath, pathToFileURL(outputPath).href);
    host.showNotice(`Exported ${String(context.history.length)} messages`, linked);
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to export session: ${msg}`);
  }
}

export async function handleExportDebugZipCommand(host: SlashCommandHost): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  host.showStatus('Exporting session…');
  try {
    const installSource = await detectInstallSource();
    const shellEnv = detectShellEnvironment();
    const result = await host.harness.exportSession({
      id: session.id,
      version: host.state.appState.version,
      installSource,
      shellEnv,
      includeGlobalLog: true,
    });
    const linked = toTerminalHyperlink(result.zipPath, pathToFileURL(result.zipPath).href);
    host.showNotice('Export complete', linked);
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to export session: ${msg}`);
  }
}

export async function handleInitCommand(host: SlashCommandHost): Promise<void> {
  const session = host.session;
  if (host.state.appState.model.trim().length === 0 || session === undefined) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }

  host.deferUserMessages = true;
  host.beginSessionRequest();
  try {
    await session.init();
    host.track('init_complete');
    host.streamingUI.finalizeTurn((item) => {
      host.sendQueuedMessage(session, item);
    });
  } catch (error) {
    if (isAbortError(error)) {
      host.setAppState({ streamingPhase: 'idle' });
      host.resetLivePane();
      return;
    }
    const msg = error instanceof Error ? error.message : String(error);
    host.failSessionRequest(`Init failed: ${msg}`);
  } finally {
    host.deferUserMessages = false;
  }
}
