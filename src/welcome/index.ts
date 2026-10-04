/**
 * The welcome page's two choices: agreeing to mail being read, and whether to use AI (and if Chrome's
 * model, whether it is ready yet).
 *
 * Everything else on the page is static HTML that makes its claims in the page source. The wording is in
 * `guidance.ts`, which is pure and tested; this file is the wiring.
 */
import {
  downloadOnDeviceModel,
  onDeviceModelState,
  type ModelDownloadOutcome,
  type OnDeviceModelState,
} from '../analysis/llm/on-device.js';
import { requestSettings, sendMessage } from '../shared/messaging.js';
import { onDeviceChoice } from '../shared/on-device-choice.js';
import { isAiMode } from '../shared/settings.js';
import type { AiMode } from '../shared/types.js';
import { el, requireElement } from '../ui/dom.js';
import {
  ACTION_LABELS,
  AI_SETTINGS_URL,
  browserFamily,
  onDeviceGuidance,
  UPDATE_CHROME_URL,
  type GuidanceAction,
} from './guidance.js';

/** Client hints are not in TypeScript's DOM library yet, and are absent outside Chromium. */
interface ClientHints {
  userAgentData?: { brands?: readonly { brand: string }[] };
}
const BROWSER = browserFamily((navigator as Navigator & ClientHints).userAgentData?.brands);

/** Chrome raises no event for a download this page did not start, so one in progress is polled. */
const DOWNLOAD_POLL_MS = 5000;
/**
 * Polls without a progress event, or any change of state, before the wait is abandoned. `create()` is
 * not guaranteed to return, and without a limit a stalled request leaves the button disabled and the
 * page reading "Waiting for Chrome…" until it is reloaded. Two minutes is far past the few seconds
 * Chrome takes to report a download it has started.
 */
const SILENT_POLLS_BEFORE_GIVING_UP = 24;

class WelcomePage {
  readonly #modeInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="aiMode"]')];
  readonly #check = requireElement('local-check', HTMLDivElement);
  readonly #status = requireElement('mode-status', HTMLParagraphElement);
  readonly #localInput = this.#modeInputs.find((input) => input.value === 'local') ?? null;
  readonly #localUnavailable = requireElement('local-unavailable', HTMLSpanElement);
  readonly #consentStart = requireElement('consent-start', HTMLButtonElement);
  readonly #consentStatus = requireElement('consent-status', HTMLParagraphElement);
  #mode: AiMode = 'off';
  #poll: ReturnType<typeof setTimeout> | undefined;
  /** Progress text while this page's own download runs; the probe would only say "downloading". */
  #progress: string | null = null;
  #watch: ReturnType<typeof setInterval> | undefined;
  /** Bumped when a download wait starts or ends, so a late answer from an earlier one is ignored. */
  #tracking = 0;
  #silentPolls = 0;

