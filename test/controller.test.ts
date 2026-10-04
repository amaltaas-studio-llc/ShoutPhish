/**
 * @vitest-environment jsdom
 *
 * The content script's orchestration, driven the way Gmail and Chrome drive it.
 *
 * Everything here is about *timing*, which is why it needs the real Controller rather than a test of one
 * of its parts: the observer, the model round trip and a settings write all arrive asynchronously and out
 * of order, and every failure in that space is silent. A verdict from work nobody wanted any more is
 * indistinguishable, on screen, from a verdict that is correct.
 *
 * The model runs through `aiMode: 'server'`, whose round trip is a message to the service worker. That
 * makes the inference a promise this file resolves by hand, which is the whole point, since the failure being
 * asserted lives in the window between asking a model something and no longer wanting the answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Controller } from '../src/content/controller.js';
import type { Extraction, MailAdapter, MessageHandle } from '../src/gmail/adapter.js';
import type { ExtensionRequest, TabResponse, TabStatus } from '../src/shared/messaging.js';
import { DEFAULT_SETTINGS } from '../src/shared/settings.js';
import type { EmailMessage, SemanticAnalysis, Settings } from '../src/shared/types.js';

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

const THREAD_HASH = '#inbox/FMfcgzQhWLMhlXGCZNdTpfpfWQXRPjNz';

const EMAIL: EmailMessage = {
  senderName: 'Northwind Logistics',
  senderEmail: 'notifications@northwind-logistics.com',
  recipientEmail: 'reader@northwind-logistics.com',
  subject: 'Your delivery is scheduled',
  bodyText: 'Your consignment leaves the depot on Tuesday morning.',
  links: [],
  attachments: [],
};

/** A message-shaped tree, because the badge attaches to a real element and the card reads a real body. */
function drawMessage(): { root: Element; header: Element; body: Element } {
  const root = document.createElement('div');
  root.setAttribute('data-message-id', 'msg-18f2a0c');
  const header = document.createElement('div');
  const body = document.createElement('div');
  body.append(document.createTextNode(EMAIL.bodyText));
  root.append(header, body);
  document.body.append(root);
  return { root, header, body };
}

class FakeAdapter implements MailAdapter {
  readonly id = 'fake';
  #tree = drawMessage();

  /**
   * Gmail redrawing the message header from the same data, which is routine and which takes the injected
   * badge with it. Everything the extraction reads is unchanged, so nothing in the message says so.
   */
  replaceHeader(): void {
    const header = document.createElement('div');
    this.#tree.root.replaceChild(header, this.#tree.header);
    this.#tree = { ...this.#tree, header };
  }

  observationRoot(): Element | null {
    return document.body;
  }

  accountAddress(): string {
    return EMAIL.recipientEmail ?? '';
  }

  routeThreadId(): string {
    const segments = window.location.hash.replace(/^#/u, '').split('/');
    const last = segments[segments.length - 1] ?? '';
    return /^[A-Za-z0-9_-]{16,}$/u.test(last) ? last : '';
  }

  currentMessage(): MessageHandle | null {
    if (this.routeThreadId() === '') return null;
    return {
      messageId: 'msg-18f2a0c',
      threadId: 'thread-f:1798',
      priorSenders: [],
      headerElement: this.#tree.header,
      bodyElement: this.#tree.body,
      root: this.#tree.root,
    };
  }

  /** What `extract()` returns. Replaced by a test to stand in for Gmail finishing part of the page. */
  email: EmailMessage = EMAIL;

  extract(): Extraction {
    return { email: this.email, missing: [] };
  }
}

/**
 * The same message with a finding: a sign-in link whose text names one host and whose destination is
 * another. Enough for the gate to ask the model, and nothing the tests below depend on beyond that.
 */
const FLAGGED: EmailMessage = {
  ...EMAIL,
  bodyText: `${EMAIL.bodyText} Confirm your delivery address.`,
  links: [
    {
      text: 'https://northwind-logistics.com/confirm',
      href: 'https://northwind-logistics-confirm.example/login',
      normalizedDomain: 'northwind-logistics-confirm.example',
    },
  ],
};

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

interface PendingInference {
  resolve: (analysis: SemanticAnalysis | null) => void;
}

let stored: Settings;
let delayedSettings: (() => Promise<unknown>) | null = null;
let inferences: PendingInference[];
let storageListeners: ((changes: Record<string, unknown>, area: string) => void)[];
let tabListeners: ((
  message: unknown,
  sender: chrome.runtime.MessageSender,
  respond: (response: TabResponse) => void,
) => boolean)[];

/**
 * The message above is clean, which the default gate would answer without asking the model. These tests
 * are about the model round trip, so the gate is off unless a test is about the gate.
 */
function settings(over: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    analysisConsent: true,
    aiMode: 'server',
    aiOnlyWhenFlagged: false,
    modelBaseUrl: 'http://127.0.0.1:11434/v1',
    modelName: 'northwind-small',
    ...over,
  };
}

