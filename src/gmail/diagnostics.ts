/**
 * A report a user can paste into a bug report when extraction has failed.
 *
 * This is the project's substitute for telemetry. Nothing here phones home (the extension makes no
 * network call of its own volition, see docs/PRIVACY.md), so the only way a broken selector becomes known
 * is that the person in front of it can say something useful about it. "ShoutPhish stopped working" is
 * not actionable; a list naming which selector groups matched is, because it points at the exact
 * candidate list in `selectors.ts` that needs a new entry.
 *
 * **Contains no message content, and cannot come to.** Only selector strings we wrote, the parts that
 * were missing, and the two version numbers. Deliberately excluded:
 *
 *  - the URL, which carries a thread id, i.e. an identifier for a specific message in someone's mailbox;
 *  - any extracted value, since every one of them is either the mail itself or an address;
 *  - counts derived from content (body length, number of links), which are weak but real leakage and
 *    would not change which selector needs fixing.
 *
 * The whole point is that a user can read it before sending it, so it is plain text, short, and has
 * nothing in it that needs interpreting.
 */
import type {
  AnalysisResult,
  AnalysisTiming,
  Classification,
  EmailMessage,
  MessagePart,
  SemanticStatus,
  Severity,
  SignalCategory,
} from '../shared/types.js';
import { addedUp, contributions } from '../analysis/scoring/aggregate.js';
import type { TabHealth } from '../shared/messaging.js';
import type { MessageHandle } from './adapter.js';
import { PAGE_SCOPED, SELECTORS } from './selectors.js';

/** Where a selector group found its first match, or that it found none. */
type Scope = 'message' | 'document' | 'none';

export interface SelectorProbe {
  group: string;
  scope: Scope;
  /** Index into the group's candidate list, so a stale first candidate is visible. `-1` for no match. */
  candidate: number;
}

/**
 * Probes every selector group in `selectors.ts`, inside the message first and then the page.
 *
 * Every group rather than only the ones that failed: which candidate matched is as informative as
 * whether one did. A group falling through to its last resort is how a selector list decays, and seeing
 * that in a report from a working install is what makes it fixable before it breaks.
 */
export function probeSelectors(handle: MessageHandle): SelectorProbe[] {
  return Object.entries(SELECTORS).map(([group, candidates]) => {
    for (const [scope, root] of [
      ['message', handle.root],
      ['document', document],
    ] as const) {
      const candidate = firstMatch(root, candidates);
      if (candidate >= 0) return { group, scope, candidate };
    }
    return { group, scope: 'none' as const, candidate: -1 };
  });
}

/**
 * Whether a probe describes a selector that has decayed: a later candidate matched, in the scope the
 * code reads that group from.
 *
 * Both halves are load-bearing. A group that matched *nothing*
 * is not drift, because most of the table is expected to miss on an ordinary message: no attachments, no
 * quoted reply, nothing collapsed, and no unverified-sender avatar precisely when the sender
 * authenticated. And a group found on the page after missing inside the message is not drift either: it
 * was located somewhere the adapter never looks, which says nothing about the selector's health.
 *
 * A genuinely broken selector is not silent. It shows up as the part it failed to read, or as a message
 * that could not be scored, both of which the health tally counts separately, and the probe still records
 * it as NO MATCH in the report.
 */
export function hasDrifted(probe: SelectorProbe): boolean {
  const expected = PAGE_SCOPED.has(probe.group) ? 'document' : 'message';
  return probe.candidate > 0 && probe.scope === expected;
}

function firstMatch(root: ParentNode, candidates: readonly string[]): number {
  for (const [index, selector] of candidates.entries()) {
    try {
      if (root.querySelector(selector) !== null) return index;
    } catch {
      // An invalid candidate is not a match, exactly as in `queryFirst`.
    }
  }
  return -1;
}

