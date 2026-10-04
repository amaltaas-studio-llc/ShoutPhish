/**
 * Options page.
 *
 * Reads and writes settings through the service worker rather than touching `chrome.storage` directly,
 * so validation (`normalizeSettings`, `normalizeBackendUrl`) happens in exactly one place. The content
 * script picks changes up via `chrome.storage.onChanged`; there is no reload needed and no separate
 * "apply" step.
 *
 * The page's markup is static and ships with the extension, so it is written in `options.html`. Nothing
 * here interpolates message-derived content; the user-supplied strings (the backend URL, the model
 * server address and the model name) are set via `value`, and model names returned by a server become
 * `option.value`, never markup.
 *
 * It is also where the one optional permission is requested. Access to a model server is asked for
 * per-address, on a click, and handed back when the address changes, so a default install keeps the two
 * permissions the README advertises.
 */
import { onDeviceModelState, type OnDeviceModelState } from '../analysis/llm/on-device.js';
import { egressPermissions } from '../shared/egress-permissions.js';
import { onDeviceChoice } from '../shared/on-device-choice.js';
import { logger } from '../shared/logger.js';
import { requestSettings, sendMessage } from '../shared/messaging.js';
import {
  DEFAULT_SETTINGS,
  isAiMode,
  isRemoteAddress,
  normalizeBackendUrl,
  normalizeModelBaseUrl,
  originPattern,
} from '../shared/settings.js';
import { BUILD_TARGET } from '../shared/target.js';
import { withoutTrustedSender } from '../shared/trust.js';
import type { AiMode, Settings } from '../shared/types.js';
import { el, requireElement } from '../ui/dom.js';

declare const __SHOUTPHISH_VERSION__: string;

const STATUS_MS = 1600;

class OptionsPage {
  readonly #modeInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="aiMode"]')];
  readonly #cloudOption = requireElement('cloudOption', HTMLLabelElement);
  readonly #backendField = requireElement('backendField', HTMLDivElement);
  readonly #backendInput = requireElement('backendBaseUrl', HTMLInputElement);
  readonly #backendError = requireElement('backendError', HTMLParagraphElement);
  readonly #serverField = requireElement('serverField', HTMLDivElement);
  readonly #modelBaseUrl = requireElement('modelBaseUrl', HTMLInputElement);
  readonly #modelName = requireElement('modelName', HTMLInputElement);
  readonly #modelList = requireElement('modelList', HTMLDataListElement);
  readonly #connect = requireElement('connect', HTMLButtonElement);
  readonly #serverError = requireElement('serverError', HTMLParagraphElement);
  readonly #serverRemoteWarning = requireElement('serverRemoteWarning', HTMLParagraphElement);
  readonly #trusted = requireElement('trusted', HTMLUListElement);
  readonly #trustedEmpty = requireElement('trustedEmpty', HTMLParagraphElement);
  readonly #aiOnlyWhenFlaggedOption = requireElement('aiOnlyWhenFlaggedOption', HTMLLabelElement);
  readonly #aiOnlyWhenFlagged = requireElement('aiOnlyWhenFlagged', HTMLInputElement);
  readonly #analysisConsent = requireElement('analysisConsent', HTMLInputElement);
  readonly #showBadgeWhenLow = requireElement('showBadgeWhenLow', HTMLInputElement);
  readonly #listMarksEnabled = requireElement('listMarksEnabled', HTMLInputElement);
  readonly #highlightEnabled = requireElement('highlightEnabled', HTMLInputElement);
  readonly #status = requireElement('status', HTMLDivElement);
  readonly #version = requireElement('version', HTMLSpanElement);
  readonly #localInput = this.#modeInputs.find((input) => input.value === 'local') ?? null;
  readonly #localRecommended = requireElement('localRecommended', HTMLSpanElement);
  readonly #localUnavailable = requireElement('localUnavailable', HTMLSpanElement);
  /** `null` until probed, so the option stays as authored rather than flickering to disabled and back. */
  #onDeviceState: OnDeviceModelState | null = null;