function semantic(over: Partial<SemanticAnalysis> = {}): SemanticAnalysis {
  return {
    risk: 40,
    categories: ['unusual_request'],
    reasons: ['The message asks for an unusual action.'],
    confidence: 0.6,
    source: 'server',
    ...over,
  };
}

function installChrome(): void {
  const runtime = {
    id: 'shoutphish-test',
    onMessage: {
      addListener: (listener: (typeof tabListeners)[number]) => {
        tabListeners.push(listener);
      },
      removeListener: () => undefined,
    },
    sendMessage: (request: ExtensionRequest): Promise<unknown> => {
      if (request.type === 'GET_SETTINGS') {
        if (delayedSettings !== null) return delayedSettings();
        return Promise.resolve({ ok: true, type: 'SETTINGS', settings: stored });
      }
      if (request.type === 'MODEL_SERVER_ANALYZE') {
        return new Promise((resolve) => {
          inferences.push({
            resolve: (analysis) => {
              resolve({ ok: true, type: 'SEMANTIC', analysis });
            },
          });
        });
      }
      return Promise.resolve(null);
    },
  };

  Object.defineProperty(globalThis, 'chrome', {
    value: {
      runtime,
      storage: {
        onChanged: {
          addListener: (listener: (typeof storageListeners)[number]) => {
            storageListeners.push(listener);
          },
          removeListener: () => undefined,
        },
      },
    },
    configurable: true,
    writable: true,
  });
}

/** What Chrome does when the options page writes a setting. */
function writeSettings(next: Settings): void {
  stored = next;
  for (const listener of storageListeners) listener({}, 'sync');
}

/** What the toolbar popup asks, through the listener the controller registers for it. */
function tabStatus(): TabStatus | null {
  const answers: TabResponse[] = [];
  for (const listener of tabListeners) {
    listener({ type: 'GET_TAB_STATUS' }, { id: 'shoutphish-test' }, (response) => {
      answers.push(response);
    });
  }
  const answer = answers[0];
  if (answer === undefined || !answer.ok || answer.type !== 'TAB_STATUS') return null;
  return answer.status;
}

/** Lets every queued promise settle without advancing the clock. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

// ---------------------------------------------------------------------------

let controller: Controller;
let adapter: FakeAdapter;

function badgeIsOnScreen(): boolean {
  return document.querySelector('#shoutphish-badge-host') !== null;
}

beforeEach(async () => {
  vi.useFakeTimers();
  document.body.replaceChildren();
  window.location.hash = THREAD_HASH;
  stored = settings();
  inferences = [];
  storageListeners = [];
  tabListeners = [];
  installChrome();

  adapter = new FakeAdapter();
  controller = new Controller(adapter);
  await controller.start();
  // The observer's debounce, then the deterministic pass, then the model being asked.
  await vi.advanceTimersByTimeAsync(500);
  await flush();
});

afterEach(() => {
  controller.stop();
  vi.useRealTimers();
});

describe('a message opened with a model configured', () => {
  it('shows the deterministic verdict and asks the model once', () => {
    expect(inferences).toHaveLength(1);
    expect(tabStatus()).toMatchObject({ kind: 'scored', semantic: 'pending' });
  });

  it('applies the model’s answer when it arrives', async () => {
    inferences[0]?.resolve(semantic());
    await flush();

    expect(tabStatus()).toMatchObject({ kind: 'scored', semantic: 'ready' });
  });

  /**
   * A header Gmail has redrawn from the same data takes the badge with it, and says nothing about it: every
   * byte the extraction reads is identical, so the view signature matches. Suppressing the event that would
   * put the badge back as redundant leaves the message with no badge for the rest of its time on screen,
   * and on a `showBadgeWhenLow: false` install, no badge is also what a clean message looks like.
   *
   * The model answer must be reused while the checks are recomputed. Redrawing a header is not new
   * evidence, and a round trip per redraw would be one per scroll on a slow connection.
   */
  it('puts the badge back when Gmail redraws the header, without asking the model again', async () => {
    inferences[0]?.resolve(semantic());
    await flush();
    expect(badgeIsOnScreen()).toBe(true);

    adapter.replaceHeader();
    expect(badgeIsOnScreen()).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    await flush();

    expect(badgeIsOnScreen()).toBe(true);
    expect(inferences).toHaveLength(1);
    expect(tabStatus()).toMatchObject({ kind: 'scored', semantic: 'ready' });
  });
});

