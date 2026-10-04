/**
 * The popup's wording.
 *
 * Worth asserting rather than eyeballing because the popup is consulted when something looks wrong, and
 * the two sentences it must never confuse, "nothing was found" and "nothing was checked", are one
 * careless edit apart.
 */
import { describe, expect, it } from 'vitest';
import {
  aiRow,
  cardButtonLabel,
  findingsLine,
  headline,
  healthRow,
  reportRow,
} from '../src/popup/present.js';
import type { PopupState } from '../src/popup/present.js';
import type { TabHealth } from '../src/shared/messaging.js';
import { DEFAULT_SETTINGS } from '../src/shared/settings.js';
import type { SemanticStatus, Settings } from '../src/shared/types.js';

const scored = (over: Partial<Extract<PopupState, { kind: 'scored' }>> = {}): PopupState => ({
  kind: 'scored',
  score: 58,
  classification: 'suspicious',
  findings: 4,
  headlines: ['Display name does not match the sending domain'],
  semantic: 'ready',
  ...over,
});

const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });

describe('headline', () => {
  it('shows the score and classification for a scored message', () => {
    const head = headline(scored());
    expect(head.label).toBe('Suspicious');
    expect(head.score).toBe('58/100');
    expect(head.tone).toBe('suspicious');
  });

  it('never presents an unreadable message as a clean one', () => {
    const head = headline({ kind: 'unreadable', missing: ['sender'] });
    expect(head.score).toBe('');
    expect(head.tone).toBe('unknown');
    expect(head.label).not.toMatch(/low|safe|clean/i);
    // The load-bearing sentence. Its absence is the failure this project refuses.
    expect(head.note).toMatch(/not a judgement that the message is safe/i);
  });

  it('names every unread part in the explanation', () => {
    const head = headline({ kind: 'unreadable', missing: ['sender', 'body'] });
    expect(head.note).toContain('who it is from');
    expect(head.note).toContain('its text');
  });

  it('distinguishes a clean message from an unchecked one', () => {
    const clean = headline(scored({ score: 0, classification: 'low', findings: 0 }));
    const unchecked = headline({ kind: 'unreadable', missing: ['sender'] });
    expect(clean.note).not.toBe(unchecked.note);
    expect(clean.note).toMatch(/checks found (nothing|anything)/i);
  });

  /**
   * A finding can be listed and still contribute nothing: dampening zeroes a combination finding when
   * the sender is one the reader verified. Claiming the score is built from readable findings while the
   * score is zero reads as a bug in the extension, which costs more than the sentence gains.
   */
  it('does not claim a zero score was built out of findings', () => {
    const note = headline(scored({ score: 0, classification: 'low', findings: 2 })).note;
    expect(note).not.toMatch(/every point/i);
    expect(note).toMatch(/added to the score/i);
  });

  it('tells a tab that predates the extension to reload', () => {
    expect(headline({ kind: 'unreachable' }).note).toMatch(/reload/i);
  });

  /**
   * Without the Gmail permission the popup cannot read the tab's address, so this is the state a user
   * looking at Gmail actually sees. It must say nothing is checked, never that there is nothing to check.
   */
  it('tells a user who withheld Gmail access that nothing is being checked', () => {
    const head = headline({ kind: 'no-gmail-access' });
    expect(head.tone).toBe('unknown');
    expect(head.score).toBe('');
    expect(head.note).toMatch(/checks nothing/i);
    expect(head.note).toMatch(/allow access/i);
    expect(head.label).not.toBe(headline({ kind: 'not-gmail' }).label);
    expect(cardButtonLabel({ kind: 'no-gmail-access' })).toBeNull();
    expect(findingsLine({ kind: 'no-gmail-access' })).toBeNull();
  });

  /**
   * Before consent nothing is checked anywhere, and an inbox without badges is also what clean mail looks
   * like. The popup is where someone goes to find out which of the two they are looking at.
   */
  it('says plainly that nothing is checked before the reader has started it', () => {
    const head = headline({ kind: 'not-started' });
    expect(head.tone).toBe('unknown');
    expect(head.score).toBe('');
    expect(head.note).toMatch(/not checking your mail/i);
    expect(head.label).not.toBe(headline({ kind: 'no-message' }).label);
    expect(cardButtonLabel({ kind: 'not-started' })).toBeNull();
    expect(findingsLine({ kind: 'not-started' })).toBeNull();
  });

  it('offers no verdict glyph where there is no verdict', () => {
    for (const kind of ['not-gmail', 'no-message', 'pending'] as const) {
      expect(headline({ kind }).glyph).toBe('');
      expect(headline({ kind }).score).toBe('');
    }
  });
});

