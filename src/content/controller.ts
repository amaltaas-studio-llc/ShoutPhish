/**
 * Per-tab orchestration: observe → extract → analyse → render.
 *
 * This is where the MV3 statefulness decision lands (docs/adr/0002-mv3-state-in-content-script.md). Everything stateful
 * lives here, in the content script, because this context lives as long as the Gmail tab:
 *   - the on-device model session (via `localAnalyzer()`)
 *   - the bounded model-reading cache
 *   - the badge and panel instances
 *
 * The service worker holds none of it and is only asked for settings, so it can be terminated at any
 * moment without affecting anything in flight.
 */
import {
  analyzeDeterministic,
  countedFindings,
  refine,
  semanticCanScore,
  stripContext,
  withSemanticStatus,
  type DeterministicResult,
} from '../analysis/engine.js';
import { localAnalyzer, resolveAnalyzer } from '../analysis/llm/index.js';
import { isScorable, type MailAdapter, type MessageHandle } from '../gmail/adapter.js';
import {
  buildDiagnostic,
  probeSelectors,
  summarizeScoring,
  summarizeSettings,
  type ScoringSummary,
} from '../gmail/diagnostics.js';
import { GmailObserver, type ObserverEvent } from '../gmail/observer.js';
import { logger } from '../shared/logger.js';
import { isTabRequest, requestSettings, sendMessage, type TabResponse, type TabStatus } from '../shared/messaging.js';
import { DEFAULT_SETTINGS, settingsImpact } from '../shared/settings.js';
import { NOT_STARTED, toolbarBadgeAppearance } from '../shared/toolbar-badge.js';
import { trustState, withTrustedSender, withoutTrustedSender } from '../shared/trust.js';
import type {
  AnalysisResult,
  AnalysisTiming,
  EmailMessage,
  MessagePart,
  SecuritySignal,
  SemanticStatus,
  Settings,
} from '../shared/types.js';
import { Badge } from '../ui/badge.js';
import { Highlighter } from '../ui/highlight.js';
import { Panel, type PanelView, type UnreadableView } from '../ui/panel.js';
import { HealthLog } from './health.js';
import { ListMarks } from './list-marks.js';
import { Readings, readingKey } from './readings.js';

/** Findings named in the popup. Enough to recognise the verdict; the card is where the reasoning is. */
const POPUP_HEADLINES = 3;

interface ActiveView {
  handle: MessageHandle;
  email: EmailMessage;
  /** Parts the adapter could not read. Non-empty in a load-bearing part means nothing was scored. */
  missing: readonly MessagePart[];
  result: AnalysisResult | null;
  /**
   * Where the semantic stage has got to *for this view*. Not derivable from the result: "in flight"
   * describes the view, while the result on screen is the deterministic one and is already complete.
   */
  semantic: SemanticStatus;
  /** `null` until the checks have run; see `AnalysisTiming` for why this is not on the result. */
  timing: AnalysisTiming | null;
}

export class Controller {
  readonly #adapter: MailAdapter;
  readonly #observer: GmailObserver;
  readonly #badge: Badge;
  readonly #panel: Panel;
  readonly #highlighter = new Highlighter();
  #requestedReading: string | null = null;
  readonly #health = new HealthLog();
  readonly #listMarks = new ListMarks();
  /**
   * The model's answers, by what it was shown. The token below stops a stale result being *shown*;
   * this is what stops the work, which matters because the model handles one request at a time.
   */
  readonly #readings = new Readings();

  #settings: Settings = { ...DEFAULT_SETTINGS };
  #active: ActiveView | null = null;
  /** Guards against a slow analysis of a previous message overwriting a newer one. */
  #analysisToken = 0;
  /**
   * Set by `stop()`, and never cleared: a stopped controller is finished, and a page restored from the
   * back/forward cache gets a new one (see `content/index.ts`).
   *
   * Checked after every `await`, because each is a point at which `pagehide` may have run. Without it a
   * `start()` still waiting on settings would go on to register its listeners after `stop()` had removed
   * them, and a settings reload in flight would rebuild the list observer and warm the model on a page
   * that had already been torn down.
   */
  #stopped = false;
  #settingsRequest = 0;

