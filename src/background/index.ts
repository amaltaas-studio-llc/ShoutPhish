/**
 * Service worker.
 *
 * **This file is intentionally stateless.** MV3 terminates the worker after ~30 s idle, so any
 * module-level cache here would be a correctness bug that only shows up under real usage. There is no
 * `let cache = …`, no model session, no analysis state; every handler re-reads `chrome.storage` from
 * scratch and every message is self-contained. See docs/adr/0002-mv3-state-in-content-script.md.
 *
 * It does exactly four things, all of which are safe to lose at any instant:
 *   1. settings read/write
 *   2. the only place the extension opens a socket: the inert cloud path, and a model server the user
 *      runs themselves
 *   3. seeding defaults on install
 *   4. painting the toolbar icon badge for the tab that asked (content scripts cannot call `chrome.action`)
 *
 * Egress lives here rather than in the content script so that there is one file to audit for it, and so
 * that a Gmail page's execution context never holds the ability to make requests. Every endpoint is
 * composed from a URL that has already passed validation in `shared/settings.ts`; none is ever taken
 * from a message. The badge appearance likewise arrives complete; the worker does not re-derive a score.
 *
 * It deliberately does **not** import the analysis engine or the on-device model adapter. Analysis
 * runs in the content script, where the execution context lives as long as the tab.
 */
import { logger } from '../shared/logger.js';
import {
  isExtensionRequest,
  type CloudAnalyzeRequest,
  type ExtensionRequest,
  type ExtensionResponse,
  type ModelServerAnalyzeRequest,
  type SetToolbarBadgeRequest,
} from '../shared/messaging.js';
import {
  DEFAULT_SETTINGS,
  STORAGE_KEY,
  isCloudConfigured,
  isModelServerConfigured,
  normalizeSettings,
  originPattern,
} from '../shared/settings.js';
import { egressPermissions } from '../shared/egress-permissions.js';
import { BUILD_TARGET } from '../shared/target.js';
import { truncate } from '../shared/text.js';
import type { Settings } from '../shared/types.js';
import { parseSemanticAnalysis } from '../analysis/llm/parse.js';
import { MAX_PROMPT_CHARS, SYSTEM_PROMPT } from '../analysis/llm/prompt.js';
import { sanitizeCloudPayload } from '../analysis/llm/redact.js';
import {
  MAX_TOKENS,
  REQUEST_VARIANTS,
  completionText,
  describeHttpFailure,
  describeUnusable,
  extensionOriginPattern,
  isShapeRejection,
} from './model-protocol.js';

/** Cloud request timeout. Bounded so a hung backend cannot keep a worker alive indefinitely. */
const CLOUD_TIMEOUT_MS = 12_000;
/**
 * Model-server timeout, far longer than the cloud one because the work happens on the user's own
 * hardware: a 7B model on a CPU can take most of a minute on a long message. Still bounded, and the
 * card shows `pending` throughout, so the cost of the wait is visible rather than mysterious.
 */
const MODEL_SERVER_TIMEOUT_MS = 45_000;
/** Listing models runs no inference, so a server that cannot answer promptly is not reachable. */
const MODEL_LIST_TIMEOUT_MS = 8_000;

async function readSettings(): Promise<Settings> {
  try {
    const stored = await chrome.storage.sync.get(STORAGE_KEY);
    return normalizeSettings(stored[STORAGE_KEY]);
  } catch (error) {
    logger.debug('settings read failed; using defaults', error);
    return { ...DEFAULT_SETTINGS };
  }
}

async function writeSettings(patch: Partial<Settings>): Promise<Settings> {
  // Storage has no atomic merge: the read and write must share a browser-managed lock.
  // A module-level queue would disappear when MV3 terminates this worker.
  return navigator.locks.request('shoutphish-settings', async () => {
    const current = await readSettings();
    const next = normalizeSettings({ ...current, ...patch });
    await chrome.storage.sync.set({ [STORAGE_KEY]: next });
    return next;
  });
}

/**
 * The settings a Gmail tab may change: the trust list, which the card's "trust this sender" button
 * edits. Everything else (above all where content is sent and which mode sends it) is changed only
 * from the extension's own pages, so a defect that let a message run code in the content script could
 * not use this channel to point egress somewhere new.
 */
const TAB_WRITABLE_SETTINGS: ReadonlySet<string> = new Set(['trustedSenders']);