describe('findingsLine', () => {
  it('counts findings, singular and plural', () => {
    expect(findingsLine(scored({ findings: 1 }))).toBe('1 finding');
    expect(findingsLine(scored({ findings: 4 }))).toBe('4 findings');
    expect(findingsLine(scored({ findings: 0 }))).toBe('No findings');
  });

  it('counts nothing when nothing was scored', () => {
    expect(findingsLine({ kind: 'unreadable', missing: ['body'] })).toBeNull();
    expect(findingsLine({ kind: 'not-gmail' })).toBeNull();
  });
});

describe('cardButtonLabel', () => {
  it('offers the card exactly when the tab has one to show', () => {
    expect(cardButtonLabel(scored())).not.toBeNull();
    expect(cardButtonLabel({ kind: 'unreadable', missing: ['sender'] })).not.toBeNull();
    expect(cardButtonLabel({ kind: 'pending' })).toBeNull();
    expect(cardButtonLabel({ kind: 'no-message' })).toBeNull();
    expect(cardButtonLabel({ kind: 'not-gmail' })).toBeNull();
  });

  it('does not promise an assessment for a message that was never assessed', () => {
    expect(cardButtonLabel({ kind: 'unreadable', missing: ['sender'] })).not.toMatch(/assessment/i);
  });
});

describe('aiRow', () => {
  it('reports the mode by what it is, not by its stored value', () => {
    expect(aiRow(settings({ aiMode: 'local' }), scored()).label).toBe('On-device model');
    expect(aiRow(settings({ aiMode: 'server' }), scored()).label).toBe('Your model server');
  });

  it('says analysis is off without implying a failure', () => {
    const row = aiRow(settings({ aiMode: 'off' }), scored({ semantic: 'off' }));
    expect(row.detail).toMatch(/switched off/i);
    expect(row.fix).toBeNull();
    expect(row.testable).toBe(false);
  });

  it('has wording for every semantic status', () => {
    const statuses: SemanticStatus[] = [
      'ready',
      'pending',
      'off',
      'skipped',
      'unavailable',
      'no-output',
      'error',
      'cancelled',
    ];
    for (const semantic of statuses) {
      const row = aiRow(settings({ aiMode: 'local' }), scored({ semantic }));
      expect(row.detail).not.toBe('');
    }
  });

  /**
   * A model that was not asked has said nothing, and the row must not read as though it looked and
   * approved. "Not asked" with its reason is the whole of what is true.
   */
  it('words a skipped reading as not asked, never as an all-clear', () => {
    const row = aiRow(settings({ aiMode: 'local' }), scored({ semantic: 'skipped', score: 0 }));
    expect(row.detail).toMatch(/not asked/iu);
    expect(row.detail).not.toMatch(/safe|clean|nothing of concern|approved/iu);
  });

  it('points a failing model server at the connection test', () => {
    const configured = settings({
      aiMode: 'server',
      modelBaseUrl: 'http://localhost:11434/v1',
      modelName: 'qwen2.5:7b',
    });
    for (const semantic of ['no-output', 'error'] as const) {
      const row = aiRow(configured, scored({ semantic }));
      expect(row.testable).toBe(true);
      expect(row.fix).toMatch(/test the connection/i);
    }
  });

  it('asks for the missing settings rather than offering a test that cannot work', () => {
    const row = aiRow(settings({ aiMode: 'server' }), scored());
    expect(row.testable).toBe(false);
    expect(row.fix).toMatch(/settings/i);
  });

  it('does not offer a connection test for the on-device model', () => {
    expect(aiRow(settings({ aiMode: 'local' }), scored({ semantic: 'unavailable' })).testable).toBe(
      false,
    );
  });

  it('does not claim to be waiting for a message that is already open', () => {
    const row = aiRow(settings({ aiMode: 'local' }), { kind: 'unreadable', missing: ['sender'] });
    expect(row.detail).toMatch(/not used/i);
  });

  it('reports configuration, not a verdict, before a message is open', () => {
    const row = aiRow(settings({ aiMode: 'local' }), { kind: 'no-message' });
    expect(row.detail).not.toMatch(/unavailable/i);
    expect(row.fix).toBeNull();
  });

  it('explains an absent on-device model without implying the checks failed', () => {
    const row = aiRow(settings({ aiMode: 'local' }), scored({ semantic: 'unavailable' }));
    expect(row.fix).toMatch(/technical checks are unaffected/i);
  });
});

