/**
 * What the popup says, separated from how it is drawn.
 *
 * Pure: no DOM, no `chrome`, no storage. That is what lets the wording be asserted in Vitest, which
 * matters more here than anywhere else in the UI: the popup is the surface a user consults when
 * something looks wrong, so a sentence that misdescribes the state is worse than no popup at all.
 *
 * The rule the whole file follows: never let "nothing was found" and "nothing was checked" share a
 * phrasing. Everything else is detail.
 */
import type { AiMode, MessagePart, SemanticStatus, Settings } from '../shared/types.js';
import type { TabHealth, TabStatus } from '../shared/messaging.js';
import {
  CLASSIFICATION_GLYPHS,
  CLASSIFICATION_LABELS,
  UNREADABLE_GLYPH,
  UNREADABLE_LABEL,
} from '../ui/labels.js';
import { isModelServerConfigured } from '../shared/settings.js';
import { formatList } from '../shared/text.js';

/**
 * `not-gmail`, `no-gmail-access` and `unreachable` are the popup's own states, not the tab's: no
 * content script answered, for three reasons that mean different things to a user. Every other state
 * comes from the tab.
 *
 * `no-gmail-access` exists because the user can withhold the Gmail host permission (Firefox asks for it
 * separately, and Chrome's site-access menu can restrict it). Without it the popup cannot even read the
 * tab's address, so it would otherwise say "only runs on Gmail" to someone looking at Gmail.
 *
 * `not-started` is decided from settings before any tab is asked, and outranks every other state: until
 * the reader has agreed to their mail being read, nothing is checked anywhere, and a tab answering
 * "no message open" would hide that.
 */
export type PopupState =
  | TabStatus
  | { kind: 'not-started' }
  | { kind: 'not-gmail' }
  | { kind: 'no-gmail-access' }
  | { kind: 'unreachable' };

/** Drives the chip's colour. `idle` is "nothing to report", `unknown` is "could not tell". */
export type Tone = 'low' | 'caution' | 'suspicious' | 'high-risk' | 'unknown' | 'idle';

export interface Headline {
  /** Empty when the state has no glyph, rather than a placeholder that looks like a verdict. */
  glyph: string;
  label: string;
  /** `"58/100"`, or empty when nothing was scored. */
  score: string;
  tone: Tone;
  /** One sentence under the chip. Always present: a bare chip invites the wrong reading. */
  note: string;
}

const PART_NAMES: Readonly<Record<MessagePart, string>> = {
  sender: 'who it is from',
  subject: 'its subject',
  body: 'its text',
};

/** The same parts as bare nouns, for the sentences that count them rather than list them. */
const PART_NOUNS: Readonly<Record<MessagePart, string>> = {
  sender: 'sender',
  subject: 'subject',
  body: 'body text',
};

/** "who it is from", "who it is from and its text": a list a sentence can contain. */
function describeParts(missing: readonly MessagePart[]): string {
  return formatList(
    missing.map((part) => PART_NAMES[part]),
    missing.length,
  ) || 'this message';
}

export function headline(state: PopupState): Headline {
  switch (state.kind) {
    case 'not-started':
      // `unknown` rather than `idle`: an inbox with no badges on it is what clean mail looks like too.
      return {
        glyph: UNREADABLE_GLYPH,
        label: 'Not started',
        score: '',
        tone: 'unknown',
        note: 'ShoutPhish is not checking your mail yet. See what it reads, then choose Start.',
      };
    case 'not-gmail':
      return {
        glyph: '',
        label: 'Nothing to check here',
        score: '',
        tone: 'idle',
        note: 'ShoutPhish only runs on Gmail. Open a message there and its assessment appears here.',
      };
    case 'no-gmail-access':
      return {
        glyph: UNREADABLE_GLYPH,
        label: 'No access to Gmail',
        score: '',
        tone: 'unknown',
        note: 'ShoutPhish has not been allowed to read Gmail, so it checks nothing there. Allow access, then reload Gmail.',
      };
    case 'unreachable':
      // Gmail is open and nothing answered, which happens when the extension is reloaded or updated
      // underneath a tab that was already open. The tab looks normal and silently checks nothing, so
      // this is the one state whose whole value is naming the fix.
      return {
        glyph: UNREADABLE_GLYPH,
        label: 'Not running in this tab',
        score: '',
        tone: 'unknown',
        note: 'This tab was open before ShoutPhish started or was updated. Reload it and messages will be checked again.',
      };
    case 'no-message':
      return {
        glyph: '',
        label: 'No message open',
        score: '',
        tone: 'idle',
        note: 'Open a message and ShoutPhish checks it as it loads.',
      };
    case 'pending':
      return {
        glyph: '',
        label: 'Checking…',
        score: '',
        tone: 'idle',
        note: 'Technical checks take a few milliseconds.',
      };
    case 'unreadable':
      return {
        glyph: UNREADABLE_GLYPH,
        label: UNREADABLE_LABEL,
        score: '',
        tone: 'unknown',
        // Says outright that this is not an all-clear. The badge and card carry the same sentence, and
        // this is the surface most likely to be read on its own.
        note: `ShoutPhish could not read ${describeParts(state.missing)}, so it has not scored it. That is not a judgement that the message is safe.`,
      };
    case 'scored':
      return {
        glyph: CLASSIFICATION_GLYPHS[state.classification],
        label: CLASSIFICATION_LABELS[state.classification],
        score: `${String(state.score)}/100`,
        tone: state.classification,
        // Three cases rather than two, because a finding can be reported and still contribute nothing:
        // dampening zeroes a combination finding on mail from a sender you have verified, and claiming
        // that the score is made of readable findings when the score is zero reads as a glitch.
        note:
          state.findings === 0
            ? 'None of the technical checks found anything.'
            : state.score === 0
              ? 'What was found is listed in the card, and none of it added to the score.'
              : 'Every point of this score comes from a finding you can read.',
      };
  }
}

