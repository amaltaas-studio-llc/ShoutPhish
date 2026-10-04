/**
 * The analysis pipeline, split into two entry points so that "the LLM is optional" is structural rather
 * than a promise:
 *
 *  - `analyzeDeterministic()`: pure and synchronous. No I/O, no Chrome, no DOM, no clock beyond one
 *    injected timestamp. It produces a complete, classified result on its own, and it is what the test
 *    suite exercises against fixtures.
 *  - `analyze()`: the same thing, plus at most the semantic category's weight folded on top.
 *
 * The deterministic result is the product, not a degraded mode.
 */
import type {
  AnalysisResult,
  EmailMessage,
  SecuritySignal,
  SemanticAnalysis,
  SemanticAnalyzer,
  SemanticSource,
  SemanticStatus,
} from '../shared/types.js';
import { isAborted } from '../shared/abort.js';
import { logger } from '../shared/logger.js';
import { buildContext, type AnalysisContext } from './context.js';
import { SemanticFailure } from './llm/failure.js';
import { isCorroborated, semanticToSignals } from './llm/semantic-signals.js';
import { runRuleEngine } from './rules/index.js';
import {
  applyFloor,
  classify,
  scoreSignals,
  sortSignalsForDisplay,
} from './scoring/aggregate.js';
import { DEFAULT_SCORING_CONFIG, type ScoringConfig } from './scoring/config.js';

declare const __SHOUTPHISH_VERSION__: string;

export const ENGINE_VERSION =
  typeof __SHOUTPHISH_VERSION__ === 'undefined' ? '0.0.0-dev' : __SHOUTPHISH_VERSION__;

export interface DeterministicOptions {
  config?: ScoringConfig;
  /** Injected so results are reproducible in tests. */
  now?: number;
  /**
   * Senders the user trusts, from settings. An argument rather than something the engine reads, which is
   * what keeps `analysis/` free of `chrome.*` and keeps the same input producing the same result.
   */
  trustedSenders?: readonly string[];
}

export interface AnalyzeOptions extends DeterministicOptions {
  /** Forwarded to the analyzer so a superseded message stops occupying the model. */
  signal?: AbortSignal;
}

export interface DeterministicResult extends AnalysisResult {
  /** Retained for the UI's highlighting and for the semantic stage; never serialised anywhere. */
  context: AnalysisContext;
}

/**
 * The full deterministic analysis. Pure: same input, same output.
 */
export function analyzeDeterministic(
  email: EmailMessage,
  options: DeterministicOptions = {},
): DeterministicResult {
  const config = options.config ?? DEFAULT_SCORING_CONFIG;
  const context = buildContext(email, { trustedSenders: options.trustedSenders });
  const signals = runRuleEngine(context);

  return {
    ...buildResult(signals, config, options.now ?? Date.now(), 'none'),
    context,
  };
}

/**
 * Deterministic analysis plus an optional semantic verdict.
 *
 * The semantic stage cannot fail the analysis: if the analyzer is unavailable, throws, times out, or
 * returns something that does not validate, the deterministic result is returned unchanged with
 * `semanticSource: 'none'` and zero `llm` contribution.
 */
export async function analyze(
  email: EmailMessage,
  analyzer: SemanticAnalyzer | null,
  options: AnalyzeOptions = {},
): Promise<AnalysisResult> {
  return refine(email, analyzeDeterministic(email, options), analyzer, options);
}

/**
 * `analyze()` for a caller that already has the deterministic result, so the rule engine runs once per
 * message rather than once for the first paint and again under the model.
 *
 * `deterministic` must have been produced from `email` with the same options, in particular the same
 * trust list, or the refined score would silently undo the trust the first paint applied.
 */
export async function refine(
  email: EmailMessage,
  deterministic: DeterministicResult,
  analyzer: SemanticAnalyzer | null,
  options: Pick<AnalyzeOptions, 'config' | 'now' | 'signal'> = {},
): Promise<AnalysisResult> {
  const config = options.config ?? DEFAULT_SCORING_CONFIG;

  if (analyzer === null) return withSemanticStatus(stripContext(deterministic), 'off');

  const semantic = await runSemanticSafely(analyzer, email, options.signal);
  if (semantic.analysis === null) {
    return withSemanticStatus(stripContext(deterministic), semantic.status, semantic.reason);
  }

  // The deterministic signals are passed in so the semantic layer knows whether anything checkable
  // supports its reading. They are inputs to *its* weighting only; none of them is altered.
  const combined = [
    ...deterministic.signals,
    ...semanticToSignals(semantic.analysis, deterministic.signals),
  ];
  return {
    ...withSemanticStatus(
      buildResult(combined, config, options.now ?? Date.now(), semantic.analysis.source),
      'ready',
    ),
    semantic: semantic.analysis,
  };
}

interface SemanticOutcome {
  analysis: SemanticAnalysis | null;
  /** Never `pending`, `off` or `skipped`: this describes an attempt that has already finished. */
  status: Exclude<SemanticStatus, 'pending' | 'off' | 'skipped'>;
  /** Why an `error` happened, only when the adapter vouched for the wording; see `SemanticFailure`. */
  reason?: string;
}

