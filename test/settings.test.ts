/**
 * What a changed setting asks of the message already on screen.
 *
 * The content script needs a DOM and the Chrome APIs, so this decision lives outside it to be assertable
 * here, and because it is the kind of decision that is wrong silently. Two failures of this shape: pointing
 * the extension at a different model while the previous model's verdicts stay in the cache for the life of
 * the tab, and toggling the badge's visibility with nothing changing on screen until the reader opens
 * another message. Neither looks like a bug from the outside; both look like a setting that does not work.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, settingsImpact } from '../src/shared/settings.js';
import type { Settings } from '../src/shared/types.js';

const BASE: Settings = { ...DEFAULT_SETTINGS, trustedSenders: [] };

function changed(patch: Partial<Settings>): ReturnType<typeof settingsImpact> {
  return settingsImpact(BASE, { ...BASE, ...patch });
}

/**
 * A different value for every setting there is.
 *
 * Enumerated rather than generated so that adding a setting fails a test until somebody decides what it
 * does to a view in flight. Silence is the one answer that cannot be right: a setting that changes nothing
 * about the extension's behaviour would not be a setting.
 */
const ALTERNATIVES: { [K in keyof Settings]: Settings[K] } = {
  analysisConsent: true,
  aiMode: 'local',
  aiOnlyWhenFlagged: false,
  highlightEnabled: false,
  showBadgeWhenLow: false,
  listMarksEnabled: true,
  backendBaseUrl: 'https://analysis.northwind-tools.example',
  modelBaseUrl: 'http://127.0.0.1:11434',
  modelName: 'a-different-model',
  trustedSenders: ['northwind-logistics.com'],
};

describe('settingsImpact', () => {
  it('has an answer for every setting', () => {
    expect(Object.keys(ALTERNATIVES).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());

    for (const [key, value] of Object.entries(ALTERNATIVES)) {
      const impact = changed({ [key]: value });
      expect(Object.values(impact).some((required) => required), key).toBe(true);
    }
  });

  it('asks for nothing when nothing changed', () => {
    const impact = settingsImpact(BASE, { ...BASE, trustedSenders: [...BASE.trustedSenders] });
    expect(Object.values(impact).some((required) => required)).toBe(false);
  });

  /** A different server is a different judge: other reasons, another risk number, possibly a larger model. */
  it('treats the model behind a mode as part of the mode', () => {
    expect(changed({ modelBaseUrl: 'http://127.0.0.1:11434' }).rescore).toBe(true);
    expect(changed({ modelName: 'a-different-model' }).rescore).toBe(true);
    expect(changed({ backendBaseUrl: 'https://analysis.northwind-tools.example' }).rescore).toBe(true);
    expect(changed({ aiMode: 'local' }).rescore).toBe(true);
  });

  it('separates a changed judge from a changed verdict', () => {
    // The trust list changes the dampening the rules apply, and nothing about which model is asked.
    const trust = changed({ trustedSenders: ['northwind-logistics.com'] });
    expect(trust.rescore).toBe(true);
    expect(trust.remodel).toBe(false);
  });

  /** Order-insensitive, because the trust list is a set that happens to be stored as an array. */
  it('does not treat a reordered trust list as a change', () => {
    const before: Settings = { ...BASE, trustedSenders: ['a.example', 'b.example'] };
    const after: Settings = { ...BASE, trustedSenders: ['b.example', 'a.example'] };
    expect(settingsImpact(before, after).rescore).toBe(false);
  });

  it('asks for a repaint, and not a re-analysis, for the badge threshold', () => {
    const impact = changed({ showBadgeWhenLow: false });
    expect(impact.repaint).toBe(true);
    expect(impact.rescore).toBe(false);
  });

  /**
   * The view on screen must be re-gated, or it keeps saying the model was not asked under a setting that
   * says it always is. It is not a new judge, though: the model's finished readings are still its own.
   */
  it('re-scores, without discarding the model, when the gate on asking it changes', () => {
    expect(changed({ aiOnlyWhenFlagged: false })).toMatchObject({ rescore: true, remodel: false });
  });

  /** Starting or stopping reading is not a re-analysis: one begins from nothing, the other ends in nothing. */
  it('reports consent as its own change', () => {
    expect(changed({ analysisConsent: true })).toMatchObject({ consent: true, rescore: false });
  });

  it('keeps the two annotations that own their own teardown separate', () => {
    expect(changed({ listMarksEnabled: true })).toMatchObject({ listMarks: true, rescore: false });
    expect(changed({ highlightEnabled: false })).toMatchObject({ highlights: true, rescore: false });
  });
});