  async init(): Promise<void> {
    for (const input of this.#modeInputs) {
      input.addEventListener('change', () => {
        if (input.checked && isAiMode(input.value)) void this.#choose(input.value);
      });
    }
    this.#consentStart.addEventListener('click', () => {
      void this.#consent();
    });
    // Coming back from Chrome's settings is when the answer is most likely to have changed.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.#refresh();
    });
    const settings = await requestSettings();
    this.#showConsent(settings.analysisConsent);
    this.#show(settings.aiMode);
  }

  async #consent(): Promise<void> {
    this.#consentStart.disabled = true;
    const response = await sendMessage({ type: 'SET_SETTINGS', patch: { analysisConsent: true } });
    if (response === null || !response.ok || response.type !== 'SETTINGS') {
      this.#consentStart.disabled = false;
      this.#consentStatus.textContent = 'Could not save that. Try again.';
      return;
    }
    this.#showConsent(response.settings.analysisConsent);
  }

  #showConsent(agreed: boolean): void {
    this.#consentStart.hidden = agreed;
    this.#consentStart.disabled = false;
    // Gmail tabs already open start on their own: they listen for this setting changing.
    this.#consentStatus.textContent = agreed
      ? 'ShoutPhish is checking the messages you open in Gmail. You can stop it in Settings.'
      : '';
  }

  async #choose(mode: AiMode): Promise<void> {
    const response = await sendMessage({ type: 'SET_SETTINGS', patch: { aiMode: mode } });
    if (response === null || !response.ok || response.type !== 'SETTINGS') {
      this.#status.textContent = 'Could not save that choice. Try again, or use Settings.';
      return;
    }
    this.#show(response.settings.aiMode);
  }

  #show(mode: AiMode): void {
    this.#mode = mode;
    for (const input of this.#modeInputs) input.checked = input.value === mode;
    this.#status.textContent =
      mode === 'server' || mode === 'cloud'
        ? 'A different AI option is chosen in Settings, which is where it can be changed.'
        : '';
    void this.#renderChoice(mode);
    void this.#refresh();
  }

  async #renderChoice(mode: AiMode): Promise<void> {
    const choice = onDeviceChoice(await onDeviceModelState(), mode);
    if (mode !== this.#mode) return;
    if (this.#localInput !== null) this.#localInput.disabled = !choice.selectable;
    // With `local` chosen, the check panel below already explains an unsupported browser.
    const note = mode === 'local' ? null : choice.note;
    this.#localUnavailable.textContent = note ?? '';
    this.#localUnavailable.hidden = note === null;
  }

  async #refresh(): Promise<void> {
    clearTimeout(this.#poll);
    if (this.#mode !== 'local') {
      this.#check.hidden = true;
      this.#check.replaceChildren();
      return;
    }
    if (this.#progress !== null) return;

    const state = await onDeviceModelState();
    if (!this.#probeStillWanted()) return;
    this.#render(state);
    if (state === 'downloading') {
      // Without this the panel reads identically after every poll, which looks like a page that stopped.
      this.#check.append(
        el('p', { class: 'check-note', text: `Last checked ${new Date().toLocaleTimeString()}.` }),
      );
      this.#poll = setTimeout(() => void this.#refresh(), DOWNLOAD_POLL_MS);
    }
  }

  /**
   * The reader can change their mind, or start a download, during the probe. A method rather than an
   * inline check because narrowing does not survive the `await` before it.
   */
  #probeStillWanted(): boolean {
    return this.#mode === 'local' && this.#progress === null;
  }

  #render(state: OnDeviceModelState): void {
    const guidance = onDeviceGuidance(state, BROWSER);
    const numbered = guidance.action === 'open-ai-settings' || guidance.action === 'update-chrome';
    const parts: Node[] = [el('p', { class: 'check-headline', text: guidance.headline })];
    if (guidance.steps.length > 0) {
      parts.push(el(numbered ? 'ol' : 'ul', { children: guidance.steps.map((step) => el('li', { text: step })) }));
    }
    if (this.#progress !== null) parts.push(el('p', { class: 'check-progress', text: this.#progress }));
    if (guidance.action !== undefined) parts.push(this.#button(guidance.action));
    if (guidance.note !== undefined) parts.push(el('p', { class: 'check-note', text: guidance.note }));

    this.#check.hidden = false;
    this.#check.dataset['tone'] = guidance.tone;
    this.#check.replaceChildren(...parts);
  }

  #button(action: GuidanceAction): HTMLButtonElement {
    const onClick = (): void => {
      if (action === 'download') void this.#download('downloadable');
      else if (action === 'track-download') void this.#download('downloading');
      else void openBrowserPage(action === 'open-ai-settings' ? AI_SETTINGS_URL : UPDATE_CHROME_URL);
    };
    return el('button', {
      class: 'button',
      text: ACTION_LABELS[action],
      attrs: { type: 'button', disabled: this.#progress !== null },
      on: { click: onClick },
    });
  }

  /**
   * Creating a session is what downloads the model, or joins a download already running.
   *
   * Progress reaching 100% is not the end: Chrome still unpacks and loads the model before `create()`
   * returns, and nothing guarantees it returns at all. So availability is re-checked alongside, and
   * whichever reports readiness first ends the wait; `#tracking` makes the slower one a no-op.
   */
  async #download(state: 'downloadable' | 'downloading'): Promise<void> {
    clearTimeout(this.#poll);
    const run = ++this.#tracking;
    this.#status.textContent = '';
    this.#progress = 'Waiting for the browser to report progress…';
    this.#silentPolls = 0;
    this.#render(state);
    this.#watch = setInterval(() => void this.#watchDownload(run, state), DOWNLOAD_POLL_MS);

    const outcome = await downloadOnDeviceModel((fraction) => {
      if (run !== this.#tracking) return;
      this.#silentPolls = 0;
      this.#progress =
        fraction >= 1
          ? 'Downloaded. The browser is now unpacking and loading the model, which can take a few minutes.'
          : `Downloading… ${String(Math.round(Math.max(0, fraction) * 100))}%`;
      if (this.#mode === 'local') this.#render(state);
    });
    if (run === this.#tracking) this.#endDownload(outcome);
  }

  async #watchDownload(run: number, started: OnDeviceModelState): Promise<void> {
    const state = await onDeviceModelState();
    if (run !== this.#tracking) return;
    if (state === 'available') this.#endDownload({ ok: true });
    else if (state === 'unavailable' || state === 'unsupported') {
      this.#endDownload({ ok: false, reason: state === 'unsupported' ? 'unsupported' : 'unavailable' });
    } else if (state === started && ++this.#silentPolls >= SILENT_POLLS_BEFORE_GIVING_UP) {
      this.#endDownload({ ok: false, reason: 'failed' });
    } else if (state !== started) {
      this.#silentPolls = 0;
    }
  }

  #endDownload(outcome: ModelDownloadOutcome): void {
    this.#tracking += 1;
    clearInterval(this.#watch);
    this.#progress = null;
    if (!outcome.ok) {
      this.#status.textContent =
        outcome.reason === 'unavailable'
          ? // Chrome reports a switched-off setting, a policy block and an ineligible device alike.
            'The browser says its model cannot run right now. The setting may be off, blocked by policy, or this device may not qualify; see below.'
          : 'The browser did not start the download. Check the requirements below, then try again.';
    }
    void this.#refresh();
  }
}

/** `chrome://` pages cannot be opened by a link from an extension page, only by the tabs API. */
async function openBrowserPage(url: string): Promise<void> {
  try {
    await chrome.tabs.create({ url });
  } catch {
    // Nothing better to offer than the address itself, which the steps already spell out.
  }
}

void new WelcomePage().init();
