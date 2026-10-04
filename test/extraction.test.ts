/**
 * Tests for the extraction-gap rule: when the adapter cannot read a message, nothing is scored.
 *
 * The failure this guards against is the only one in the project that points the wrong way. Every other
 * degradation loses a finding, which understates risk by a knowable amount; this one produces a
 * *confident* verdict from an almost empty message, and the verdict it produces is "Low Risk". A user
 * who has learned to trust a green badge is worse off than one with no extension at all.
 *
 * So the first test here does not test the guard; it demonstrates the danger, by scoring a phishing
 * message with its sender removed and showing what comes back. If a later change makes that message
 * score high on its own, this file should be revisited rather than deleted: the guard would then be
 * unnecessary, and a test asserting a near-zero score would be asserting the bug.
 */
import { describe, expect, it } from 'vitest';

import { analyzeDeterministic } from '../src/analysis/engine.js';
import { HealthLog } from '../src/content/health.js';
import { isScorable } from '../src/gmail/adapter.js';
import {
  browserVersion,
  formatDiagnostic,
  formatHealth,
  summarizeScoring,
  type ListPassCounts,
  type ScoringSummary,
  type SelectorProbe,
} from '../src/gmail/diagnostics.js';
import type { AnalysisResult, EmailMessage, MessagePart } from '../src/shared/types.js';
import { unreadableNotes } from '../src/ui/format.js';
import { UNREADABLE_LABEL } from '../src/ui/labels.js';
import { loadFixture } from './fixtures/load.js';

/** The extraction a broken sender selector produces: everything else intact, no address. */
function withoutSender(email: EmailMessage): EmailMessage {
  const { senderEmail: _address, senderName: _name, raw: _raw, ...rest } = email;
  return rest;
}

describe('why the guard exists', () => {
  /**
   * A thread hijack is the clearest case because it is *entirely* an identity attack: an outsider
   * replying into a real conversation, detectable only by comparing who they are against who has been
   * in it. Take the sender away and there is nothing left to detect (no bad link, no attachment, no
   * alarming wording), so the engine correctly reports a message with no findings, and the badge that
   * reports it says Low Risk.
   */
  it.each(['thread-hijack-lookalike', 'thread-hijack-name-reuse'])(
    'scores %s as low risk once its sender cannot be read',
    (name) => {
      const phish = loadFixture(name).email;

      const whole = analyzeDeterministic(phish);
      const blinded = analyzeDeterministic(withoutSender(phish));

      // Nothing about the message changed in any way a reader would notice; only our view of it did.
      expect(whole.classification).not.toBe('low');
      expect(blinded.classification).toBe('low');
    },
  );

  /**
   * Recorded so the guard is not mistaken for a fix. Phishing that carries its payload in the body is
   * still caught with no sender at all, which is why the extension keeps working through a partial
   * breakage rather than switching itself off, and why the gap is reported on the message it affects
   * instead of disabling the extension globally.
   */
  it('still catches a phish whose evidence is in the body', () => {
    const phish = loadFixture('microsoft-phish').email;
    expect(analyzeDeterministic(withoutSender(phish)).classification).toBe('high-risk');
  });

  it('leaves a message scoreable when only its subject is unread', () => {
    const phish = loadFixture('thread-hijack-lookalike').email;
    const { subject: _subject, ...noSubject } = phish;

    // Not a claim that the score is unchanged (some wording checks read the subject), only that what
    // remains is a real assessment of a real sender, which is why a subject is not load-bearing.
    expect(analyzeDeterministic({ ...noSubject, subject: '' }).classification).not.toBe('low');
  });
});

describe('isScorable', () => {
  it('accepts a complete extraction', () => {
    expect(isScorable([])).toBe(true);
  });

  it('refuses one with no sender, whatever else was read', () => {
    expect(isScorable(['sender'])).toBe(false);
    expect(isScorable(['sender', 'subject'])).toBe(false);
  });

  it('refuses one with no body', () => {
    expect(isScorable(['body'])).toBe(false);
  });

  it('accepts one missing only the subject, which costs detail rather than meaning', () => {
    expect(isScorable(['subject'])).toBe(true);
  });
});