/**
 * Whether the user granted access to the origin a request is about to go to.
 *
 * Checked here, before every request, because the grant is the user's consent and Chrome does not
 * enforce it on its own: without a host permission an extension's fetch still leaves, as an ordinary
 * cross-origin request, and reaches any server that answers CORS for extension origins, which is the
 * configuration these servers are told to use. Settings can be edited without the options page (a
 * content script can write `chrome.storage` directly), so this is the check that holds either way: no
 * extension context can grant itself a host permission.
 */
async function hasHostAccess(baseUrl: string): Promise<boolean> {
  const pattern = originPattern(baseUrl, BUILD_TARGET);
  if (pattern === null) return false;
  try {
    return await chrome.permissions.contains(egressPermissions(pattern, BUILD_TARGET));
  } catch (error) {
    logger.debug('host permission check failed', error);
    return false;
  }
}

const NOT_GRANTED = 'access to this address has not been granted; press Connect in ShoutPhish settings';

/**
 * The single egress point.
 *
 * Inert by design: without `aiMode: 'cloud'` *and* a configured `backendBaseUrl` this returns an
 * error without touching the network, and there is no default backend URL. When it is enabled it
 * talks only to our own backend (never to a model vendor) and carries no API key, because an API
 * key shipped inside an extension is a public API key.
 */
async function cloudAnalyze(request: CloudAnalyzeRequest): Promise<ExtensionResponse> {
  const settings = await readSettings();
  if (!isCloudConfigured(settings)) {
    return { ok: false, error: 'cloud analysis is not enabled' };
  }
  if (!(await hasHostAccess(settings.backendBaseUrl))) {
    return { ok: false, error: 'access to the analysis service has not been granted' };
  }

  // Rebuilt to the contract rather than forwarded. See `sanitizeCloudPayload`: the redaction is only a
  // guarantee if it is applied where the request is made.
  const payload = sanitizeCloudPayload(request.payload);
  if (payload === null) {
    return { ok: false, error: 'analysis payload was not usable' };
  }

  const endpoint = `${settings.backendBaseUrl}/api/analyze`;

  try {
    const response = await privateFetch(
      endpoint,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      },
      AbortSignal.timeout(CLOUD_TIMEOUT_MS),
    );

    if (!response.ok) {
      return { ok: false, error: `analysis service returned ${String(response.status)}` };
    }

    const body: unknown = await response.json();
    const analysis = parseSemanticAnalysis(body, 'cloud');
    return { ok: true, type: 'SEMANTIC', analysis };
  } catch (error) {
    logger.debug('cloud analysis request failed', error);
    return { ok: false, error: 'analysis service unreachable' };
  }
}

/**
 * Every egress request goes through here, so none can be written without these options.
 *
 * No cookies or cached credentials are attached: these are anonymous calls, and must not become a way
 * to correlate a browsing identity with mailbox content. A redirect would move message content to an
 * origin the user never approved and, for a loopback server, potentially off the machine entirely.
 * The signal stays attached while the body is read, so the timeout covers the whole exchange.
 */
function privateFetch(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  return fetch(url, {
    ...init,
    signal,
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
  });
}

/**
 * The other egress point: an OpenAI-compatible model server the user runs.
 *
 * One request shape serves Ollama, LM Studio, Docker Model Runner, llama.cpp and vLLM, because they all
 * expose `/chat/completions`. The endpoint is composed from a URL that has already been through
 * `normalizeModelBaseUrl`, so it is either loopback or https, and it is read from settings rather than
 * taken from the message.
 *
 * No `Authorization` header is sent. Local runners ignore credentials, and the moment this function
 * grew a key field it would become a way to call a hosted vendor with a key stored in an extension.
 */
async function modelServerAnalyze(request: ModelServerAnalyzeRequest): Promise<ExtensionResponse> {
  const settings = await readSettings();
  if (!isModelServerConfigured(settings)) {
    return { ok: false, error: 'no model server is configured' };
  }
  if (!(await hasHostAccess(settings.modelBaseUrl))) {
    return { ok: false, error: NOT_GRANTED };
  }

  // Bounded here as well as in `buildUserPrompt`, for the same reason the cloud payload is rebuilt: the
  // string arrives over a message, and an unbounded one would be serialised and sent by the only part of
  // the extension that can reach the network.
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: truncate(asPromptText(request.payload.user), MAX_PROMPT_CHARS) },
  ];

  for (const [index, extras] of REQUEST_VARIANTS.entries()) {
    const result = await postCompletion(settings, messages, extras);
    if (result.retryable && index < REQUEST_VARIANTS.length - 1) {
      logger.debug('model server rejected the request shape; retrying with a plainer one');
      continue;
    }
    return result.response;
  }

  return { ok: false, error: 'model server did not accept any supported request shape' };
}