export interface DiagnosticInput {
  adapter: string;
  version: string;
  /** The `Chrome/<version>` token only, not the whole user-agent string. */
  browser: string;
  missing: readonly MessagePart[];
  probes: readonly SelectorProbe[];
}

/**
 * Renders the report. Pure, so the guarantee in this file's header is testable without a DOM: given
 * only the fields above, there is no path by which message content could appear in the output.
 */
export function formatDiagnostic(input: DiagnosticInput): string {
  const lines = [
    `ShoutPhish ${input.version}: extraction diagnostic`,
    `adapter:  ${input.adapter}`,
    `browser:  ${input.browser}`,
    `missing:  ${input.missing.length > 0 ? input.missing.join(', ') : 'nothing'}`,
    'selectors:',
  ];

  const width = input.probes.reduce((max, probe) => Math.max(max, probe.group.length), 0);
  for (const probe of input.probes) {
    lines.push(`  ${probe.group.padEnd(width)}  ${describeProbe(probe)}`);
  }

  return lines.join('\n');
}

function describeProbe(probe: SelectorProbe): string {
  if (probe.scope === 'none') return 'NO MATCH';
  // Widened rather than asserted: probes also arrive from the harness, where a group name need not be
  // one of ours, and a report is not worth throwing over.
  const groups: Record<string, readonly string[]> = SELECTORS;
  const candidate = groups[probe.group]?.[probe.candidate] ?? '?';
  return `${probe.scope} #${String(probe.candidate)} ${candidate}`;
}

/** One check that ran, named by the id it is declared with. Never its wording. */
export interface CheckSummary {
  id: string;
  severity: Severity;
  score: number;
  dampened: boolean;
}

/**
 * How the message on screen was scored, in counts and the names of our own rules.
 *
 * This is the half of a bug report the selector probes cannot give. A selector that stopped matching is
 * visible in the probe list; a check that fired when it should not have is visible only in the card,
 * whose every sentence is built around a value from the reader's mail and therefore cannot be pasted
 * into a public issue. Without this, disagreeing with a score would mean installing a development build,
 * a toolchain, for a bug the person reporting it can see and we cannot.
 *
 * What it holds: rule ids, severities, scores, and counts. What it must never hold: `title`,
 * `description` or `evidence`, each of which is a sentence assembled around a domain, a filename or an
 * excerpt. `summarizeScoring` is the only way to build one, because `SecuritySignal` is assignable to
 * `CheckSummary`: a spread would satisfy the compiler and carry the wording along with the id.
 *
 * The counts are a deliberate exception to the rule the selector report follows, which excludes body
 * length as weak leakage that would not help anyway. Here the second half of that reasoning fails: a
 * body read as 0 characters and one read as 5,000 produce the same list of check names and completely
 * different bugs, and which of the two happened is what "why did this score 50" turns on.
 */
export interface ScoringSummary {
  score: number;
  classification: Classification;
  semantic: SemanticStatus;
  bodyChars: number;
  links: number;
  attachments: number;
  /** Concealed characters and the CSS techniques found, when the scan found any. */
  hidden: { chars: number; techniques: readonly string[] } | null;
  checks: readonly CheckSummary[];
  /**
   * What each category added after its cap, largest first, and what a severity floor added on top.
   *
   * The per-check scores are raw, before the caps, so on their own a check reading "23" in a category
   * worth 15 would look like the cap had failed. Contributions are per category rather than per check
   * because that is where the caps apply: two findings sharing a capped category have no individual share
   * to report.
   */
  contributions: readonly (readonly [SignalCategory, number])[];
  floorPoints: number;
  /**
   * How long the checks and the model took. Durations only: they say how slow this machine and model
   * are, which is what a "ShoutPhish is slow" report needs and nothing about the mail.
   */
  timing: AnalysisTiming | null;
}

/**
 * Bounds the pasted report. Signal counts are already bounded by the rules that produce them, so this
 * is a guard against a future rule that emits per-link findings, not a limit anything reaches today.
 */