/**
 * Until the reader agrees on the welcome page, the content script is present in Gmail and reads none of
 * it. Agreement and withdrawal both arrive as a settings write, and an open tab has to follow either
 * without being reloaded, or the button that says "start" would appear not to work.
 */
describe('before the reader has agreed to their mail being read', () => {
  async function startWithout(): Promise<void> {
    controller.stop();
    document.body.replaceChildren();
    inferences = [];
    // The stub's `removeListener` is a no-op, so the stopped controller would otherwise still answer.
    storageListeners = [];
    tabListeners = [];
    stored = settings({ analysisConsent: false });
    adapter = new FakeAdapter();
    controller = new Controller(adapter);
    await controller.start();
    await vi.advanceTimersByTimeAsync(500);
    await flush();
  }

  it('reads nothing, shows nothing and asks no model', async () => {
    await startWithout();

    expect(badgeIsOnScreen()).toBe(false);
    expect(inferences).toHaveLength(0);
    expect(tabStatus()).toEqual({ kind: 'no-message' });
  });

  it('starts checking an open tab as soon as consent is given', async () => {
    await startWithout();

    writeSettings(settings({ analysisConsent: true }));
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    expect(badgeIsOnScreen()).toBe(true);
    expect(inferences).toHaveLength(1);
    expect(tabStatus()).toMatchObject({ kind: 'scored' });
  });

  it('removes everything it showed, and stops reading, when consent is withdrawn', async () => {
    expect(badgeIsOnScreen()).toBe(true);

    writeSettings(settings({ analysisConsent: false }));
    await flush();
    expect(badgeIsOnScreen()).toBe(false);
    expect(tabStatus()).toEqual({ kind: 'no-message' });

    // Gmail keeps redrawing; a stopped reader must not pick the message back up.
    adapter.replaceHeader();
    document.body.append(document.createElement('div'));
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(badgeIsOnScreen()).toBe(false);
    expect(inferences).toHaveLength(1);
  });
});

/** Gmail finishing part of the message after the first pass: a new view of the same text. */
async function gmailFinishes(email: EmailMessage): Promise<void> {
  adapter.email = email;
  document.body.append(document.createElement('div'));
  await vi.advanceTimersByTimeAsync(500);
  await flush();
}

const AUTHENTICATED: EmailMessage = {
  ...EMAIL,
  auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass', signedBy: 'northwind-logistics.com' },
};

/**
 * Gmail draws the authentication summary a moment after the body, and each part it finishes is a new view
 * of the message. The model is never shown authentication, so its reading of the new view is the one
 * already under way, and restarting it would cost the on-device model its whole inference, on nearly
 * every message, for a question whose text has not changed.
 */
describe('when Gmail finishes drawing a message the model is already reading', () => {
  it('joins the reading in flight instead of asking again', async () => {
    await gmailFinishes(AUTHENTICATED);
    expect(inferences).toHaveLength(1);

    inferences[0]?.resolve(semantic());
    await flush();
    expect(tabStatus()).toMatchObject({ kind: 'scored', semantic: 'ready' });
  });

  it('reuses a finished reading for a later view of the same text', async () => {
    inferences[0]?.resolve(semantic());
    await flush();

    await gmailFinishes(AUTHENTICATED);
    expect(inferences).toHaveLength(1);
    expect(tabStatus()).toMatchObject({ semantic: 'ready' });
  });

  it('asks again when the text the model reads has changed', async () => {
    await gmailFinishes({ ...EMAIL, bodyText: `${EMAIL.bodyText} Reply to confirm.` });
    expect(inferences).toHaveLength(2);
  });
});

/** What the popup's "copy a report" button pastes. */
function healthReport(): string {
  let report = '';
  for (const listener of tabListeners) {
    listener({ type: 'GET_HEALTH_REPORT' }, { id: 'shoutphish-test' }, (response) => {
      if (response.ok && response.type === 'HEALTH_REPORT') report = response.report;
    });
  }
  return report;
}