describe('healthRow', () => {
  const health = (over: Partial<TabHealth> = {}): TabHealth => ({
    seen: 20,
    unscorable: 0,
    misses: [],
    drifted: [],
    ...over,
  });

  it('says nothing while everything is being read', () => {
    expect(healthRow(health())).toBeNull();
  });

  it('says nothing before enough messages to see a pattern', () => {
    // One unusual message is not evidence that Gmail changed, and sending someone to file a report
    // about it wastes their time and ours.
    expect(healthRow(health({ seen: 1, unscorable: 1 }))).toBeNull();
  });

  it('leads with the count of messages that were not scored', () => {
    const row = healthRow(health({ seen: 20, unscorable: 3 }));
    expect(row?.headline).toBe('3 of 20 messages could not be read');
    expect(row?.detail).toMatch(/not scored/i);
  });

  it('names the part that went unread when the score still stood', () => {
    const row = healthRow(health({ misses: [{ part: 'subject', count: 6 }] }));
    expect(row?.headline).toBe('6 of 20 messages had no readable subject');
    expect(row?.detail).toMatch(/still scored/i);
  });

  /**
   * The only row that speaks up while every check is still working, so it is worded as the warning it
   * is. It must not read as a present failure: someone who concludes their scores are already wrong
   * will stop trusting the ones that are fine.
   */
  it('warns about a selector list running on a fallback before it breaks', () => {
    const row = healthRow(health({ drifted: ['senderEmail'] }));
    expect(row?.headline).toMatch(/may soon/i);
    expect(row?.detail).toMatch(/normally today/i);
    expect(row?.headline).not.toMatch(/fallback|selector|candidate/i);
  });

  it('promises the report holds no mail, on every branch that offers one', () => {
    const rows = [
      healthRow(health({ unscorable: 2 })),
      healthRow(health({ misses: [{ part: 'subject', count: 2 }] })),
      healthRow(health({ drifted: ['senderEmail'] })),
    ];
    for (const row of rows) {
      expect(row?.detail).toMatch(/none of your mail/i);
    }
  });
});

/**
 * The copy affordance is deliberately independent of `healthRow` above. That row stays silent while
 * extraction is healthy, and a score someone disagrees with is a bug report about a healthy session,
 * so attaching the only copy button to the row would make the report unreachable in the case it is most
 * wanted for.
 */
describe('reportRow', () => {
  it('offers a report on a scored message, with the tally saying nothing', () => {
    const row = reportRow(scored({ score: 12, classification: 'low' }));
    expect(row).not.toBeNull();
    expect(row?.note).toMatch(/checks that ran on this message/i);
  });

  it('describes the session instead when no message has been scored', () => {
    const row = reportRow({ kind: 'no-message' });
    expect(row?.note).toMatch(/how ShoutPhish has been reading this tab/i);
    expect(row?.note).toMatch(/open a message first/i);
  });

  it.each([
    { kind: 'not-started' } as const,
    { kind: 'not-gmail' } as const,
    { kind: 'no-gmail-access' } as const,
    { kind: 'unreachable' } as const,
  ])(
    'offers nothing for $kind, where a report would describe nothing',
    (state) => {
      expect(reportRow(state)).toBeNull();
    },
  );

  it('says on every branch that the report holds no mail', () => {
    const states: PopupState[] = [
      { kind: 'no-message' },
      { kind: 'pending' },
      { kind: 'unreadable', missing: ['sender'] },
      scored(),
    ];
    for (const state of states) {
      expect(reportRow(state)?.note).toMatch(/no text from the message|none of your mail/i);
    }
  });
});