const MAX_CHECKS_REPORTED = 40;

/** The only constructor for a `ScoringSummary`. Copies field by field, for the reason given above. */
export function summarizeScoring(
  result: AnalysisResult,
  email: EmailMessage,
  semantic: SemanticStatus,
  timing: AnalysisTiming | null = null,
): ScoringSummary {
  const hidden = email.hiddenText;
  return {
    score: result.score,
    classification: result.classification,
    semantic,
    bodyChars: email.bodyText.length,
    links: email.links.length,
    attachments: email.attachments.length,
    hidden:
      hidden === undefined ? null : { chars: hidden.chars, techniques: [...hidden.techniques] },
    checks: result.signals.slice(0, MAX_CHECKS_REPORTED).map((signal) => ({
      id: signal.id,
      severity: signal.severity,
      score: signal.score,
      dampened: signal.dampened === true,
    })),
    contributions: contributions(result),
    floorPoints: Math.max(0, result.score - addedUp(result)),
    timing:
      timing === null
        ? null
        : {
            checksMs: timing.checksMs,
            aiReused: timing.aiReused,
            ...(timing.aiMs === undefined ? {} : { aiMs: timing.aiMs }),
          },
  };
}

/** What the last inbox-list pass saw. Counts only; see `content/list-marks.ts`. */
export interface ListPassCounts {
  rows: number;
  addressable: number;
  marked: number;
}

export interface HealthInput extends Pick<DiagnosticInput, 'adapter' | 'version' | 'browser'> {
  health: TabHealth;
  probes: readonly SelectorProbe[];
  /**
   * The message on screen, when one has been scored.
   *
   * Nullable rather than optional, for both this and `listPass`: "nothing was open" is something the
   * report should say, and a field a caller can forget is a field that silently says nothing instead.
   */
  scoring: ScoringSummary | null;
  listPass: ListPassCounts | null;
}

/**
 * The session variant: the same report, for a tab where extraction is degrading rather than failing.
 *
 * Shares the selector table and the version lines with `formatDiagnostic` but not its shape, because the
 * two answer different questions. That one describes one message that could not be read; this one
 * describes a pattern across a session, and the counts are the part that distinguishes "Gmail moved this
 * element" from "one unusual message".
 *
 * Pure for the same reason as `formatDiagnostic`: the claim that no message content can appear in the
 * output is worth only as much as a test can check, and a function reading `chrome` and `navigator` needs
 * a fake browser before it can be asked.
 */
export function formatHealth(input: HealthInput): string {
  const { health } = input;
  const misses =
    health.misses.length > 0
      ? health.misses.map((miss) => `${miss.part} ×${String(miss.count)}`).join(', ')
      : 'none';

  const lines = [
    `ShoutPhish ${input.version}: session diagnostic`,
    `adapter:     ${input.adapter}`,
    `browser:     ${input.browser}`,
    `messages:    ${String(health.seen)}`,
    `not scored:  ${String(health.unscorable)}`,
    `unread:      ${misses}`,
    `list pass:   ${describeListPass(input.listPass)}`,
    ...scoringLines(input.scoring),
    'selectors:',
  ];

  const width = input.probes.reduce((max, probe) => Math.max(max, probe.group.length), 0);
  for (const probe of input.probes) {
    lines.push(`  ${probe.group.padEnd(width)}  ${describeProbe(probe)}`);
  }

  return lines.join('\n');
}

/**
 * The list-marker line.
 *
 * All three counts, because the difference between them is the whole diagnosis: no rows means the row
 * selector has stopped matching Gmail's markup, rows with addresses and no marks means the feature is
 * working and ordinary mail earned nothing, and rows without addresses means Gmail has moved the
 * attribute the sender is read from. An unmarked inbox is the expected result, so "0 marked" on its own
 * distinguishes none of these.
 */