/** The findings count, or `null` when the state has no findings to count. */
export function findingsLine(state: PopupState): string | null {
  if (state.kind !== 'scored') return null;
  if (state.findings === 0) return 'No findings';
  return state.findings === 1 ? '1 finding' : `${String(state.findings)} findings`;
}

/**
 * The label for the button that opens the card, or `null` when there is no card to open.
 *
 * Worded per state rather than fixed: "Show the full assessment" on a message that was never assessed
 * would promise the one thing the card exists to say does not exist.
 */
export function cardButtonLabel(state: PopupState): string | null {
  if (state.kind === 'scored') return 'Show the full assessment';
  if (state.kind === 'unreadable') return 'Show what could not be read';
  return null;
}

// ---------------------------------------------------------------------------
// Extraction health
// ---------------------------------------------------------------------------

/**
 * A tally worth mentioning only after enough messages that a pattern means something. Below this, one
 * unusual message would read as Gmail having changed, which sends a user to file a report about nothing.
 */
const HEALTH_MIN_MESSAGES = 3;

export interface HealthRow {
  headline: string;
  detail: string;
}

/**
 * What to say about how well Gmail is being read, or `null` when there is nothing to say.
 *
 * Silent in the healthy case on purpose. This row is the only place a *degrading* extraction becomes
 * visible (a selector list on its last fallback, a subject going unread on every message), but a row
 * that were always present, usually saying "fine", is a row nobody reads by the time it matters.
 */
