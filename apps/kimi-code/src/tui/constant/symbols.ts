// Use U+25CF instead of U+23FA to avoid emoji/fallback rendering in terminals.
export const STATUS_BULLET = '● ';

// Shared transcript markers. Keep widths stable because message wrapping
// assumes the marker occupies the leading cells.
export const USER_MESSAGE_BULLET = '› ';
export const SUCCESS_MARK = '✓ ';
export const FAILURE_MARK = '✗ ';

// Semantic tool markers follow the restrained text-glyph vocabulary used by
// terminal-first coding agents. Colour communicates state; the glyph identifies
// the kind of work without relying on platform-specific emoji rendering.
export const GENERIC_TOOL_GLYPH = '⚙';
export const TOOL_GLYPHS: Readonly<Record<string, string>> = {
  AskUserQuestion: '→',
  Bash: '$',
  Edit: '←',
  FetchURL: '%',
  Glob: '✱',
  Grep: '✱',
  Read: '→',
  ReadMediaFile: '→',
  Skill: '→',
  WebSearch: '◈',
  Write: '←',
};

// Shared selector markers — keep every list picker visually consistent.
// SELECT_POINTER marks the highlighted row; CURRENT_MARK is appended to the
// row that is the currently-active value. See .agents/skills/write-tui/DESIGN.md.
export const SELECT_POINTER = '❯';
export const CURRENT_MARK = '← current';