describe('timing', () => {
  it('reports how long the checks and the model took, in durations only', async () => {
    expect(healthReport()).toMatch(/^timing: {6}checks \d+ms$/mu);

    inferences[0]?.resolve(semantic());
    await flush();
    expect(healthReport()).toMatch(/^timing: {6}checks \d+ms, ai \d+ms$/mu);
  });
});

/**
 * The default gate: the model is asked only when a check found something, because on mail no check
 * objects to its reading scores zero by construction. What must hold is that skipping is never presented
 * as the model having looked, and that the reader can still ask.
 */
describe('with the default gate on asking the model', () => {
  async function restart(email: EmailMessage): Promise<void> {
    controller.stop();
    document.body.replaceChildren();
    stored = settings({ aiOnlyWhenFlagged: true });
    inferences = [];
    storageListeners = [];
    tabListeners = [];
    adapter = new FakeAdapter();
    adapter.email = email;
    controller = new Controller(adapter);
    await controller.start();
    await vi.advanceTimersByTimeAsync(500);
    await flush();
  }

  function askButton(): HTMLButtonElement | null {
    for (const listener of tabListeners) {
      listener({ type: 'OPEN_PANEL' }, { id: 'shoutphish-test' }, () => undefined);
    }
    const root = document.querySelector('#shoutphish-panel-host')?.shadowRoot ?? null;
    return root?.querySelector<HTMLButtonElement>('button.action') ?? null;
  }

  it('does not ask about a message no check found anything in', async () => {
    await restart(EMAIL);
    expect(inferences).toHaveLength(0);
    expect(tabStatus()).toMatchObject({ kind: 'scored', semantic: 'skipped' });
  });

  it('asks about a message a check flagged', async () => {
    await restart(FLAGGED);
    expect(inferences).toHaveLength(1);
    expect(tabStatus()).toMatchObject({ semantic: 'pending' });
  });

  it('asks when the reader requests a reading from the card', async () => {
    await restart(EMAIL);
    const button = askButton();
    expect(button).not.toBeNull();

    button?.click();
    await flush();
    expect(inferences).toHaveLength(1);
    expect(tabStatus()).toMatchObject({ semantic: 'pending' });

    inferences[0]?.resolve(semantic());
    await flush();
    expect(tabStatus()).toMatchObject({ semantic: 'ready' });
  });

  it.each(['header', 'evidence'])('keeps a requested reading pending across %s changes', async (change) => {
    await restart(EMAIL);
    askButton()?.click();
    await flush();
    if (change === 'header') {
      adapter.replaceHeader();
      await vi.advanceTimersByTimeAsync(500);
    } else {
      await gmailFinishes(AUTHENTICATED);
    }
    expect(tabStatus()).toMatchObject({ semantic: 'pending' });
    expect(inferences).toHaveLength(1);
    inferences[0]?.resolve(semantic());
    await flush();
    expect(tabStatus()).toMatchObject({ semantic: 'ready' });
  });

  it('reuses a requested answer after technical evidence changes', async () => {
    await restart(EMAIL);
    askButton()?.click();
    await flush();
    inferences[0]?.resolve(semantic());
    await flush();
    await gmailFinishes(AUTHENTICATED);
    expect(tabStatus()).toMatchObject({ semantic: 'ready' });
    expect(inferences).toHaveLength(1);
  });

  it('keeps the requested reading for the next visit', async () => {
    await restart(EMAIL);
    askButton()?.click();
    await flush();
    inferences[0]?.resolve(semantic());
    await flush();

    adapter.replaceHeader();
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(tabStatus()).toMatchObject({ semantic: 'ready' });
    expect(inferences).toHaveLength(1);
  });
});

/**
 * `pagehide` can arrive while the controller is waiting on the service worker, and nothing after that
 * `await` may run as though it had not: listeners registered after `stop()` removed them would outlive the
 * page, and a settings reload would rebuild the list observer on a page that has been torn down.
 */