/**
 * Runs the analyzer such that no failure mode reaches the caller.
 *
 * `isAvailable()` is contractually non-throwing, but this does not rely on adapters honouring their
 * contract: an unstable browser API is exactly where one gets broken.
 *
 * The statuses are kept apart because they mean different things downstream: `unavailable` describes
 * the browser and is permanent, `no-output` and `error` describe this one message, and `cancelled`
 * describes only the reader navigating away. The card words them differently, so collapsing them here
 * would make that impossible.
 */
async function runSemanticSafely(
  analyzer: SemanticAnalyzer,
  email: EmailMessage,
  signal?: AbortSignal,
): Promise<SemanticOutcome> {
  try {
    if (!(await analyzer.isAvailable())) return { analysis: null, status: 'unavailable' };
  } catch (error) {
    logger.debug('semantic availability check threw', error);
    return { analysis: null, status: 'unavailable' };
  }

  try {
    const analysis = await analyzer.analyze(email, signal === undefined ? {} : { signal });
    if (analysis !== null) return { analysis, status: 'ready' };
    // A cancelled attempt also resolves to null, and calling that "the model declined to answer" is untrue.
    return { analysis: null, status: isAborted(signal) ? 'cancelled' : 'no-output' };
  } catch (error) {
    // An abort surfaces as a rejection in most adapters, and is not a failure of the model.
    if (isAborted(signal)) return { analysis: null, status: 'cancelled' };
    logger.debug('semantic analysis threw', error);
    return error instanceof SemanticFailure
      ? { analysis: null, status: 'error', reason: error.message }
      : { analysis: null, status: 'error' };
  }
}

/**
 * Whether a model's reading of this message could move its score.
 *
 * `false` when no technical check found anything that stands on its own, because an uncorroborated
 * reading contributes nothing (`SEMANTIC_SCORING.uncorroboratedFactor`). The caller uses it to skip an
 * inference whose only output would be a zero-point note, which is also why it must be the same
 * predicate `semanticToSignals` scores by, and not a lookalike.
 */
export function semanticCanScore(result: Pick<AnalysisResult, 'signals'>): boolean {
  return isCorroborated(result.signals);
}

/** Records how the semantic stage ended, without touching anything the rule engine decided. */
export function withSemanticStatus(
  result: AnalysisResult,
  status: SemanticStatus,
  reason?: string,
): AnalysisResult {
  // Rebuilt rather than spread, so a reason left over from an earlier attempt cannot outlive it.
  const { semanticReason: _stale, ...meta } = result.meta;
  return {
    ...result,
    meta: { ...meta, semanticStatus: status, ...(reason === undefined ? {} : { semanticReason: reason }) },
  };
}

function buildResult(
  signals: SecuritySignal[],
  config: ScoringConfig,
  now: number,
  semanticSource: SemanticSource,
): AnalysisResult {
  const { total, byCategory } = scoreSignals(signals, config);
  // A conclusive deterministic finding establishes a minimum, so a single-dimension attack is not
  // diluted by the categories it happens not to touch. See scoring/config.ts `SCORE_FLOORS`.
  const score = applyFloor(total, signals);

  return {
    score,
    classification: classify(score, config.thresholds),
    signals: sortSignalsForDisplay(signals),
    categoryScores: byCategory,
    meta: {
      analyzedAt: now,
      engineVersion: ENGINE_VERSION,
      semanticSource,
    },
  };
}

/** Drops the analysis context, which exists for the semantic stage and is never rendered or cached. */
export function stripContext(result: DeterministicResult): AnalysisResult {
  const { context: _context, ...rest } = result;
  return rest;
}

/** Signals that represent a *proven* observation rather than a probabilistic assessment. */
export function observedSignals(result: AnalysisResult): SecuritySignal[] {
  return result.signals.filter((s) => s.category !== 'llm');
}

/** Signals that represent an AI assessment. Rendered separately and labelled as such. */
export function assessmentSignals(result: AnalysisResult): SecuritySignal[] {
  return result.signals.filter((s) => s.category === 'llm');
}

/**
 * The signals a count shown to a reader should include.
 *
 * Not every signal, because the engine also emits observations that exist for transparency and never
 * contributed anything (`authentication.passed` is on nearly every legitimate message), and counting
 * those tells someone with a clean inbox that ShoutPhish found one thing on mail where it found nothing.
 * That is the reassuring surface being wrong, which is the direction this project cares most about.
 *
 * Dampened findings count despite scoring zero: something *was* found and then softened because a
 * verified sender explains it, which is why the card still lists it.
 *
 * Exported because the badge's label and the popup's count must agree, which two separate computations
 * would not guarantee.
 */
export function countedFindings(result: AnalysisResult): SecuritySignal[] {
  return result.signals.filter((s) => s.score > 0 || s.dampened === true);
}