function describeListPass(counts: ListPassCounts | null): string {
  if (counts === null) return 'not run';
  return `${String(counts.rows)} rows, ${String(counts.addressable)} with an address, ${String(counts.marked)} marked`;
}

/**
 * The message-on-screen section, or the one line that says there is none.
 *
 * Severity before score before id, left to right in the order a reader scans for the thing they
 * disagree with. `dampened` is marked rather than omitted: a finding softened because the sender was
 * proven is one of the commonest reasons a score is lower than someone expected, and a report that
 * hides it invites the same question twice.
 */
function scoringLines(scoring: ScoringSummary | null): string[] {
  if (scoring === null) return ['message:     none scored'];

  const lines = [
    `message:     ${String(scoring.score)}/100 ${scoring.classification}, semantic ${scoring.semantic}`,
    `read:        body ${String(scoring.bodyChars)}c, ${String(scoring.links)} links, ${String(scoring.attachments)} attachments`,
    `timing:      ${describeTiming(scoring.timing)}`,
  ];

  if (scoring.hidden !== null) {
    lines.push(
      `concealed:   ${String(scoring.hidden.chars)}c via ${scoring.hidden.techniques.join(', ')}`,
    );
  }

  lines.push(`score:       ${describeContributions(scoring)}`);
  lines.push('checks (raw points, before category caps):');
  if (scoring.checks.length === 0) {
    lines.push('  none');
    return lines;
  }
  for (const check of scoring.checks) {
    const score = String(check.score).padStart(3);
    lines.push(
      `  ${check.severity.padEnd(8)}${score}  ${check.id}${check.dampened ? '  (dampened)' : ''}`,
    );
  }
  return lines;
}

/** `identity 21 + llm 15 + floor 14 = 50`, so a floor deciding the score is visible as such. */
function describeContributions(scoring: ScoringSummary): string {
  const parts = scoring.contributions.map(([category, points]) => `${category} ${String(points)}`);
  if (scoring.floorPoints > 0) parts.push(`floor ${String(scoring.floorPoints)}`);
  if (parts.length === 0) return `nothing added = ${String(scoring.score)}`;
  return `${parts.join(' + ')} = ${String(scoring.score)}`;
}

/** Whole milliseconds; finer precision is noise in a report pasted by hand. */
function describeTiming(timing: AnalysisTiming | null): string {
  if (timing === null) return 'not measured';
  const checks = `checks ${String(Math.round(timing.checksMs))}ms`;
  if (timing.aiMs === undefined) return checks;
  const ai = `ai ${String(Math.round(timing.aiMs))}ms`;
  return `${checks}, ${ai}${timing.aiReused ? ' (reused reading)' : ''}`;
}

/** The browser version, without the rest of a user-agent string's fingerprinting surface. */
export function browserVersion(userAgent: string): string {
  return /(?:Chrom(?:e|ium)|Firefox)\/[\d.]+/u.exec(userAgent)?.[0] ?? 'unknown';
}

/** The whole report for the message on screen. */
export function buildDiagnostic(
  handle: MessageHandle,
  missing: readonly MessagePart[],
  adapter: string,
): string {
  return formatDiagnostic({ ...environment(adapter), missing, probes: probeSelectors(handle) });
}

/** The whole report for the session. Takes an object: five positional arguments invite a swap. */
export function buildHealthReport(
  input: Pick<HealthInput, 'health' | 'probes' | 'scoring' | 'listPass'> & { adapter: string },
): string {
  return formatHealth({ ...input, ...environment(input.adapter) });
}

/** The three lines both reports open with, and the only place either of them touches the browser. */
function environment(adapter: string): Pick<DiagnosticInput, 'adapter' | 'version' | 'browser'> {
  return {
    adapter,
    version: extensionVersion(),
    browser: browserVersion(navigator.userAgent),
  };
}

function extensionVersion(): string {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    // The harness renders this card without an extension around it.
    return 'unpackaged';
  }
}