describe('when the page is hidden while work is in flight', () => {
  /** A list row worth marking, so a list observer that should not exist leaves something to see. */
  function drawListRow(): void {
    const parsed = new DOMParser().parseFromString(
      `<!doctype html><html><body><table><tr class="zA" id="row-0">
        <td class="yW"><span email="security@paypa1-alerts.example" name="PayPal Security">PayPal Security</span></td>
        <td class="xY"><div class="y6"><span>A subject</span></div></td>
      </tr></table></body></html>`,
      'text/html',
    );
    document.body.append(...parsed.body.childNodes);
  }

  it('does not finish starting after it has been stopped', async () => {
    controller.stop();
    storageListeners = [];
    tabListeners = [];
    inferences = [];
    document.body.replaceChildren();

    const late = new Controller(new FakeAdapter());
    const starting = late.start();
    late.stop();
    await starting;
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    expect(storageListeners).toHaveLength(0);
    expect(tabListeners).toHaveLength(0);
    expect(badgeIsOnScreen()).toBe(false);
    expect(inferences).toHaveLength(0);
  });

  it('does not apply a settings reload that lands after it has been stopped', async () => {
    drawListRow();
    writeSettings(settings({ listMarksEnabled: true }));
    controller.stop();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();

    expect(document.querySelector('.shoutphish-row-mark')).toBeNull();
  });

  /** The control for the test above: the same write, without the stop, does mark the row. */
  it('applies the same reload when it has not been stopped', async () => {
    drawListRow();
    writeSettings(settings({ listMarksEnabled: true }));
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();

    expect(document.querySelector('.shoutphish-row-mark')).not.toBeNull();
  });
});

/**
 * After the extension is reloaded, a Gmail tab keeps the old script with Chrome's APIs cut away, and
 * `pagehide` still reaches it. A throw there is uncaught and lands on the extension's error page.
 */
describe('when the extension has been reloaded under an open tab', () => {
  function orphan(): void {
    Object.defineProperty(globalThis, 'chrome', {
      value: { runtime: { sendMessage: () => Promise.reject(new Error('context invalidated')) } },
      configurable: true,
      writable: true,
    });
  }

  it('stops without throwing', () => {
    orphan();
    expect(() => {
      controller.stop();
    }).not.toThrow();
  });

  it('stays inert when started', async () => {
    controller.stop();
    document.body.replaceChildren();
    orphan();

    const orphaned = new Controller(new FakeAdapter());
    await expect(orphaned.start()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    expect(badgeIsOnScreen()).toBe(false);
    expect(() => {
      orphaned.stop();
    }).not.toThrow();
  });
});

/**
 * An inference already in flight belongs to the settings that have just been replaced. Its late answer
 * must neither repaint the view nor be kept as the new model's reading.
 */
describe('when a settings change supersedes work in flight', () => {
  it('asks the new model instead of caching the old one’s answer', async () => {
    writeSettings(settings({ modelName: 'northwind-large' }));
    await flush();

    // The answer to the question nobody is waiting for any more.
    inferences[0]?.resolve(semantic({ risk: 90 }));
    await flush();
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    expect(inferences).toHaveLength(2);
  });

  it('shows no verdict from the superseded model while the new one is being asked', async () => {
    writeSettings(settings({ modelName: 'northwind-large' }));
    await flush();

    inferences[0]?.resolve(semantic({ risk: 90 }));
    await flush();
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    expect(tabStatus()).toMatchObject({ semantic: 'pending' });
  });

  /**
   * The same for the trust list, which is the one a reader is most likely to change while an inference is
   * running: the button that adds an entry sits on the card of the message being analysed.
   */
  it('re-analyses after a trust change made mid-inference', async () => {
    writeSettings(settings({ trustedSenders: ['northwind-logistics.com'] }));
    await flush();

    inferences[0]?.resolve(semantic({ risk: 90 }));
    await flush();
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    expect(inferences).toHaveLength(2);
  });

  /** A presentation-only change must not throw the inference away; nothing about the verdict has moved. */
  it('leaves the inference alone when only the presentation changed', async () => {
    writeSettings(settings({ showBadgeWhenLow: false }));
    await flush();

    inferences[0]?.resolve(semantic());
    await flush();

    expect(inferences).toHaveLength(1);
    expect(tabStatus()).toMatchObject({ semantic: 'ready' });
  });
});


it('ignores a settings snapshot that arrives after a newer reload', async () => {
  inferences[0]?.resolve(semantic());
  await flush();
  const pending: ((value: unknown) => void)[] = [];
  delayedSettings = () => new Promise((resolve) => { pending.push(resolve); });
  try {
    writeSettings(settings({ showBadgeWhenLow: true }));
    writeSettings(settings({ showBadgeWhenLow: false }));
    pending[1]?.({ ok: true, type: 'SETTINGS', settings: settings({ showBadgeWhenLow: false }) });
    await flush();
    expect(badgeIsOnScreen()).toBe(false);
    pending[0]?.({ ok: true, type: 'SETTINGS', settings: settings({ showBadgeWhenLow: true }) });
    await flush();
    expect(badgeIsOnScreen()).toBe(false);
  } finally {
    delayedSettings = null;
  }
});