  #statusTimer: ReturnType<typeof setTimeout> | null = null;
  /** Kept so a changed address hands back the access granted to the previous one. */
  #grantedPattern: string | null = null;
  /** Last rendered settings, so the granted-access state can be repainted without re-reading them. */
  #current: Settings = { ...DEFAULT_SETTINGS };

  async init(): Promise<void> {
    this.#version.textContent = `Version ${typeof __SHOUTPHISH_VERSION__ === 'undefined' ? 'dev' : __SHOUTPHISH_VERSION__}`;

    const [settings, onDeviceState] = await Promise.all([requestSettings(), onDeviceModelState()]);
    this.#onDeviceState = onDeviceState;
    // Access is checked before the first paint, since whether it is held is part of what the page has to
    // report: a configured address without a grant looks finished and silently fails.
    await this.#syncGrantedPattern(settings);
    this.#render(settings);

    for (const input of this.#modeInputs) {
      input.addEventListener('change', () => {
        if (!input.checked || !isAiMode(input.value)) return;
        void this.#save({ aiMode: input.value });
      });
    }

    const toggles = [
      [this.#analysisConsent, 'analysisConsent'],
      [this.#aiOnlyWhenFlagged, 'aiOnlyWhenFlagged'],
      [this.#showBadgeWhenLow, 'showBadgeWhenLow'],
      [this.#listMarksEnabled, 'listMarksEnabled'],
      [this.#highlightEnabled, 'highlightEnabled'],
    ] as const;
    for (const [input, key] of toggles) {
      input.addEventListener('change', () => {
        void this.#save({ [key]: input.checked });
      });
    }

    // Committed on blur/Enter rather than per keystroke: a partially-typed URL is not a valid one, and
    // `normalizeBackendUrl` would reject it and silently discard what was typed so far.
    this.#backendInput.addEventListener('change', () => {
      void this.#saveBackendUrl();
    });

    this.#modelBaseUrl.addEventListener('change', () => {
      void this.#saveModelBaseUrl();
    });

    this.#modelName.addEventListener('change', () => {
      void this.#save({ modelName: this.#modelName.value.trim() });
    });

