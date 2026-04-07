/**
 * AgentProfile — pluggable agent-specific patterns for log filtering.
 *
 * Three roles:
 *   - isChrome(line): drop entirely (TUI borders, status bar, etc.)
 *   - isImmediate(line): log immediately without debounce (known-final content)
 *   - normalize(line): canonical form for dedup (strip spinner prefixes, counters)
 *     Returns null to drop the line.
 */

export interface AgentProfile {
  id: string;
  /** TUI chrome — drop entirely from logs */
  isChrome(line: string): boolean;
  /** Known-final content — log immediately, skip settle debounce */
  isImmediate(line: string): boolean;
  /** Normalize for dedup. Returns canonical form, or null to drop. */
  normalize(line: string): string | null;
}

// ===========================
// Copilot CLI profile
// ===========================

// --- Chrome patterns (drop entirely) ---

const BOX_BORDER = /^[│╭╮╰╯┌┐└┘]/;
const SEPARATOR = /^[─═]{3,}/;
const LOGO_ART = /^[█▔╴╶▘▝▖▗░▒▓\s]+$/;
const BANNER_CONTENT = /^\s*(╭─╮|╰─╯|GitHub Copilot v|Describe a task|Tip:|Copilot uses AI)/;
const STATUS_BAR = /^\s*(shift\+tab|ctrl\+[a-z]|Type @ to mention|press esc)/i;
const INPUT_PLACEHOLDER = /^❯\s+(Type @ to mention|Type \/|Type \?)/;
// Path + model status line:  ~\path [⎇ branch]   Model (Nx) (quality)
const PATH_STATUS = /^\s*~[\\\/].+\[⎇/;

// --- Spinner chars used by Copilot CLI ---
const SPINNER_CHARS = '●◉◎○◐◑◒◓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏▋';
const SPINNER_PREFIX = new RegExp(`^[${SPINNER_CHARS.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}]\\s+`);

// --- Immediate patterns (known-final, log without debounce) ---
// ● with text = settled response/result (● is the final spinner state in Copilot)
const SETTLED_RESPONSE = /^●\s+.+/;
// Tool output tree lines
const TOOL_OUTPUT = /^\s*[└│├┌]\s+/;

// --- Normalize: collapse spinner + strip live counters ---
// "◎ Thinking (Esc to cancel · 402 B)" → "Thinking"
const THINKING_LINE = /^[●◉◎○◐◑◒◓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏▋]\s+(.*?)\s*\(Esc to cancel[^)]*\)\s*$/;
// "◎ Loading environment: 22 skills" → "Loading environment: 22 skills"
// Generic: strip spinner prefix for dedup
const HAS_SPINNER = new RegExp(`^[${SPINNER_CHARS.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}]\\s+`);

export const copilotProfile: AgentProfile = {
  id: 'copilot',

  isChrome(line: string): boolean {
    const t = line.trim();
    if (t.length === 0) return true;
    return (
      BOX_BORDER.test(t) ||
      SEPARATOR.test(t) ||
      LOGO_ART.test(t) ||
      BANNER_CONTENT.test(t) ||
      STATUS_BAR.test(t) ||
      INPUT_PLACEHOLDER.test(t) ||
      PATH_STATUS.test(t)
    );
  },

  isImmediate(line: string): boolean {
    const t = line.trim();
    return SETTLED_RESPONSE.test(t) || TOOL_OUTPUT.test(t);
  },

  normalize(line: string): string | null {
    const t = line.trim();
    if (t.length === 0) return null;

    // "◎ Thinking (Esc to cancel · 402 B)" → "Thinking"
    const thinkMatch = THINKING_LINE.exec(t);
    if (thinkMatch) return thinkMatch[1];

    // Strip spinner prefix: "◎ Loading environment: 22 skills" → "Loading environment: 22 skills"
    if (HAS_SPINNER.test(t)) {
      return t.replace(SPINNER_PREFIX, '');
    }

    return t;
  },
};