describe('what the card says when nothing was checked', () => {
  const parts: MessagePart[] = ['sender', 'subject', 'body'];

  it('names a cause for every part, so a new one cannot ship unworded', () => {
    for (const part of parts) {
      expect(unreadableNotes([part])[0]?.text).toContain('ShoutPhish could not read');
    }

    // Distinct wording per part, or the card would say the same thing about different failures.
    const firsts = new Set(parts.map((part) => unreadableNotes([part])[0]?.text));
    expect(firsts.size).toBe(parts.length);
  });

  /**
   * Asserted by *finding* the emphatic note rather than by position. Marking one paragraph emphatic by
   * index would silently move the emphasis onto a cause line as soon as two parts were unread, leaving the
   * sentence that carries the whole point of this state, unemphasised.
   */
  it.each([[['sender']], [['sender', 'subject']], [[]]] as MessagePart[][][])(
    'emphasises exactly the safety disclaimer for %j',
    (missing) => {
      const emphatic = unreadableNotes(missing).filter((note) => note.emphatic);

      expect(emphatic).toHaveLength(1);
      expect(emphatic[0]?.text).toContain('not a judgement that the message is safe');
      expect(emphatic[0]?.text).toContain('Nothing was checked');
    },
  );

  /**
   * The property that matters most and is easiest to break by editing copy: nothing on this card may
   * read as reassurance. A future author softening the tone is exactly how "not checked" starts sounding
   * like "nothing found".
   */
  it('never reassures the reader', () => {
    const text = [UNREADABLE_LABEL, ...unreadableNotes(['sender', 'subject']).map((n) => n.text)]
      .join(' ')
      .toLowerCase();

    for (const reassurance of [
      'low risk',
      'looks fine',
      'looks safe',
      'appears safe',
      'no threats',
      'nothing suspicious',
      'no problems',
    ]) {
      expect(text).not.toContain(reassurance);
    }
  });

  it('still explains itself when the missing list is empty, rather than rendering a blank card', () => {
    expect(unreadableNotes([]).map((note) => note.text).join(' ')).toContain('could not read');
  });
});