    // Access to the server is requested here rather than when the URL is saved, because
    // `chrome.permissions.request` needs a real user gesture, and because a permission prompt that
    // appears while someone is still typing reads as the extension overstepping.
    this.#connect.addEventListener('click', () => {
      void this.#connectToServer();
    });
  }

  #render(settings: Settings): void {
    this.#current = settings;
    for (const input of this.#modeInputs) input.checked = input.value === settings.aiMode;
    /*
     * The cloud option is shown only to someone who already has it selected. Hiding it outright would
     * leave such a reader looking at a page where no mode is checked and no explanation of why, which is
     * worse than the mode being visible; hiding it from everyone else stops a mode that cannot answer
     * from being chosen and blamed on the AI section.
     */
    this.#cloudOption.hidden = settings.aiMode !== 'cloud';
    this.#backendField.hidden = settings.aiMode !== 'cloud';
    this.#backendInput.value = settings.backendBaseUrl;
    this.#serverField.hidden = settings.aiMode !== 'server';
    this.#modelBaseUrl.value = settings.modelBaseUrl;
    this.#modelName.value = settings.modelName;
    // Hidden rather than disabled when AI is off: a greyed-out choice about a model that never runs
    // invites the question of why it cannot be changed.
    this.#aiOnlyWhenFlaggedOption.hidden = settings.aiMode === 'off';
    this.#aiOnlyWhenFlagged.checked = settings.aiOnlyWhenFlagged;
    this.#analysisConsent.checked = settings.analysisConsent;
    this.#showBadgeWhenLow.checked = settings.showBadgeWhenLow;
    this.#listMarksEnabled.checked = settings.listMarksEnabled;
    this.#highlightEnabled.checked = settings.highlightEnabled;
    this.#backendError.textContent =
      settings.aiMode === 'cloud' && settings.backendBaseUrl === ''
        ? 'Cloud analysis stays inactive until a valid https:// URL is set.'
        : '';
    this.#renderServerState(settings);
    this.#renderTrusted(settings.trustedSenders);
    this.#renderOnDevice(settings.aiMode);
  }

  #renderOnDevice(mode: AiMode): void {
    if (this.#onDeviceState === null) return;
    const choice = onDeviceChoice(this.#onDeviceState, mode);
    if (this.#localInput !== null) this.#localInput.disabled = !choice.selectable;
    this.#localRecommended.hidden = !choice.selectable;
    this.#localUnavailable.textContent = choice.note ?? '';
    this.#localUnavailable.hidden = choice.note === null;
  }

  /**
   * The trust list, in full, with a way out of every entry.
   *
   * The card can only offer to stop trusting the sender of the message on screen, which is no help to
   * someone who wants to know what they have accumulated, and an allowlist a user cannot enumerate is
   * one they cannot audit. Entries are `textContent`, like everything else derived from a message.
   */
  #renderTrusted(entries: readonly string[]): void {
    this.#trustedEmpty.hidden = entries.length > 0;
    this.#trusted.replaceChildren(
      ...entries.map((entry) =>
        el('li', {
          children: [
            el('code', { text: entry }),
            el('button', {
              text: 'Stop trusting',
              attrs: { type: 'button' },
              on: {
                click: () => {
                  void this.#save({
                    trustedSenders: withoutTrustedSender(this.#current.trustedSenders, entry),
                  });
                },
              },
            }),
          ],
        }),
      ),
    );
  }

  #renderServerState(settings: Settings): void {
    this.#serverRemoteWarning.hidden = !isRemoteAddress(settings.modelBaseUrl);
    this.#connect.disabled = settings.modelBaseUrl === '';

    if (settings.aiMode !== 'server') {
      this.#serverError.textContent = '';
      return;
    }

    const granted =
      settings.modelBaseUrl !== '' &&
      this.#grantedPattern === originPattern(settings.modelBaseUrl, BUILD_TARGET);

    this.#serverError.textContent =
      settings.modelBaseUrl === ''
        ? 'Set the server address, then choose a model. Until both are set, analysis runs without a model.'
        : !granted
          ? // Both fields can be filled in by hand, which looks complete and fails on every request:
            // the worker refuses to contact an address the user has not granted. Chrome alone would
            // not stop it: an ungranted request still leaves, as an ordinary cross-origin one.
            'Press Connect to allow ShoutPhish to reach this address. Until then, nothing is sent to it.'
          : settings.modelName === ''
            ? 'Choose a model. Press Connect to list what this server has loaded.'
            : '';
  }

  async #saveBackendUrl(): Promise<void> {
    const raw = this.#backendInput.value.trim();
    const normalized = normalizeBackendUrl(raw);

    if (raw !== '' && normalized === '') {
      this.#backendError.textContent = 'Enter a full https:// URL, for example https://shoutphish.example.com';
      return;
    }
    await this.#save({ backendBaseUrl: normalized });
  }

  async #saveModelBaseUrl(): Promise<void> {
    const raw = this.#modelBaseUrl.value.trim();
    const normalized = normalizeModelBaseUrl(raw);

    if (raw !== '' && normalized === '') {
      this.#serverError.textContent = isRemoteAddress(raw)
        ? 'Use https:// for a server that is not on this machine. Plain http:// is only accepted for localhost.'
        : 'Enter the full base URL including the scheme, for example http://localhost:11434/v1';
      return;
    }

    // Access granted to an address that is no longer configured is access nobody asked for.
    const next = originPattern(normalized, BUILD_TARGET);
    if (this.#grantedPattern !== null && this.#grantedPattern !== next) {
      await revokeOrigin(this.#grantedPattern);
      this.#grantedPattern = null;
    }

    this.#modelList.replaceChildren();
    await this.#save({ modelBaseUrl: normalized });
  }

  /**
   * Requests access to the configured address, then asks the server what it has loaded. Doing both
   * behind one button means a single click takes the user from an address to a working configuration,
   * and that a failure has one obvious place to report itself.
   */
  async #connectToServer(): Promise<void> {
    const pattern = originPattern(normalizeModelBaseUrl(this.#modelBaseUrl.value.trim()), BUILD_TARGET);
    if (pattern === null) {
      this.#serverError.textContent = 'Set a valid server address first.';
      return;
    }

    this.#connect.disabled = true;
    try {
      // A browser rejects, rather than returning false, for a pattern it will not grant, and its reason
      // is shown as given: without it the button would appear to do nothing at all, which is the worst
      // way for a permission step to fail, and any explanation written here would be a guess about
      // which of several rules a given browser applied. On Firefox this one prompt also asks to send
      // message text outside the browser; see `egressPermissions`.
      const granted = await chrome.permissions
        .request(egressPermissions(pattern, BUILD_TARGET))
        .catch((error: unknown) => {
          logger.debug('permission request rejected', error);
          return error instanceof Error ? error.message : String(error);
        });

      if (typeof granted === 'string') {
        this.#serverError.textContent = `The browser refused to grant access to ${pattern}: ${granted}`;
        return;
      }
      if (!granted) {
        this.#serverError.textContent =
          'Access was declined, so ShoutPhish will not send anything to the server.';
        return;
      }
      this.#grantedPattern = pattern;

      const response = await sendMessage({ type: 'LIST_MODELS' });
      if (response === null || !response.ok || response.type !== 'MODELS') {
        const reason = response !== null && !response.ok ? response.error : 'no response';
        // The worker's message already names the likely cause and the setting that fixes it, so this adds
        // no advice of its own: two overlapping explanations of the same failure read as neither being sure.
        this.#serverError.textContent = `Could not connect: ${reason.endsWith('.') ? reason : `${reason}.`}`;
        return;
      }

      this.#modelList.replaceChildren(
        ...response.models.map((model) => el('option', { attrs: { value: model } })),
      );

      if (response.models.length === 0) {
        this.#serverError.textContent =
          'Connected, but the server reports no models. Pull or load one, then press Connect again.';
        return;
      }

      // One model is the common case, and asking someone to choose from a list of one is busywork.
      const only = response.models[0];
      if (this.#modelName.value.trim() === '' && response.models.length === 1 && only !== undefined) {
        await this.#save({ modelName: only });
      }
      this.#renderServerState(this.#current);
      this.#showStatus(`Connected: ${String(response.models.length)} model(s) available`);
    } finally {
      this.#connect.disabled = this.#modelBaseUrl.value.trim() === '';
    }
  }

  async #save(patch: Partial<Settings>): Promise<void> {
    const response = await sendMessage({ type: 'SET_SETTINGS', patch });
    if (response === null || !response.ok || response.type !== 'SETTINGS') {
      this.#showStatus('Could not save. Try again.');
      return;
    }
    this.#render(response.settings);
    this.#showStatus('Saved');
  }

  /** Reflects access that is already held, so a returning user is not asked for it twice. */
  async #syncGrantedPattern(settings: Settings): Promise<void> {
    const pattern = originPattern(settings.modelBaseUrl, BUILD_TARGET);
    if (pattern === null) return;
    try {
      const held = await chrome.permissions.contains(egressPermissions(pattern, BUILD_TARGET));
      if (held) this.#grantedPattern = pattern;
    } catch {
      // An unsupported or rejected query is not worth surfacing: Connect will ask again.
    }
  }

  #showStatus(text: string): void {
    this.#status.textContent = text;
    this.#status.dataset['visible'] = 'true';
    if (this.#statusTimer !== null) clearTimeout(this.#statusTimer);
    this.#statusTimer = setTimeout(() => {
      this.#status.dataset['visible'] = 'false';
    }, STATUS_MS);
  }
}

async function revokeOrigin(pattern: string): Promise<void> {
  try {
    await chrome.permissions.remove(egressPermissions(pattern, BUILD_TARGET));
  } catch {
    // A browser refuses to remove a permission it did not grant, which is the harmless case.
  }
}

void new OptionsPage().init();
