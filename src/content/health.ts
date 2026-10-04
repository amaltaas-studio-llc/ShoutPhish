/**
 * A session tally of how well the adapter is reading Gmail.
 *
 * Gmail's markup changes without notice, and the failure it produces is quiet: a selector stops matching,
 * one part of every message goes unread, and the extension keeps running. The unscorable case is loud
 * because it withholds a score, but the ones that only *degrade* an assessment (no subject, no
 * authentication table, a selector group falling through to its last resort) look exactly like normal
 * operation from the outside.
 *
 * This is what makes them visible without telemetry. Counts accumulate for the life of the tab, the
 * popup surfaces them only when there is something to say, and the report is the same paste-into-an-issue
 * text as the unreadable card's (`gmail/diagnostics.ts`), so a user can tell us which selector list needs
 * an entry. Nothing is persisted: a tally that survived a restart would report yesterday's Gmail.
 *
 * Holds no message content. Only counts, part names, and selector strings we wrote, and the report it
 * builds adds nothing of a different kind, since the message on screen reaches it as a `ScoringSummary`
 * of rule names and counts rather than as a message.
 */
import type { MessagePart } from '../shared/types.js';
import type { TabHealth } from '../shared/messaging.js';
import {
  buildHealthReport,
  hasDrifted,
  type ListPassCounts,
  type ScoringSummary,
  type SelectorProbe,
  type SettingsSummary,
} from '../gmail/diagnostics.js';

export class HealthLog {
  #seen = 0;
  #unscorable = 0;
  readonly #misses = new Map<MessagePart, number>();
  #probes: readonly SelectorProbe[] = [];

  /**
   * Records one observed message.
   *
   * `probe` is a callback rather than a value because probing walks every candidate in `selectors.ts`
   * against the DOM, and doing that per message would be work spent on the case where nothing is wrong.
   * It runs on the first message of the session (which establishes the baseline, including a group
   * already limping along on a fallback) and thereafter only when something went unread.
   */
  record(missing: readonly MessagePart[], scorable: boolean, probe: () => SelectorProbe[]): void {
    const first = this.#seen === 0;
    this.#seen += 1;
    if (!scorable) this.#unscorable += 1;

    for (const part of missing) {
      this.#misses.set(part, (this.#misses.get(part) ?? 0) + 1);
    }

    if (first || missing.length > 0) this.#probes = probe();
  }

  /**
   * The counts the popup words a row from.
   *
   * `drifted` is every group that matched a later candidate than its preferred one: a group on candidate
   * 3 of 4 is the shape of decay, working today and one Gmail release from not working, and reporting it
   * while it still works is the entire point. What does and does not count as that is `hasDrifted`, next
   * to the probe that produces the scopes it reasons about; the popup row is only worth having if it stays
   * rare, so the cases it excludes matter more than the case it includes.
   */
  summary(): TabHealth {
    return {
      seen: this.#seen,
      unscorable: this.#unscorable,
      misses: [...this.#misses]
        .map(([part, count]) => ({ part, count }))
        .sort((a, b) => b.count - a.count),
      drifted: this.#probes.filter(hasDrifted).map((probe) => probe.group),
    };
  }

  /**
   * The pasteable report. Built on request, since nothing needs it until a button is pressed.
   *
   * The message on screen and the list pass arrive as arguments rather than being accumulated here: this
   * class counts what extraction did over a session, and both of those are state owned elsewhere. Giving
   * it a reference to the controller to fetch them would be the moment "holds no message content" became
   * a claim about discipline instead of about shape.
   */
  report(
    adapter: string,
    scoring: ScoringSummary | null,
    listPass: ListPassCounts | null,
    settings: SettingsSummary | null,
  ): string {
    return buildHealthReport({
      adapter,
      health: this.summary(),
      probes: this.#probes,
      scoring,
      listPass,
      settings,
    });
  }
}