describe('the diagnostic report', () => {
  const probes: SelectorProbe[] = [
    { group: 'messageContainer', scope: 'message', candidate: 0 },
    { group: 'senderSpan', scope: 'none', candidate: -1 },
    { group: 'subject', scope: 'document', candidate: 1 },
  ];

  const report = formatDiagnostic({
    adapter: 'gmail-dom',
    version: '0.3.0',
    browser: 'Chrome/139.0.0.0',
    missing: ['sender'],
    probes,
  });

  it('names the group that found nothing, which is the actionable part', () => {
    expect(report).toContain('senderSpan');
    expect(report).toMatch(/senderSpan\s+NO MATCH/u);
  });

  it('shows which candidate matched, so a decaying list is visible before it breaks', () => {
    // `subject` fell through to its second candidate: still working, worth knowing.
    expect(report).toMatch(/subject\s+document #1 h2\.hP/u);
  });

  it('records the versions a bug report needs', () => {
    expect(report).toContain('0.3.0');
    expect(report).toContain('Chrome/139.0.0.0');
    expect(report).toContain('gmail-dom');
    expect(report).toContain('missing:  sender');
  });

  it('reduces a user agent to the browser version alone', () => {
    expect(
      browserVersion(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.7258.67 Safari/537.36',
      ),
    ).toBe('Chrome/139.0.7258.67');
    expect(
      browserVersion('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:158.0) Gecko/20100101 Firefox/158.0'),
    ).toBe('Firefox/158.0');
    expect(browserVersion('something else entirely')).toBe('unknown');
  });

  /**
   * The privacy claim the card makes about the report, tested where it can be: no field of the input
   * carries message content, so no output can. A future author who adds `subject` or a body length to
   * `DiagnosticInput` to make debugging easier will not be caught by this, hence the file header on
   * `diagnostics.ts` listing what was excluded and why.
   */
  it('carries nothing from the message', () => {
    const phish = loadFixture('microsoft-phish').email;
    for (const secret of [phish.senderEmail, phish.subject, phish.bodyText.slice(0, 40)]) {
      if (secret === undefined || secret === '') continue;
      expect(report).not.toContain(secret);
    }
  });
});

/**
 * The session tally behind the popup's health row.
 *
 * What makes it worth testing is the sampling: probing every selector candidate per message would be
 * work spent on the case where nothing is wrong, so it happens on the first message and thereafter only
 * on a miss. Get that wrong in either direction and the feature either costs measurably or reports
 * nothing.
 */
describe('the session health tally', () => {
  const clean: SelectorProbe[] = [{ group: 'senderSpan', scope: 'message', candidate: 0 }];
  const drifting: SelectorProbe[] = [{ group: 'senderSpan', scope: 'message', candidate: 2 }];

  it('counts messages and the parts that went unread', () => {
    const log = new HealthLog();
    log.record([], true, () => clean);
    log.record(['subject'], true, () => clean);
    log.record(['subject'], true, () => clean);
    log.record(['sender'], false, () => clean);

    const summary = log.summary();
    expect(summary.seen).toBe(4);
    expect(summary.unscorable).toBe(1);
    expect(summary.misses).toEqual([
      { part: 'subject', count: 2 },
      { part: 'sender', count: 1 },
    ]);
  });

  it('probes the first message, then only when something was missed', () => {
    let probes = 0;
    const log = new HealthLog();
    const probe = (): SelectorProbe[] => {
      probes += 1;
      return clean;
    };

    log.record([], true, probe);
    expect(probes).toBe(1);

    for (let i = 0; i < 10; i += 1) log.record([], true, probe);
    expect(probes).toBe(1);

    log.record(['subject'], true, probe);
    expect(probes).toBe(2);
  });

  it('reports a group that matched something other than its preferred candidate', () => {
    const log = new HealthLog();
    log.record([], true, () => drifting);
    expect(log.summary().drifted).toEqual(['senderSpan']);
  });

  it('reports no drift while every group matches its first candidate', () => {
    const log = new HealthLog();
    log.record([], true, () => clean);
    expect(log.summary().drifted).toEqual([]);
  });

  /**
   * Counting a no-match as a fallback makes a healthy session report drift in several groups and the popup
   * warn that Gmail has changed. Most of the selector table is
   * *expected* to miss on any given message: nothing collapsed in a single-message thread, no quoted
   * reply, no attachments, no list rows while a message is open, and no unauthenticated-sender avatar
   * exactly when the sender authenticated. A warning that fires on every ordinary session is one nobody
   * reads by the time it means something.
   */
  it('does not read an absent group as drift', () => {
    const log = new HealthLog();
    log.record([], true, () => [
      { group: 'senderSpan', scope: 'message', candidate: 0 },
      { group: 'attachmentChip', scope: 'none', candidate: -1 },
      { group: 'quotedContent', scope: 'none', candidate: -1 },
      { group: 'listRow', scope: 'none', candidate: -1 },
      { group: 'unauthenticatedIndicator', scope: 'none', candidate: -1 },
    ]);

    expect(log.summary().drifted).toEqual([]);
  });

  it('still reports a real fallback alongside groups that are simply absent', () => {
    const log = new HealthLog();
    log.record([], true, () => [
      { group: 'attachmentChip', scope: 'none', candidate: -1 },
      { group: 'body', scope: 'message', candidate: 3 },
    ]);

    expect(log.summary().drifted).toEqual(['body']);
  });

  /**
   * The other half of the same failure: `warningBanner` reported as `document #4` reads like a group
   * hanging on by its last candidate and is nothing of the sort. The probe searches the page once the
   * message comes up empty, and the page of a message with no warning on it always holds something for
   * `role="alert"` to find. Counting that would make the row fire on ordinary mail just as surely as
   * counting a no-match.
   */
  it('does not read a page-wide match as drift in a group read from the message', () => {
    const log = new HealthLog();
    log.record([], true, () => [{ group: 'warningBanner', scope: 'document', candidate: 4 }]);

    expect(log.summary().drifted).toEqual([]);
  });

  /** The inverse: for the groups genuinely read from the page, a page match is the one that counts. */
  it('reports a late candidate in a group that is read from the page', () => {
    const log = new HealthLog();
    log.record([], true, () => [
      { group: 'subject', scope: 'document', candidate: 3 },
      { group: 'conversationRoot', scope: 'document', candidate: 0 },
    ]);

    expect(log.summary().drifted).toEqual(['subject']);
  });

  /**
   * The same claim as the single-message report, for the button that copies this one. Both formatters are
   * pure so that this can be asked at all: given only counts, part names and selector groups there is no
   * path by which a message could reach the clipboard.
   */
  it('produces a report carrying nothing from any message', () => {
    const phish = loadFixture('microsoft-phish').email;
    const report = formatHealth({
      adapter: 'gmail-dom',
      version: '0.3.0',
      browser: 'Chrome/139.0.0.0',
      health: {
        seen: 3,
        unscorable: 1,
        misses: [{ part: 'sender', count: 1 }],
        drifted: ['senderSpan'],
      },
      probes: drifting,
      scoring: null,
      listPass: null,
    });

    expect(report).toContain('senderSpan');
    expect(report).toContain('unread:      sender ×1');
    for (const secret of [phish.senderEmail, phish.subject, phish.bodyText.slice(0, 40)]) {
      if (secret === undefined || secret === '') continue;
      expect(report).not.toContain(secret);
    }
  });
});

// ---------------------------------------------------------------------------
// The scoring half of the report
// ---------------------------------------------------------------------------

/**
 * The section that makes a *score* arguable rather than only an extraction failure.
 *
 * It is the one part of the report derived from a scored message, so the danger it carries is different
 * from the rest of the file's: not that a report says too little, but that it says too much. Every signal
 * the engine produces travels with a title, a description and an evidence excerpt, all built around a
 * value from someone's mail, and `SecuritySignal` is structurally assignable to the shape the report
 * wants. A spread would compile and quietly put a subject line on the clipboard.
 */
describe('the scoring half of the report', () => {
  const probes: SelectorProbe[] = [{ group: 'senderSpan', scope: 'message', candidate: 0 }];
  const health = { seen: 1, unscorable: 0, misses: [], drifted: [] };

  function reportFor(scoring: ScoringSummary | null, listPass: ListPassCounts | null = null): string {
    return formatHealth({
      adapter: 'gmail-dom',
      version: '0.6.0',
      browser: 'Chrome/140.0.0.0',
      health,
      probes,
      scoring,
      listPass,
    });
  }

  /** A message whose every free-text field is a string a report must not contain. */
  const loud: EmailMessage = {
    senderName: 'Accounts SECRETNAME',
    senderEmail: 'billing@secretsender.example',
    subject: 'SECRETSUBJECT about your account',
    bodyText: 'SECRETBODY, and then several more words of it.',
    hiddenText: { chars: 40, techniques: ['font-size:0'] },
    links: [{ href: 'https://secretlink.example/a', text: 'SECRETANCHOR', normalizedDomain: 'secretlink.example' }],
    attachments: [{ filename: 'SECRETFILE.zip', extension: 'zip' }],
  };

  const result: AnalysisResult = {
    score: 50,
    classification: 'suspicious',
    signals: [
      {
        id: 'identity.display_name_impersonation',
        category: 'identity',
        severity: 'high',
        score: 50,
        title: 'Display name claims SECRETBRAND',
        description: 'The sender SECRETSENDER does not belong to SECRETBRAND.',
        evidence: { value: 'secretsender.example', text: 'SECRETEXCERPT' },
      },
      {
        id: 'content.urgency',
        category: 'content',
        severity: 'low',
        score: 4,
        title: 'Urgent wording: SECRETPHRASE',
        description: 'SECRETPHRASE appears in the body.',
        dampened: true,
      },
    ],
    categoryScores: { identity: 50, link: 0, attachment: 0, content: 4, authentication: 0, llm: 0 },
    meta: { analyzedAt: 0, engineVersion: 'test', semanticSource: 'none' },
  };

  it('names every check with the severity and the points it contributed', () => {
    const report = reportFor(summarizeScoring(result, loud, 'ready'));

    expect(report).toContain('message:     50/100 suspicious, semantic ready');
    expect(report).toContain('identity.display_name_impersonation');
    // Severity, then contribution, then the rule name: the order a reader scans for what they disagree
    // with. Padding is not pinned, since aligning the columns is presentation.
    expect(report).toMatch(/high\s+50\s+identity\.display_name_impersonation/u);
  });

  /**
   * The assertion this section exists to satisfy. Written against every free-text field at once rather
   * than the ones the current formatter happens to read, so a later line added to the report is caught
   * by this test rather than by someone reading their own subject line in a public issue.
   */
  it('carries no wording from the scored message', () => {
    const report = reportFor(summarizeScoring(result, loud, 'ready'));

    for (const secret of [
      'SECRETNAME',
      'secretsender.example',
      'SECRETSUBJECT',
      'SECRETBODY',
      'SECRETANCHOR',
      'secretlink.example',
      'SECRETFILE',
      'SECRETBRAND',
      'SECRETSENDER',
      'SECRETPHRASE',
      'SECRETEXCERPT',
    ]) {
      expect(report).not.toContain(secret);
    }
  });

  /** The counts are what distinguish a body that was read from one that was pruned to nothing. */
  it('reports what was read as counts', () => {
    const report = reportFor(summarizeScoring(result, loud, 'ready'));

    expect(report).toContain('read:        body 46c, 1 links, 1 attachments');
    expect(report).toContain('concealed:   40c via font-size:0');
  });

  it('omits the concealment line when the scan found nothing hidden', () => {
    const { hiddenText: _hidden, ...plain } = loud;
    expect(reportFor(summarizeScoring(result, plain, 'ready'))).not.toContain('concealed:');
  });

  /**
   * Dampening is one of the commonest reasons a score is lower than a reader expected, so the report
   * says which finding was softened. Omitting it would invite the same question a second time.
   */
  it('marks a dampened finding rather than dropping it', () => {
    expect(reportFor(summarizeScoring(result, loud, 'ready'))).toContain('content.urgency  (dampened)');
  });

  /**
   * A check's own score is raw, before its category's cap, so the report sums what each category
   * actually added and names a floor that decided the rest, since "llm 23" beside a 15-point cap otherwise
   * reads as the cap having failed.
   */
  it('shows what each category added after its cap, and what a floor added', () => {
    const capped: AnalysisResult = {
      ...result,
      score: 50,
      categoryScores: { identity: 21, link: 0, attachment: 0, content: 0, authentication: 0, llm: 15 },
    };
    const report = reportFor(summarizeScoring(capped, loud, 'ready'));
    expect(report).toContain('score:       identity 21 + llm 15 + floor 14 = 50');
    expect(report).toContain('checks (raw points, before category caps):');
  });

  it('copies only the four fields a check is allowed to contribute', () => {
    const [first] = summarizeScoring(result, loud, 'ready').checks;
    expect(Object.keys(first ?? {}).sort()).toEqual(['dampened', 'id', 'score', 'severity']);
  });

  it('says outright that nothing on screen was scored', () => {
    expect(reportFor(null)).toContain('message:     none scored');
  });

  /**
   * All three counts, because they answer different questions: no rows means the row selector stopped
   * matching, rows without addresses means the attribute the sender is read from has moved, and rows
   * with addresses and no marks is the healthy case on ordinary mail.
   */
  it('reports the list pass, and distinguishes a pass with no marks from no pass at all', () => {
    expect(reportFor(null, { rows: 92, addressable: 92, marked: 0 })).toContain(
      'list pass:   92 rows, 92 with an address, 0 marked',
    );
    expect(reportFor(null)).toContain('list pass:   not run');
  });
});