  constructor(adapter: MailAdapter) {
    this.#adapter = adapter;

    this.#badge = new Badge({
      onActivate: () => {
        this.#togglePanel();
      },
    });

    this.#panel = new Panel({
      onFocusSignal: (signal) => {
        this.#highlight(signal);
      },
      onBlurSignal: () => {
        this.#highlighter.clear();
      },
      onClose: () => {
        // Back to the control that opened the card, but only from inside it; see `Panel.close`.
        if (this.#panel.close()) this.#badge.focus();
      },
      onTrustChange: (entry, trusted) => {
        void this.#changeTrust(entry, trusted);
      },
      onRunAssessment: () => {
        void this.#runSkippedAssessment();
      },
    });

    this.#observer = new GmailObserver(adapter, (event) => {
      void this.#handleObserverEvent(event);
    });
  }

  async start(): Promise<void> {
    const settings = await requestSettings();
    if (this.#stopped) return;
    /*
     * A tab restored from the back/forward cache after the extension was reloaded or updated still runs
     * this script, but Chrome has cut it off: `chrome.storage` is gone and nothing can be asked of the
     * worker. Scoring there would use default settings in place of the user's trust list and model, so
     * the orphan stays inert until the tab is reloaded and the current version is injected.
     */
    if (!extensionContextAlive()) {
      this.#stopped = true;
      logger.info('extension was reloaded; reload the tab to analyse messages again');
      return;
    }
    this.#settings = settings;
    logger.info('starting', {
      aiMode: this.#settings.aiMode,
      adapter: this.#adapter.id,
      consent: this.#settings.analysisConsent,
    });

    // Listening is not reading: these are how consent given on the welcome page reaches an open tab,
    // which then starts without being reloaded.
    chrome.storage.onChanged.addListener(this.#handleStorageChanged);
    chrome.runtime.onMessage.addListener(this.#handleTabRequest);
    if (this.#settings.analysisConsent) this.#startReading();
  }

  /**
   * Everything that reads Gmail, started only once the reader has agreed to it: the open message, the
   * list rows, and the on-device model that would be asked about them.
   */
  #startReading(): void {
    this.#observer.start();
    this.#applyListMarks();
    this.#warmModel();
  }

  /** Consent withdrawn: forget what was read and stop reading, leaving nothing on the page. */
  #stopReading(): void {
    this.#observer.stop();
    this.#listMarks.stop();
    this.#teardownView();
    this.#readings.clear();
    this.#syncToolbarBadge();
  }

  stop(): void {
    this.#stopped = true;
    this.#requestedReading = null;
    this.#analysisToken++;
    this.#readings.clear();
    this.#observer.stop();
    this.#listMarks.stop();
    // `pagehide` reaches a script orphaned by an extension reload, whose `chrome.storage` no longer
    // exists; its listeners died with the context, so there is nothing left to remove.
    if (extensionContextAlive()) {
      chrome.storage.onChanged.removeListener(this.#handleStorageChanged);
      chrome.runtime.onMessage.removeListener(this.#handleTabRequest);
    }
    this.#panel.close();
    this.#badge.remove();
    this.#highlighter.dispose();
    this.#active = null;
    this.#syncToolbarBadge();
  }

  // -------------------------------------------------------------------------
  // Observer
  // -------------------------------------------------------------------------

  async #handleObserverEvent(event: ObserverEvent): Promise<void> {
    if (event.kind === 'no-message') {
      logger.debug('no message in view', { reason: event.reason });
      this.#teardownView();
      this.#syncToolbarBadge();
      return;
    }

    const token = ++this.#analysisToken;
    const aiMode = this.#settings.aiMode;
    const active: ActiveView = {
      handle: event.handle,
      email: event.email,
      missing: event.missing,
      result: null,
      semantic: aiMode === 'off' ? 'off' : 'pending',
      timing: null,
    };
    this.#active = active;

    // Recorded for every message, readable or not: the tally's value is the ratio, and counting only
    // the failures would make one unusual message look like Gmail having changed.
    this.#health.record(event.missing, isScorable(event.missing), () => probeSelectors(event.handle));

    if (event.handle.headerElement !== null) {
      this.#badge.attach(event.handle.headerElement);
    }

    /*
     * Nothing is scored when a load-bearing part could not be read.
     *
     * The rule engine would happily score it: with no sender there is nothing for the identity,
     * authentication or thread checks to object to, so it returns a near-zero score, `low`, and a green
     * badge: the most reassuring output the extension can produce, at the moment it knows the least.
     * The badge stays, saying so, because removing it would be indistinguishable from a clean message
     * on a `showBadgeWhenLow: false` install. That setting is not consulted here for the same reason:
     * this is not a low reading.
     */
    if (!isScorable(event.missing)) {
      logger.info('message not scored', { missing: event.missing });
      this.#readings.cancelUnless(null);
      this.#badge.setUnreadable();
      // An open card is repainted, exactly as `#applyResult` does. Moving between messages within one
      // thread is not a route change, so nothing has closed it: without this it would go on displaying
      // the previous message's score beside a badge saying this one was never checked.
      if (this.#panel.isOpen) this.#panel.open(this.#unreadableView(active));
      this.#syncToolbarBadge();
      return;
    }

    this.#badge.setPending();
    this.#syncToolbarBadge();

    // The deterministic result is rendered first and is complete on its own. If a semantic analyzer
    // is available, the score is then refined. This ordering means the user is never waiting on a
    // model for a verdict, and an unavailable model is invisible rather than a failure state.
    const deterministic = this.#runChecks(active);
    const shown = stripContext(deterministic);

    if (aiMode === 'off') {
      this.#readings.cancelUnless(null);
      this.#applyResult(shown, token, 'off');
      return;
    }

    /*
     * Nothing any check found, so nothing the model says can count: an uncorroborated reading scores
     * zero. Asking anyway costs the reader seconds of inference per message for a sentence that cannot
     * change the verdict, so by default the card offers the reading instead of running it, unless the
     * reader already asked for this prompt, or a finished reading for it can be replayed for free.
     */
    const key = readingKey(active.email, aiMode, deterministic.signals.map((s) => s.id));
    if (
      this.#settings.aiOnlyWhenFlagged && !semanticCanScore(deterministic) &&
      this.#requestedReading !== key && !this.#readings.has(key)
    ) {
      this.#readings.cancelUnless(null);
      const skipped = withSemanticStatus(shown, 'skipped');
      this.#applyResult(skipped, token, 'skipped');
      return;
    }

    await this.#refine(active, deterministic, token, key);
  }

  /** The rule engine, timed. Measured here because `analysis/` is not allowed a clock. */
  #runChecks(active: ActiveView): DeterministicResult {
    const started = performance.now();
    const deterministic = analyzeDeterministic(active.email, {
      trustedSenders: this.#settings.trustedSenders,
    });
    active.timing = { checksMs: performance.now() - started, aiReused: false };
    return deterministic;
  }

  /**
   * Asks the model about the view on screen and folds its answer into the score.
   *
   * The deterministic result is passed in rather than recomputed, so the checks run once per view and
   * the refined score is built on exactly the findings the first paint showed, the same trust list
   * included, without which the score would climb back up the moment the model answered.
   */
  async #refine(
    active: ActiveView,
    deterministic: DeterministicResult,
    token: number,
    key: string,
  ): Promise<void> {
    const signalIds = deterministic.signals.map((s) => s.id);
    const lookup = this.#readings.lookup(key, () => resolveAnalyzer(this.#settings, signalIds));
    const timing = active.timing ?? { checksMs: 0, aiReused: false };
    const started = performance.now();
    active.timing = { ...timing, aiReused: lookup?.reused === true, aiStartedAt: started };
    this.#applyResult(stripContext(deterministic), token, 'pending');

    const settle = (): void => {
      if (token !== this.#analysisToken) return;
      const { aiStartedAt: _running, ...rest } = active.timing ?? timing;
      active.timing = { ...rest, aiMs: performance.now() - started };
    };

    try {
      const refined = await refine(active.email, deterministic, lookup?.analyzer ?? null);
      settle();
      this.#applyResult(refined, token, refined.meta.semanticStatus ?? 'no-output');
    } catch (error) {
      // The deterministic result is already on screen; a semantic failure is not a user-facing error.
      // It is still reported *as* a failure rather than left pending, or the card spins forever.
      logger.debug('semantic refinement failed', error);
      settle();
      const failed = withSemanticStatus(stripContext(deterministic), 'error');
      this.#applyResult(failed, token, 'error');
    }
  }

  /**
   * Runs the reading the gate skipped, because the reader asked for it from the card.
   *
   * Only for the view on screen and only from `skipped`, so a stray click cannot start a second
   * inference over one already running. The checks are re-run rather than kept from the first paint:
   * they take milliseconds, and holding every view's context for a button most views never see would
   * cost more than it saves.
   */
  async #runSkippedAssessment(): Promise<void> {
    const active = this.#active;
    if (active?.semantic !== 'skipped' || !isScorable(active.missing)) return;
    if (this.#settings.aiMode === 'off') return;

    const token = this.#analysisToken;
    const deterministic = this.#runChecks(active);
    const key = readingKey(active.email, this.#settings.aiMode, deterministic.signals.map((s) => s.id));
    this.#requestedReading = key;
    await this.#refine(active, deterministic, token, key);
  }

  /** Applies a result only if it belongs to the message currently in view. */
  #applyResult(result: AnalysisResult, token: number, semantic: SemanticStatus): void {
    if (token !== this.#analysisToken) {
      logger.debug('discarding result for a message no longer in view');
      return;
    }
    const active = this.#active;
    if (active === null) return;

    active.result = result;
    active.semantic = semantic;

    if (result.classification !== 'low' || this.#settings.showBadgeWhenLow) {
      if (!this.#badge.isAttached() && active.handle.headerElement !== null) {
        this.#badge.attach(active.handle.headerElement);
      }
      this.#badge.setResult(result);
    } else {
      this.#badge.remove();
    }

    // An open card is updated in place, the refined score replacing the deterministic one, without
    // re-animating or losing the reader's scroll position. This happens whether or not the badge is
    // shown: a refinement that lands on "low" hides the badge, and returning early there would leave the
    // card displaying the score it had just superseded.
    if (this.#panel.isOpen) {
      this.#panel.open(viewOf(active, result, this.#settings));
    }
    this.#syncToolbarBadge();
  }

  /**
   * Adds or removes a trust entry, then re-scores what is on screen.
   *
   * Written through the worker like every other setting, so the bound and the validation in
   * `normalizeTrustList` apply. The re-score is not just a repaint: trust changes what the rule engine
   * does, so the cache is dropped and the message is analysed again; a user who clicks this expects the
   * number to move, and a card that keeps its old score looks like the click did nothing.
   */
  async #changeTrust(entry: string, trusted: boolean): Promise<void> {
    const next = trusted
      ? withTrustedSender(this.#settings.trustedSenders, entry)
      : withoutTrustedSender(this.#settings.trustedSenders, entry);

    logger.debug('trust changed', { trusted, entries: next.length });
    await sendMessage({ type: 'SET_SETTINGS', patch: { trustedSenders: next } });
    // `chrome.storage.onChanged` fires for this write too, and `#reloadSettings` is what re-runs the
    // analysis. Doing it here as well would analyse the same message twice.
  }

  /**
   * Abandons analysis in flight and everything it would have produced.
   *
   * Stopping the work and invalidating its results are one action, never two: the abort is advisory (a
   * round trip already made cannot be recalled, and the adapters can only decline to use what comes back),
   * so the token is what actually keeps a superseded answer off the screen.
   */
  #supersedeAnalysis(): void {
    this.#readings.cancelUnless(null);
    this.#analysisToken += 1;
  }

  #teardownView(): void {
    this.#requestedReading = null;
    this.#supersedeAnalysis();
    this.#panel.close();
    this.#highlighter.clear();
    this.#badge.remove();
    this.#active = null;
  }

  /**
   * Mirrors the in-mail badge onto the toolbar icon for this tab.
   *
   * Fire-and-forget: a missed paint is corrected on the next status change, and waiting on the worker
   * must not delay scoring. Appearance is computed here so the worker stays a dumb applicator.
   */
  #syncToolbarBadge(): void {
    // A tab's own paint hides the worker's `OFF` default, so a tab that has stopped reading repeats it.
    const appearance = this.#settings.analysisConsent
      ? toolbarBadgeAppearance(this.#status(), { showBadgeWhenLow: this.#settings.showBadgeWhenLow })
      : NOT_STARTED;
    void sendMessage({ type: 'SET_TOOLBAR_BADGE', ...appearance });
  }

  // -------------------------------------------------------------------------
  // The popup
  // -------------------------------------------------------------------------

  /**
   * Answers the toolbar popup.
   *
   * Synchronous, and returns `false` so the channel closes immediately: every answer is read from state
   * this object already holds, and keeping the port open for an await would let a popup that closes
   * mid-question leave a dangling response callback.
   *
   * The listener is registered here rather than in `content/index.ts` because the answers are this
   * object's state, and a listener outliving the controller would answer for a torn-down view.
   */
  readonly #handleTabRequest = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    respond: (response: TabResponse) => void,
  ): boolean => {
    // `sender.id` is set by Chrome. A page cannot forge it, so this rejects anything that did not
    // originate in this extension, the popup being the only thing that ever does.
    if (sender.id !== chrome.runtime.id || !isTabRequest(message)) return false;

    if (message.type === 'OPEN_PANEL') {
      this.#revealPanel();
      respond({ ok: true, type: 'ACKNOWLEDGED' });
      return false;
    }

    if (message.type === 'GET_HEALTH_REPORT') {
      respond({ ok: true, type: 'HEALTH_REPORT', report: this.#report() });
      return false;
    }

    respond({ ok: true, type: 'TAB_STATUS', status: this.#status(), health: this.#health.summary() });
    return false;
  };

  /**
   * The pasteable report: how extraction has been going, what the last list pass saw, and how the
   * message on screen scored.
   *
   * The third part is the one that makes a score arguable from a released build. The card already
   * explains the score to the person reading it, but every sentence in it is built around their own
   * mail, so without this the only way to report "this check should not have fired" would be a
   * development build.
   */
  #report(): string {
    return this.#health.report(
      this.#adapter.id,
      this.#scoringSummary(),
      this.#listMarks.lastPass(),
      summarizeSettings(this.#settings),
    );
  }

  /** The scoring half of the report, or `null` when nothing on screen has a score to explain. */
  #scoringSummary(): ScoringSummary | null {
    const active = this.#active;
    if (active?.result == null) return null;
    // A message that could not be read has no score to account for, and the parts it was missing are
    // already in the session tally above it.
    if (!isScorable(active.missing)) return null;
    return summarizeScoring(active.result, active.email, active.semantic, active.timing);
  }

  #status(): TabStatus {
    const active = this.#active;
    if (active === null) return { kind: 'no-message' };
    if (!isScorable(active.missing)) return { kind: 'unreadable', missing: [...active.missing] };

    const result = active.result;
    if (result === null) return { kind: 'pending' };

    // Counted rather than every signal, so the popup agrees with the badge and does not announce a
    // finding on a message where the only signal is "authentication passed".
    const counted = countedFindings(result);

    return {
      kind: 'scored',
      score: result.score,
      classification: result.classification,
      findings: counted.length,
      // Already ordered as the card orders them, so these are the findings a reader would see first.
      headlines: counted.slice(0, POPUP_HEADLINES).map((signal) => signal.title),
      semantic: active.semantic,
    };
  }

  // -------------------------------------------------------------------------
  // UI
  // -------------------------------------------------------------------------

  #togglePanel(): void {
    const view = this.#currentView();
    if (view !== null) this.#panel.toggle(view);
  }

  /** Opens the card rather than toggling it: the popup's button must not close what it describes. */
  #revealPanel(): void {
    const view = this.#currentView();
    if (view !== null) this.#panel.open(view);
  }

  /** What the card would show for the message in view, or `null` while there is nothing to show. */
  #currentView(): PanelView | null {
    const active = this.#active;
    if (active === null) return null;
    if (!isScorable(active.missing)) return this.#unreadableView(active);
    if (active.result === null) return null;
    return viewOf(active, active.result, this.#settings);
  }

  /**
   * The card's input for a message that was not scored.
   *
   * The selector probe runs here rather than during extraction: it walks every candidate list, and the
   * overwhelmingly common case is that this card is never shown at all.
   */
  #unreadableView(active: ActiveView): UnreadableView {
    return {
      kind: 'unreadable',
      email: active.email,
      missing: active.missing,
      diagnostic: buildDiagnostic(active.handle, active.missing, this.#adapter.id),
    };
  }

  /**
   * Builds the on-device session at startup rather than on first use, since creating one costs seconds
   * and that cost would otherwise land on the first message opened. Fire-and-forget.
   */
  #warmModel(): void {
    if (this.#stopped || !this.#settings.analysisConsent || this.#settings.aiMode !== 'local') return;
    void localAnalyzer().warmUp();
  }

  #highlight(signal: SecuritySignal): void {
    if (!this.#settings.highlightEnabled) return;
    const bodyElement = this.#active?.handle.bodyElement ?? null;
    this.#highlighter.show(signal, bodyElement);
  }

  readonly #handleStorageChanged = (
    _changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'sync') return;
    void this.#reloadSettings();
  };

  async #reloadSettings(): Promise<void> {
    const request = ++this.#settingsRequest;
    const settings = await requestSettings();
    // A slower read must not roll the tab back to an earlier settings snapshot.
    if (this.#stopped || request !== this.#settingsRequest) return;
    const previous = this.#settings;
    this.#settings = settings;
    logger.debug('settings reloaded', { aiMode: this.#settings.aiMode });

    const impact = settingsImpact(previous, this.#settings);

    if (impact.consent) {
      if (this.#settings.analysisConsent) this.#startReading();
      else this.#stopReading();
      return;
    }
    if (!this.#settings.analysisConsent) return;

    if (impact.rescore) {
      // A late answer must not repaint a view assessed under different settings.
      this.#supersedeAnalysis();
      // Readings survive a trust change, which alters the score around them and not what the model
      // was shown. A different model is a different judge, so its predecessor's answers go.
      if (impact.remodel) {
        this.#requestedReading = null;
        this.#readings.clear();
        this.#warmModel();
      }
      this.#observer.refresh();
    } else if (impact.repaint) {
      /*
       * Repainted rather than re-analysed. `showBadgeWhenLow` decides whether a low verdict is shown at
       * all, and the verdict itself is unchanged, so running the message through the engine again to
       * make the badge appear would reset the AI status to pending, re-record a health sample, and on a
       * cache miss ask the model a question it has already answered. Without this the switch would do
       * nothing until the reader opened another message, which looks like a setting that does not work.
       */
      this.#repaintActive();
    }

    // Marks and highlights are torn down by their owners, which is why they are not part of a repaint.
    if (impact.highlights && !this.#settings.highlightEnabled) this.#highlighter.clear();
    if (impact.listMarks) this.#applyListMarks();
  }

  /** Re-applies the result already in hand, for a change that alters the picture and not the verdict. */
  #repaintActive(): void {
    const active = this.#active;
    const result = active?.result ?? null;
    if (active === null || result === null) return;
    this.#applyResult(result, this.#analysisToken, active.semantic);
  }

  /**
   * Starts or stops marking list rows.
   *
   * Its own observer rather than a branch inside the message observer's evaluation: that one is built to
   * find *one* message and is debounced and reconciled for staleness, none of which applies to a list.
   * Stopping removes every mark, so turning the setting off leaves nothing behind to explain.
   */
  #applyListMarks(): void {
    if (this.#stopped || !this.#settings.analysisConsent || !this.#settings.listMarksEnabled) {
      this.#listMarks.stop();
      return;
    }
    /*
     * A resolver rather than an element, because the answer changes: `document.body` when Gmail has not
     * rendered its main region yet (which at `document_idle` it often has not), and the main region
     * afterwards, which Gmail then replaces on a view change. Widening the observed subtree to the body
     * costs nothing here: a pass is debounced and bounded, and the row selectors match list rows and
     * nothing else on the page.
     */
    this.#listMarks.start(
      () => this.#adapter.observationRoot() ?? document.body,
      () => this.#adapter.accountAddress(),
    );
  }
}

/**
 * Chrome clears `runtime.id` and removes `storage` on a content script whose extension has been reloaded
 * or removed. The typings declare both always present, which is the assumption that fails here.
 */
function extensionContextAlive(): boolean {
  const api = (globalThis as { chrome?: { runtime?: { id?: string }; storage?: unknown } }).chrome;
  return api?.runtime?.id !== undefined && api.storage !== undefined;
}

/** The result is passed separately so this cannot be called before there is one to render. */
function viewOf(active: ActiveView, result: AnalysisResult, settings: Settings): PanelView {
  return {
    kind: 'result',
    result,
    aiMode: settings.aiMode,
    email: active.email,
    semantic: active.semantic,
    timing: active.timing,
    trust: trustState(
      settings.trustedSenders,
      active.email.senderEmail ?? '',
      active.email.auth,
      result.classification,
    ),
  };
}