/** A prompt half is a string or it is nothing; the type says so but the message channel cannot. */
function asPromptText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * `retryable` is true only for a 400-class rejection of the request *shape*, which is the one failure
 * worth trying a different way. A connection error, a timeout or a 500 mean the next attempt would fail
 * identically and the reader would wait three times as long to be told so.
 */
async function postCompletion(
  settings: Settings,
  messages: readonly { role: string; content: string }[],
  extras: Record<string, unknown>,
): Promise<{ response: ExtensionResponse; retryable: boolean }> {
  const signal = AbortSignal.timeout(MODEL_SERVER_TIMEOUT_MS);

  try {
    const response = await privateFetch(
      `${settings.modelBaseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          model: settings.modelName,
          messages,
          // Deterministic: the same message should not score differently on a second reading.
          temperature: 0,
          max_tokens: MAX_TOKENS,
          stream: false,
          ...extras,
        }),
      },
      signal,
    );

    if (!response.ok) {
      return {
        response: { ok: false, error: describeHttpFailure(response.status, BUILD_TARGET) },
        retryable: isShapeRejection(response.status),
      };
    }

    const body: unknown = await response.json();
    const content = completionText(body);
    const analysis =
      content === null ? null : parseSemanticAnalysis(content, 'server', settings.modelName);

    // The most confusing failure in this function, and the one with no error to report it: HTTP 200 with
    // an answer nothing can be done with. Unlogged, it would be indistinguishable from a model that found
    // nothing. `scrub` reduces the text itself to a length, so what is recorded is its *shape*: enough
    // to tell a truncated reply from a refusal from prose the parser gave up on, which is the difference
    // between raising a limit and changing a prompt.
    if (analysis === null) {
      logger.debug('model server returned no usable assessment', describeUnusable(body, content));
    }

    return { response: { ok: true, type: 'SEMANTIC', analysis }, retryable: false };
  } catch (error) {
    logger.debug('model server request failed', error);
    return {
      response: {
        ok: false,
        error: signal.aborted ? 'model server timed out' : 'model server unreachable',
      },
      retryable: false,
    };
  }
}

/**
 * `GET /models` on the configured server, so the options page can offer what is actually loaded rather
 * than asking the user to type a name from memory. Also the connection test: reaching this means the
 * URL, the port and the permission grant are correct, and `originRefusal` covers the server's origin
 * policy where the GET alone cannot.
 */
async function listModels(): Promise<ExtensionResponse> {
  const settings = await readSettings();
  if (settings.modelBaseUrl === '') return { ok: false, error: 'no model server URL is set' };
  if (!(await hasHostAccess(settings.modelBaseUrl))) return { ok: false, error: NOT_GRANTED };

  try {
    const response = await privateFetch(
      `${settings.modelBaseUrl}/models`,
      { headers: { accept: 'application/json' } },
      AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
    );
    if (!response.ok) return { ok: false, error: describeHttpFailure(response.status, BUILD_TARGET) };

    const body: unknown = await response.json();
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data)) return { ok: false, error: 'server did not return a model list' };

    const refusal = await originRefusal(settings.modelBaseUrl);
    if (refusal !== null) return { ok: false, error: refusal };

    const models = data
      .map((entry) => (entry as { id?: unknown }).id)
      .filter((id): id is string => typeof id === 'string' && id !== '')
      .slice(0, 200);
    return { ok: true, type: 'MODELS', models };
  } catch (error) {
    logger.debug('model list request failed', error);
    return {
      ok: false,
      error:
        `could not reach the model server: it may not be running, the address may be wrong, or it may be refusing requests from browser extensions (for Ollama, OLLAMA_ORIGINS must include ${extensionOriginPattern(BUILD_TARGET)})`,
    };
  }
}

/**
 * Whether the server refuses this extension's origin, which the model list cannot show in Firefox.
 *
 * Chrome attaches `Origin` to the worker's GET, so a server refusing the extension refuses the list too.
 * Firefox leaves it off a GET from an extension holding the host permission, but sends it on every POST,
 * and every analysis is a POST: without this, the list succeeds and reports the server reached while
 * each analysis is refused with 403. A POST to `/models` carries the header but matches no route, and
 * Ollama checks the origin before routing: it answers 403 to a refused origin and 405 to an allowed one,
 * without loading a model. Only 401 and 403 are read as refusal; any other answer, or none, leaves the
 * list's success standing, because nothing else here is evidence about the origin.
 */
async function originRefusal(baseUrl: string): Promise<string | null> {
  if (BUILD_TARGET !== 'firefox') return null;
  try {
    const response = await privateFetch(
      `${baseUrl}/models`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
    );
    return response.status === 401 || response.status === 403
      ? describeHttpFailure(response.status, BUILD_TARGET)
      : null;
  } catch (error) {
    logger.debug('origin check request failed', error);
    return null;
  }
}

async function handle(
  request: ExtensionRequest,
  sender: chrome.runtime.MessageSender,
): Promise<ExtensionResponse> {
  switch (request.type) {
    case 'GET_SETTINGS':
      return { ok: true, type: 'SETTINGS', settings: await readSettings() };
    case 'SET_SETTINGS': {
      const patch: unknown = request.patch;
      if (patch === null || typeof patch !== 'object') return { ok: false, error: 'invalid settings' };
      // `sender.url` is set by Chrome: the extension's own origin for its pages, even when one is open in
      // a tab, and the page's URL for a content script. `sender.tab` cannot tell the two apart.
      const fromExtensionPage = sender.url?.startsWith(chrome.runtime.getURL('')) === true;
      if (!fromExtensionPage && Object.keys(patch).some((key) => !TAB_WRITABLE_SETTINGS.has(key))) {
        return { ok: false, error: 'that setting can only be changed from ShoutPhish settings' };
      }
      return { ok: true, type: 'SETTINGS', settings: await writeSettings(request.patch) };
    }
    case 'CLOUD_ANALYZE':
      return cloudAnalyze(request);
    case 'MODEL_SERVER_ANALYZE':
      return modelServerAnalyze(request);
    case 'LIST_MODELS':
      return listModels();
    case 'SET_TOOLBAR_BADGE':
      return setToolbarBadge(request, sender);
  }
}

/**
 * Applies a badge the content script already computed. `tabId` comes only from Chrome's `sender.tab`,
 * never from the message body; a forged id in the payload could not retarget another tab.
 */
async function setToolbarBadge(
  request: SetToolbarBadgeRequest,
  sender: chrome.runtime.MessageSender,
): Promise<ExtensionResponse> {
  const tabId = sender.tab?.id;
  if (tabId === undefined) {
    return { ok: false, error: 'toolbar badge requires a tab' };
  }
  // All four checked before any call, so a malformed request cannot leave the badge half-painted.
  if (
    typeof request.text !== 'string' ||
    request.text.length > 4 ||
    typeof request.title !== 'string' ||
    typeof request.background !== 'string' ||
    typeof request.textColor !== 'string'
  ) {
    return { ok: false, error: 'invalid badge' };
  }
  // A paint spans several async API calls; keep each tab's text, title and colours together.
  return navigator.locks.request(`shoutphish-toolbar-${String(tabId)}`, async () => {
    try {
      await chrome.action.setBadgeText({ tabId, text: request.text });
      await chrome.action.setTitle({ tabId, title: request.title });
      if (request.text !== '') {
        await chrome.action.setBadgeBackgroundColor({ tabId, color: request.background });
        await chrome.action.setBadgeTextColor({ tabId, color: request.textColor });
      }
      return { ok: true, type: 'ACKNOWLEDGED' };
    } catch (error) {
      logger.debug('toolbar badge update failed', error);
      return { ok: false, error: 'could not update toolbar badge' };
    }
  });
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse): boolean => {
  if (!isExtensionRequest(message)) {
    sendResponse({ ok: false, error: 'unrecognised request' } satisfies ExtensionResponse);
    return false;
  }

  // Only accept messages from our own extension's contexts. `sender.id` is set by Chrome and cannot
  // be forged by a web page, so this rejects anything originating outside the extension.
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: 'unauthorised sender' } satisfies ExtensionResponse);
    return false;
  }

  handle(message, sender).then(sendResponse, (error: unknown) => {
    logger.debug('handler threw', error);
    sendResponse({ ok: false, error: 'internal error' } satisfies ExtensionResponse);
  });

  // Keeps the message channel open for the async response.
  return true;
});

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    // Seed defaults without overwriting anything the user has already chosen.
    const settings = await writeSettings({});
    logger.info('installed', { reason: details.reason, aiMode: settings.aiMode });

    /*
     * A first install is the one moment the extension has something to say: it works only on Gmail, in a
     * tab the user has probably not opened yet, so without this the install completes and nothing
     * whatsoever appears to happen.
     *
     * Only on `install`. Opening a tab on every `update` is the behaviour that gets extensions
     * uninstalled, and Chrome updates them without being asked.
     */
    if (details.reason !== 'install') return;
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
    } catch (error) {
      // Not worth failing the install over. The settings page links to the same page.
      logger.debug('could not open the welcome page', error);
    }
  })();
});