export function healthRow(health: TabHealth): HealthRow | null {
  if (health.seen < HEALTH_MIN_MESSAGES) return null;

  if (health.unscorable > 0) {
    return {
      headline: `${String(health.unscorable)} of ${String(health.seen)} messages could not be read`,
      detail:
        'Those were not scored. This is usually Gmail having changed its page structure, which is fixable: the report below names the part that stopped matching and contains none of your mail.',
    };
  }

  // Only ever a subject at this point: a message missing its sender or body is unscorable and was
  // reported above. The commonest miss is named, because one name is more actionable than a list.
  const worst = health.misses.find((miss) => miss.count > 0);
  if (worst !== undefined) {
    return {
      headline: `${String(worst.count)} of ${String(health.seen)} messages had no readable ${PART_NOUNS[worst.part]}`,
      detail:
        'Those messages were still scored, with fewer checks behind the score than usual. The report below names what stopped matching and contains none of your mail.',
    };
  }

  // Worded around what the reader loses rather than around candidate lists: this is the one row that
  // fires while nothing is wrong yet, so it has to earn attention without a symptom to point at.
  if (health.drifted.length > 0) {
    return {
      headline: 'A Gmail change may soon break some checks',
      detail:
        'Everything is being checked normally today, but Gmail has moved part of its page and ShoutPhish is reading it a backup way. Copying the report below into an issue gets it fixed before anything stops working. It contains none of your mail.',
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface ReportRow {
  label: string;
  note: string;
}

/**
 * The copy-a-report affordance, or `null` when there would be nothing to report about.
 *
 * Offered whether or not `healthRow` fired, and that is the point. The health row is deliberately silent
 * while extraction is working, so attaching the only copy button to it would make the report unreachable
 * in exactly the case it is most useful for: a healthy session that scored one message wrongly.
 * Disagreeing with a score is a bug report about a *working* install.
 *
 * Absent only when no content script answered, where a report would describe nothing. The note names
 * what the reader is about to paste, because that is the promise the report has to keep: a user who
 * cannot tell whether their mail is in it has no way to decide whether to attach it to a public issue.
 */
export function reportRow(state: PopupState): ReportRow | null {
  if (
    state.kind === 'not-started' ||
    state.kind === 'not-gmail' ||
    state.kind === 'no-gmail-access' ||
    state.kind === 'unreachable'
  ) {
    return null;
  }

  const label = 'Copy a diagnostic report';
  if (state.kind === 'scored') {
    return {
      label,
      note: 'Names the checks that ran on this message and what each one added to the score, with no text from the message itself. Paste it into an issue if a score looks wrong.',
    };
  }
  return {
    label,
    note: 'Describes how ShoutPhish has been reading this tab, with none of your mail in it. Open a message first if you want to report a score.',
  };
}

// ---------------------------------------------------------------------------
// The AI row
// ---------------------------------------------------------------------------

/**
 * Name of whatever is doing the reading, as a row label. Matches `ANALYZER_NAMES` in `ui/format.ts` in
 * substance but not in shape: that file needs sentence-initial forms, this one needs headings.
 */
const MODE_LABELS: Readonly<Record<AiMode, string>> = {
  off: 'AI analysis',
  local: 'On-device model',
  cloud: 'Analysis service',
  server: 'Your model server',
};

/**
 * A `Record` so a new `SemanticStatus` cannot compile until the popup has wording for it, and short
 * enough to sit on one line. `pending` is a live state here, not a note about a finished result.
 */
const STATUS_TEXT: Readonly<Record<SemanticStatus, string>> = {
  ready: 'Assessment ready',
  pending: 'Reading the message…',
  off: 'Switched off: technical checks only',
  // Says why and what it means, because "skipped" alone reads as either a fault or an all-clear.
  skipped: 'Not asked: no technical finding for it to weigh',
  unavailable: 'Unavailable',
  'no-output': 'Returned nothing usable for this message',
  error: 'Could not finish',
  cancelled: 'Interrupted',
};

export interface AiRow {
  label: string;
  detail: string;
  /**
   * True when a connection test would tell the user something. Only ever set for a configured model
   * server: the on-device model has nothing to test (it is either in the browser or it is not), and
   * offering a button that cannot help is how a diagnostic surface loses its credibility.
   */
  testable: boolean;
  /** Set when the state has a cause the user can act on. Rendered next to the detail. */
  fix: string | null;
}

export function aiRow(settings: Settings, state: PopupState): AiRow {
  const label = MODE_LABELS[settings.aiMode];
  const testable = isModelServerConfigured(settings);

  if (settings.aiMode === 'off') {
    return { label, detail: STATUS_TEXT.off, testable: false, fix: null };
  }

  if (state.kind === 'not-started') {
    return { label, detail: 'Not used until ShoutPhish is started', testable, fix: null };
  }

  if (settings.aiMode === 'server' && !testable) {
    return {
      label,
      detail: 'Not finished setting up',
      testable: false,
      fix: 'Set the server address and model in settings.',
    };
  }

  // A message nothing could be read from never reached the semantic stage, and saying the model is
  // "ready when you open a message" while one is open reads as a second, contradictory failure.
  if (state.kind === 'unreadable') {
    return { label, detail: 'Not used: this message was not read', testable, fix: null };
  }

  // Only a scored message has been through the semantic stage. Before that there is a configuration to
  // report and nothing else, and inventing a status for it would mean showing "unavailable" for a model
  // that is merely unasked.
  if (state.kind !== 'scored') {
    return { label, detail: 'Ready when you open a message', testable, fix: null };
  }

  return {
    label,
    detail: STATUS_TEXT[state.semantic],
    testable,
    fix: fixFor(state.semantic, settings.aiMode),
  };
}

/**
 * The one line of advice, where there is any worth giving.
 *
 * `no-output` and `error` on a user-run server are the two whose cause is otherwise only visible in a
 * console (a rejected origin and a reply truncated by a reasoning model both surface as silence), so
 * those are the ones that name the button that explains them.
 */
function fixFor(status: SemanticStatus, aiMode: AiMode): string | null {
  if (status === 'unavailable') {
    return aiMode === 'local'
      ? // `unavailable` covers a model not yet downloaded, a switched-off setting, an ineligible device
        // and a browser with no model at all, which the browser does not distinguish, so the advice
        // names the page that sorts them out.
        'The browser’s built-in model is not ready: it may need downloading or switching on, or this browser may not have one. Settings links to the setup steps. Technical checks are unaffected.'
      : 'ShoutPhish could not reach it. Test the connection to see why.';
  }
  if (aiMode === 'server' && (status === 'no-output' || status === 'error')) {
    return 'Test the connection to see what the server reports.';
  }
  return null;
}
