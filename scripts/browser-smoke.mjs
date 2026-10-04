#!/usr/bin/env node
/**
 * Loads the built extension and the UI harness into real browsers and checks that they render.
 *
 *   npm run smoke:browsers                         # every supported browser found on this machine
 *   npm run smoke:browsers -- --browsers=edge,firefox
 *   npm run smoke:docker                           # Chromium and Firefox ESR in a container, nothing installed
 *
 * Two layers, because they fail differently:
 *
 *  - **The harness** renders the real badge and card over every fixture, every semantic state and the
 *    "not checked" card. These are ordinary pages, so every engine can open them, and they are where a
 *    layout regression shows: a card wider than the viewport, a score the badge and card disagree on, a
 *    finding clipped by its container.
 *  - **The extension's own pages** (welcome, options, popup) and its background context, loaded as an
 *    unpacked extension. This is what a green unit-test run cannot see: a page that throws on load in one
 *    browser, a manifest the browser accepts but never starts.
 *
 * Assertions are about structure and geometry, never pixels. Text rendering differs between operating
 * systems and font sets, so a pixel baseline only ever matches the machine that recorded it, and a check
 * that fails everywhere else gets deleted rather than read. Screenshots are still written to
 * `smoke-output/` for a person to look at; nothing compares them.
 *
 * No Playwright or Puppeteer, for the reason in `scripts/screenshots.mjs`, and because neither would cover
 * more here: Playwright's Firefox and WebKit are patched builds that cannot load an extension at all.
 * Chromium browsers are driven over the DevTools protocol, Firefox over WebDriver BiDi, both with the
 * WebSocket and pipes Node already has.
 *
 * Exits non-zero on any failed check, or when a browser named in `--browsers` cannot be found.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'smoke-output');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const args = new Map(
  process.argv.slice(2).map((a) => {
    const [key, value = 'true'] = a.replace(/^--/, '').split('=');
    return [key, value];
  }),
);

const VIEWPORT = { width: 1280, height: 900 };
const FIREFOX_ID = 'shoutphish@amaltaas-studio-llc';
/** Fixed so the test knows the extension's address before Firefox would otherwise pick one at random. */
const FIREFOX_UUID = '5b0f2c1e-7d3a-4e8b-9c61-2f4a8d9e0b13';
const PHISH = 'microsoft-phish';
const SEMANTIC_STATES = ['ready', 'pending', 'skipped', 'unavailable', 'no-output', 'error', 'cancelled', 'off'];

const BROWSERS = {
  chrome: {
    engine: 'chromium',
    env: 'CHROME_PATH',
    win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
  },
  edge: {
    engine: 'chromium',
    env: 'EDGE_PATH',
    win32: [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
    darwin: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    linux: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'],
  },
  chromium: {
    engine: 'chromium',
    env: 'CHROMIUM_PATH',
    win32: [],
    darwin: ['/Applications/Chromium.app/Contents/MacOS/Chromium'],
    linux: ['/usr/bin/chromium', '/usr/bin/chromium-browser'],
  },
  firefox: {
    engine: 'firefox',
    env: 'FIREFOX_PATH',
    win32: [
      'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
      'C:\\Program Files\\Firefox Developer Edition\\firefox.exe',
      'C:\\Program Files\\Firefox Nightly\\firefox.exe',
    ],
    darwin: [
      '/Applications/Firefox.app/Contents/MacOS/firefox',
      '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox',
    ],
    linux: ['/usr/bin/firefox', '/usr/bin/firefox-esr'],
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(probe, what, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

function executableFor(name) {
  const spec = BROWSERS[name];
  const fromEnv = process.env[spec.env];
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  return (spec[process.platform] ?? []).find((candidate) => existsSync(candidate)) ?? null;
}

// ---------------------------------------------------------------------------
// Chromium: the DevTools protocol over --remote-debugging-pipe
// ---------------------------------------------------------------------------

/**
 * A pipe rather than a port, because `Extensions.loadUnpacked` is only offered on a pipe. That command is
 * the one way left to load an unpacked extension into branded Chrome: from 137 it ignores
 * `--load-extension`, which the other Chromium browsers still honour.
 */
class Cdp {
  #proc;
  #next = 0;
  #pending = new Map();
  #buffer = '';
  #listeners = new Set();
  stderr = '';

  constructor(exe, profile) {
    this.#proc = spawn(
      exe,
      [
        '--headless=new',
        '--remote-debugging-pipe',
        '--enable-unsafe-extension-debugging',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-search-engine-choice-screen',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
        // Linux CI runners and containers often cannot create the sandbox's user namespace. It guards
        // against hostile web content; everything opened here is this repository's own build and fixtures.
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] },
    );
    this.#proc.stderr.on('data', (d) => {
      this.stderr = (this.stderr + String(d)).slice(-4000);
    });
    this.#proc.stdio[4].on('data', (chunk) => {
      this.#buffer += String(chunk);
      let end;
      while ((end = this.#buffer.indexOf('\0')) !== -1) {
        const message = JSON.parse(this.#buffer.slice(0, end));
        this.#buffer = this.#buffer.slice(end + 1);
        const waiting = this.#pending.get(message.id);
        if (waiting) {
          this.#pending.delete(message.id);
          if (message.error) waiting.reject(new Error(`${waiting.method}: ${message.error.message}`));
          else waiting.resolve(message.result);
        } else {
          for (const listener of this.#listeners) listener(message);
        }
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#proc.stdio[3].write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
    });
  }

  on(listener) {
    this.#listeners.add(listener);
  }

  close() {
    this.#proc.kill();
  }
}

async function chromiumPage(cdp, url = 'about:blank') {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const errors = [];
  cdp.on((message) => {
    if (message.sessionId !== sessionId) return;
    const p = message.params;
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text);
    } else if (message.method === 'Runtime.consoleAPICalled' && p.type === 'error') {
      errors.push(p.args.map((a) => a.value ?? a.description ?? '').join(' '));
    } else if (message.method === 'Log.entryAdded' && p.entry.level === 'error') {
      // The harness's dev server has no favicon, and the browser asks for one.
      if (!/favicon\.ico/.test(p.entry.url ?? '')) errors.push(p.entry.text);
    }
  });
  const send = (method, params) => cdp.send(method, params, sessionId);
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });

  return {
    canScreenshotExtensionPages: true,
    canEmulateColorScheme: true,
    async goto(target) {
      await send('Page.navigate', { url: target });
      await waitFor(
        async () => (await this.evaluate(`() => document.readyState === 'complete' && location.href`)) === target,
        `${target} to load`,
      );
    },
    async evaluate(fn) {
      const r = await send('Runtime.evaluate', { expression: `(${fn})()`, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    async colorScheme(value) {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
    },
    async screenshot(file, fullPage) {
      const size = fullPage
        ? await this.evaluate(`() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })`)
        : VIEWPORT;
      const { data } = await send('Page.captureScreenshot', {
        captureBeyondViewport: fullPage,
        clip: { x: 0, y: 0, ...size, scale: 1 },
      });
      await writeFile(file, Buffer.from(data, 'base64'));
    },
    takeErrors: () => errors.splice(0),
  };
}

async function runChromium(name, exe, suite) {
  const profile = await mkdtemp(path.join(tmpdir(), `shoutphish-smoke-${name}-`));
  const cdp = new Cdp(exe, profile);
  try {
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') });
    const base = `chrome-extension://${id}/`;
    const targets = async () => (await cdp.send('Target.getTargets')).targetInfos;
    await suite.check('background', 'the service worker starts', () =>
      waitFor(async () => (await targets()).some((t) => t.url === `${base}background.js`), 'the service worker'),
    );
    await suite.check('background', 'the welcome page opens on install', () =>
      waitFor(async () => (await targets()).some((t) => t.url.startsWith(`${base}welcome.html`)), 'the welcome tab'),
    );
    await suite.runPages(await chromiumPage(cdp), base);
  } catch (error) {
    suite.fail('launch', String(error?.message ?? error), cdp.stderr);
  } finally {
    cdp.close();
    await sleep(500);
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Firefox: WebDriver BiDi
// ---------------------------------------------------------------------------

class Bidi {
  #ws;
  #next = 0;
  #pending = new Map();
  #listeners = new Set();

  static async connect(url) {
    const bidi = new Bidi();
    bidi.#ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      bidi.#ws.onopen = resolve;
      bidi.#ws.onerror = () => reject(new Error(`could not connect to ${url}`));
    });
    bidi.#ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const waiting = message.id === undefined ? undefined : bidi.#pending.get(message.id);
      if (waiting) {
        bidi.#pending.delete(message.id);
        if (message.type === 'error') waiting.reject(new Error(`${waiting.method}: ${message.error} ${message.message}`));
        else waiting.resolve(message.result);
      } else {
        for (const listener of bidi.#listeners) listener(message);
      }
    };
    return bidi;
  }

  send(method, params = {}) {
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(listener) {
    this.#listeners.add(listener);
  }
}

function firefoxPage(bidi, context, { privileged }) {
  const errors = [];
  bidi.on((message) => {
    if (message.method !== 'log.entryAdded' || message.params.source?.context !== context) return;
    if (message.params.level === 'error') errors.push(message.params.text);
  });
  return {
    // Firefox refuses to capture a privileged (moz-extension:) page over BiDi.
    canScreenshotExtensionPages: false,
    canEmulateColorScheme: false,
    async goto(target) {
      if (privileged) {
        // Automation may not navigate *to* an extension page, but an extension page may navigate itself.
        await bidi.send('script.evaluate', {
          expression: `location.href = ${JSON.stringify(target)}`,
          target: { context },
          awaitPromise: false,
        });
        await sleep(300);
        await waitFor(
          async () => (await this.evaluate(`() => document.readyState === 'complete' && location.href`)) === target,
          `${target} to load`,
        );
      } else {
        await bidi.send('browsingContext.navigate', { context, url: target, wait: 'complete' });
      }
    },
    async evaluate(fn) {
      const r = await bidi.send('script.evaluate', {
        expression: `(async () => JSON.stringify(await (${fn})()))()`,
        target: { context },
        awaitPromise: true,
        resultOwnership: 'none',
      });
      if (r.type === 'exception') throw new Error(r.exceptionDetails.text);
      return r.result.value === undefined ? undefined : JSON.parse(r.result.value);
    },
    async screenshot(file) {
      const { data } = await bidi.send('browsingContext.captureScreenshot', { context });
      await writeFile(file, Buffer.from(data, 'base64'));
    },
    /**
     * A click Firefox treats as the user's own. `permissions.request` refuses anything else, including
     * script run with BiDi's `userActivation`, so a scripted `element.click()` cannot stand in for it.
     */
    async click(selector) {
      const at = await this.evaluate(`() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }`);
      try {
        await bidi.send('input.performActions', {
          context,
          actions: [
            {
              type: 'pointer',
              id: 'mouse',
              parameters: { pointerType: 'mouse' },
              actions: [
                { type: 'pointerMove', x: at.x, y: at.y },
                { type: 'pointerDown', button: 0 },
                { type: 'pointerUp', button: 0 },
              ],
            },
          ],
        });
      } catch (error) {
        // Some Firefox releases (156, for one) refuse input in extension pages even with system access,
        // where ESR and 158 accept it. Nothing about the extension is learned from that refusal.
        if (/^input\.performActions: unsupported operation/u.test(String(error?.message))) {
          throw new NotRunnable(`this Firefox does not let automation click in extension pages (${String(error.message)})`);
        }
        throw error;
      }
      await bidi.send('input.releaseActions', { context });
    },
    takeErrors: () => errors.splice(0),
  };
}

/**
 * Connect, for a model server on a non-default loopback port, the way every runner is configured.
 * Firefox decides whether a requested host permission is covered by a declared one by its own rules,
 * which no unit test can reproduce, and a pattern it refuses fails before any prompt is shown. No server
 * is running, so the connection itself fails; what is checked is that the grant was given and that the
 * worker accepts it, which shows as a connection error rather than a refusal or "not granted".
 */
async function checkConnectGrant(suite, page, extensionBase) {
  await suite.check('extension', 'Connect is granted for a localhost model server', async () => {
    await page.goto(`${extensionBase}options.html`);
    await page.evaluate(`async () => {
      document.querySelector('input[name="aiMode"][value="server"]').click();
      const input = document.getElementById('modelBaseUrl');
      input.value = 'http://localhost:11434/v1';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 500));
    }`);
    await page.click('#connect');
    const message = await waitFor(
      async () => {
        // The status line, for a machine that happens to be running a server on that port.
        const text = await page.evaluate(
          `() => document.getElementById('serverError').textContent + ' ' + document.getElementById('status').textContent`,
        );
        return /browser refused|declined|not been granted|Could not connect|Connected/u.test(text ?? '') ? text : undefined;
      },
      'Connect to report an outcome',
    );
    // A server refusing the extension's origin ("model server refused") is past the grant, so it passes.
    if (/browser refused|declined|not been granted/u.test(message)) throw new Error(message);
  });
}

async function runFirefox(name, exe, suite) {
  const profile = await mkdtemp(path.join(tmpdir(), `shoutphish-smoke-${name}-`));
  await writeFile(
    path.join(profile, 'user.js'),
    [
      `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ [FIREFOX_ID]: FIREFOX_UUID }))});`,
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("browser.aboutwelcome.enabled", false);',
      'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
      'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
      // Grants an optional permission without its prompt, which automation cannot answer. Firefox still
      // applies every rule about which permissions may be requested; only the user's yes is assumed.
      'user_pref("extensions.webextOptionalPermissionPrompts", false);',
    ].join('\n'),
  );
  // `-remote-allow-system-access` lets BiDi run script in the extension's own pages; without it Firefox
  // only allows web content.
  const proc = spawn(exe, [
    '-headless',
    '-no-remote',
    '-profile',
    profile,
    '--remote-debugging-port',
    '0',
    '-remote-allow-system-access',
  ]);
  let output = '';
  const collect = (d) => {
    output = (output + String(d)).slice(-8000);
  };
  proc.stdout.on('data', collect);
  proc.stderr.on('data', collect);
  try {
    const url = await waitFor(
      () => /WebDriver BiDi listening on (ws:\/\/\S+)/.exec(output)?.[1],
      'Firefox to start WebDriver BiDi',
      30000,
    );
    const bidi = await Bidi.connect(`${url}/session`);
    await bidi.send('session.new', { capabilities: {} });
    await bidi.send('session.subscribe', { events: ['log.entryAdded'] });
    await bidi.send('webExtension.install', { extensionData: { type: 'path', path: path.join(root, 'dist-firefox') } });

    const base = `moz-extension://${FIREFOX_UUID}/`;
    // The event page has no target of its own to look for; the tab it opens on install is the evidence
    // that it ran.
    const context = await suite.check('background', 'the welcome page opens on install', () =>
      waitFor(async () => {
        const { contexts } = await bidi.send('browsingContext.getTree', {});
        return contexts.find((c) => c.url.startsWith(`${base}welcome.html`))?.context;
      }, 'the welcome tab'),
    );
    if (context !== undefined) {
      const { context: web } = await bidi.send('browsingContext.create', { type: 'tab' });
      await bidi.send('browsingContext.setViewport', { context: web, viewport: VIEWPORT });
      const extensionPage = firefoxPage(bidi, context, { privileged: true });
      await suite.runPages(extensionPage, base, firefoxPage(bidi, web, { privileged: false }));
      await checkConnectGrant(suite, extensionPage, base);
    }
    await bidi.send('session.end').catch(() => undefined);
  } catch (error) {
    suite.fail('launch', String(error?.message ?? error), output.slice(-4000));
  } finally {
    proc.kill();
    await sleep(1000);
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// What is checked, identically in every browser
// ---------------------------------------------------------------------------

/**
 * Runs in the page. Waits for the harness to finish rendering, then reports what is on screen. Kept as
 * a source string because it is evaluated in a browser, not in Node.
 */
const INSPECT_HARNESS = `async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const params = new URLSearchParams(location.search);
  const view = params.get('view') ?? 'full';
  const hosts = (id) => [...document.querySelectorAll('[data-shoutphish="host"]')].filter((h) => h.id === id);
  const panelRoot = () => document.getElementById('shoutphish-panel-host')?.shadowRoot ?? null;
  const ready = () => {
    if (view === 'list') {
      const rows = document.querySelectorAll('tr.zA');
      return rows.length > 0 && [...rows].every((r) => r.hasAttribute('data-shoutphish-mark'));
    }
    const badge = hosts('shoutphish-badge-host')[0]?.shadowRoot?.querySelector('.label');
    if (!badge?.textContent) return false;
    return params.get('card') !== '1' || panelRoot()?.querySelector('.panel') != null;
  };
  for (let i = 0; i < 200 && !ready(); i++) await sleep(50);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  // The card's entrance animation; geometry read mid-transition is displaced.
  await sleep(250);

  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const badges = hosts('shoutphish-badge-host').map((h) => {
    const b = h.shadowRoot.querySelector('.badge');
    return {
      label: b?.querySelector('.label')?.textContent ?? '',
      score: b?.querySelector('.score')?.textContent ?? null,
      box: b ? box(b) : null,
    };
  });
  const root = panelRoot();
  const panelEl = root?.querySelector('.panel') ?? null;
  // Only a container that hides its overflow can cut text off: content overflowing a visible one
  // still shows, and findings bleed 10px into the card's padding on purpose so their hover fill
  // reaches the edge. Ellipsised and visually hidden (screen-reader) elements are clipped by design;
  // content escaping the card altogether is caught by the card's own scroll width.
  const clipped = panelEl
    ? [...root.querySelectorAll('*')]
        .filter((el) => {
          if (el.scrollWidth <= el.clientWidth + 1 || el.clientWidth <= 1) return false;
          const s = getComputedStyle(el);
          return ['hidden', 'clip'].includes(s.overflowX) && s.textOverflow !== 'ellipsis' && s.clipPath === 'none';
        })
        .slice(0, 5)
        .map((el) => \`\${el.tagName.toLowerCase()}.\${el.className}: \${(el.textContent ?? '').slice(0, 60)}\`)
    : [];
  // The other way text is lost: an element wider than the card, whose overflow the card hides.
  const edge = panelEl?.getBoundingClientRect();
  const escaping = panelEl
    ? [...root.querySelectorAll('*')]
        .filter((el) => {
          if (getComputedStyle(el).clipPath !== 'none') return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && (r.left < edge.left - 1 || r.right > edge.right + 1);
        })
        .slice(0, 5)
        .map((el) => \`\${el.tagName.toLowerCase()}.\${el.className}: \${(el.textContent ?? '').slice(0, 60)}\`)
    : [];
  const rows = [...document.querySelectorAll('tr.zA')];
  return {
    viewport: { width: innerWidth, height: innerHeight },
    ready: ready(),
    badges,
    panel: panelEl && {
      box: box(panelEl),
      scrollWidth: panelEl.scrollWidth,
      clientWidth: panelEl.clientWidth,
      score: root.querySelector('.score-value')?.textContent ?? null,
      text: panelEl.textContent ?? '',
      clipped,
      escaping,
    },
    list: { rows: rows.length, marked: document.querySelectorAll('.shoutphish-row-mark').length },
  };
}`;

/** Runs in an extension page: the on-device choice, the version line, and the popup's headline. */
const INSPECT_EXTENSION_PAGE = `async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(800);
  const g = globalThis;
  const hasCreate = (o) => o != null && typeof o.create === 'function';
  const factory = hasCreate(g.LanguageModel) || hasCreate(g.ai?.languageModel) || hasCreate(g.chrome?.aiOriginTrial?.languageModel);
  const local = document.querySelector('input[name="aiMode"][value="local"]');
  const note = document.getElementById('localUnavailable') ?? document.getElementById('local-unavailable');
  const recommended = document.getElementById('localRecommended');
  return {
    title: document.title,
    factory,
    local: local && {
      disabled: local.disabled,
      checked: local.checked,
      noteShown: note != null && !note.hidden && (note.textContent ?? '').trim() !== '',
      recommendedShown: recommended ? !recommended.hidden : null,
    },
    version: document.getElementById('version')?.textContent ?? null,
    popupLabel: document.getElementById('label')?.textContent ?? null,
    overflowsX: document.documentElement.scrollWidth > innerWidth + 1,
  };
}`;

function harnessCases(fixtures) {
  return [
    ...fixtures.map((f) => ({ name: `card ${f}`, query: { fixture: f, card: '1' }, kind: 'scored' })),
    ...SEMANTIC_STATES.map((s) => ({
      name: `semantic ${s}`,
      query: { fixture: PHISH, semantic: s, card: '1' },
      kind: 'scored',
      shot: s === 'ready' || s === 'skipped' ? `card-${s}` : undefined,
    })),
    { name: 'not checked', query: { fixture: PHISH, missing: 'sender', card: '1' }, kind: 'unreadable', shot: 'card-not-checked' },
    { name: 'badges view', query: { view: 'badges' }, kind: 'badges', shot: 'badges' },
    { name: 'list view', query: { view: 'list' }, kind: 'list', shot: 'list' },
  ];
}

function harnessProblems(kind, facts) {
  const problems = [];
  if (!facts.ready) problems.push('never finished rendering');
  const inViewport = (b) => b.x >= -1 && b.y >= -1 && b.x + b.width <= facts.viewport.width + 1 && b.y + b.height <= facts.viewport.height + 1;

  if (kind === 'scored' || kind === 'unreadable') {
    const [badge] = facts.badges;
    if (!badge?.box || badge.box.width === 0 || badge.box.height === 0) problems.push('badge is not visible');
    const p = facts.panel;
    if (!p) return [...problems, 'card did not open'];
    if (!inViewport(p.box)) problems.push(`card extends past the viewport: ${JSON.stringify(p.box)}`);
    if (p.box.width < 300 || p.box.width > 480) problems.push(`card is ${p.box.width}px wide`);
    if (p.scrollWidth > p.clientWidth + 1) problems.push(`card scrolls sideways (${p.scrollWidth} > ${p.clientWidth})`);
    if (p.clipped.length > 0) problems.push(`text clipped: ${p.clipped.join(' | ')}`);
    if (p.escaping.length > 0) problems.push(`wider than the card: ${p.escaping.join(' | ')}`);
    if (kind === 'scored') {
      if (badge?.score != null && p.score !== null && !badge.score.includes(p.score)) {
        problems.push(`badge says ${badge.score}, card says ${p.score}`);
      }
      if (p.score === null) problems.push('card shows no score');
    } else {
      if (badge?.label !== 'Not checked') problems.push(`badge reads "${badge?.label}", not "Not checked"`);
      // Load-bearing (AGENTS.md): without it the card reads as an all-clear on mail nobody checked.
      if (!p.text.includes('This is not a judgement that the message is safe.')) problems.push('card lacks the not-a-judgement sentence');
      if (p.score !== null) problems.push('an unreadable message shows a score');
    }
  } else if (kind === 'badges') {
    if (facts.badges.length < 3) problems.push(`only ${facts.badges.length} badges rendered`);
    for (const b of facts.badges) {
      if (!b.box || b.box.width === 0 || !b.label) problems.push(`a badge is empty or invisible: ${JSON.stringify(b)}`);
    }
  } else if (kind === 'list') {
    if (facts.list.rows === 0) problems.push('no rows rendered');
    if (facts.list.marked === 0) problems.push('no row was marked');
    if (facts.list.marked === facts.list.rows) problems.push('every row was marked');
  }
  return problems;
}

function extensionProblems(page, facts) {
  const problems = [];
  if (facts.overflowsX) problems.push('page scrolls sideways');
  if (page === 'welcome.html' || page === 'options.html') {
    if (!facts.local) return [...problems, 'no on-device choice on the page'];
    // The choice is offered exactly where the browser has a Prompt API (src/shared/on-device-choice.ts).
    if (facts.local.disabled === facts.factory) {
      problems.push(`on-device choice is ${facts.local.disabled ? 'disabled' : 'enabled'} but the browser ${facts.factory ? 'has' : 'lacks'} a model API`);
    }
    if (facts.local.disabled && !facts.local.checked && !facts.local.noteShown) problems.push('disabled with no reason shown');
    if (facts.local.recommendedShown !== null && facts.local.recommendedShown === facts.local.disabled) {
      problems.push('"(recommended)" shown on a choice that cannot be made, or hidden on one that can');
    }
  }
  if (page === 'options.html' && !facts.version?.includes(version)) problems.push(`version reads "${facts.version}", not ${version}`);
  if (page === 'popup.html' && !facts.popupLabel?.trim()) problems.push('popup has no headline');
  return problems;
}

/**
 * A check the browser cannot be driven to perform. Reported as not run, by name, rather than as a pass
 * or a failure: a pass would claim coverage that did not happen, and a failure would be a finding about
 * the test harness rather than the extension. Only for a refusal the browser states outright; anything
 * else that goes wrong is a failure.
 */
class NotRunnable extends Error {}

class Suite {
  results = [];

  constructor(browser, harnessUrl, fixtures) {
    this.browser = browser;
    this.harnessUrl = harnessUrl;
    this.fixtures = fixtures;
  }

  fail(area, name, detail) {
    this.results.push({ browser: this.browser, area, name, ok: false, detail });
  }

  async check(area, name, run) {
    try {
      const value = await run();
      this.results.push({ browser: this.browser, area, name, ok: true });
      return value;
    } catch (error) {
      if (error instanceof NotRunnable) {
        this.results.push({ browser: this.browser, area, name, ok: true, notRun: error.message });
      } else {
        this.fail(area, name, String(error?.message ?? error));
      }
      return undefined;
    }
  }

  #record(area, name, problems, errors) {
    const all = [...problems, ...errors.map((e) => `console error: ${e}`)];
    this.results.push({ browser: this.browser, area, name, ok: all.length === 0, detail: all.join('\n') || undefined });
  }

  /** `web` is a separate tab for http pages where the extension's own tab may not navigate off-origin. */
  async runPages(page, extensionBase, web = page) {
    for (const file of ['welcome.html', 'options.html', 'popup.html']) {
      try {
        await page.goto(`${extensionBase}${file}`);
        const facts = await page.evaluate(INSPECT_EXTENSION_PAGE);
        this.#record('extension', file, extensionProblems(file, facts), page.takeErrors());
        if (page.canScreenshotExtensionPages) {
          const stem = path.join(outDir, `${this.browser}-${file.replace('.html', '')}`);
          await page.screenshot(`${stem}.png`, true);
          if (page.canEmulateColorScheme && file !== 'popup.html') {
            await page.colorScheme('dark');
            await page.screenshot(`${stem}-dark.png`, true);
            await page.colorScheme('light');
          }
        }
      } catch (error) {
        this.fail('extension', file, String(error?.message ?? error));
      }
    }

    for (const c of harnessCases(this.fixtures)) {
      const url = `${this.harnessUrl}/?${new URLSearchParams({ bare: '1', ...c.query })}`;
      try {
        await web.goto(url);
        const facts = await web.evaluate(INSPECT_HARNESS);
        this.#record('harness', c.name, harnessProblems(c.kind, facts), web.takeErrors());
        if (c.shot) await web.screenshot(path.join(outDir, `${this.browser}-${c.shot}.png`), false);
      } catch (error) {
        this.fail('harness', c.name, `${String(error?.message ?? error)} (${url})`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Harness server and entry point
// ---------------------------------------------------------------------------

async function startHarness() {
  const proc = spawn(process.execPath, [path.join(root, 'scripts/harness.mjs'), '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  proc.stdout.on('data', (d) => (output += String(d)));
  proc.stderr.on('data', (d) => (output += String(d)));
  const url = await waitFor(() => /UI harness on (http:\/\/\S+)/.exec(output)?.[1], 'the harness to start', 60000).catch(() => {
    throw new Error(`the harness did not start:\n${output}`);
  });
  return { url, stop: () => proc.kill() };
}

function runInDocker() {
  const image = 'shoutphish-browser-smoke';
  const run = (cmd, cmdArgs) =>
    new Promise((resolve, reject) => {
      spawn(cmd, cmdArgs, { stdio: 'inherit', cwd: root }).on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`${cmd} ${cmdArgs[0]} exited with ${code}`)),
      );
    });
  return (async () => {
    await mkdir(outDir, { recursive: true });
    await run('docker', ['build', '-f', 'scripts/browser-smoke.Dockerfile', '-t', image, '.']);
    await run('docker', ['run', '--rm', '-v', `${outDir}:/repo/smoke-output`, image]);
  })();
}

async function main() {
  if (args.has('docker')) {
    await runInDocker();
    return;
  }

  const requested = args.get('browsers')?.split(',').filter(Boolean);
  const names = requested ?? Object.keys(BROWSERS);
  const unknown = names.filter((n) => !(n in BROWSERS));
  if (unknown.length > 0) throw new Error(`unknown browser: ${unknown.join(', ')}. Known: ${Object.keys(BROWSERS).join(', ')}`);

  const found = names.map((n) => ({ name: n, exe: executableFor(n) }));
  const missing = found.filter((b) => b.exe === null);
  if (requested && missing.length > 0) {
    throw new Error(`not found: ${missing.map((b) => `${b.name} (set ${BROWSERS[b.name].env})`).join(', ')}`);
  }
  const runnable = found.filter((b) => b.exe !== null);
  if (runnable.length === 0) throw new Error('no supported browser found; try npm run smoke:docker');
  for (const b of missing) console.log(`skipping ${b.name}: not installed (set ${BROWSERS[b.name].env} to point at it)`);

  for (const dir of ['dist', 'dist-firefox']) {
    if (!existsSync(path.join(root, dir, 'manifest.json'))) throw new Error(`${dir}/ is not built; run npm run build && npm run build:firefox`);
  }

  // Emptied rather than removed: under `--docker` it is a bind mount, which cannot be deleted from inside.
  await mkdir(outDir, { recursive: true });
  for (const entry of readdirSync(outDir)) await rm(path.join(outDir, entry), { recursive: true, force: true });
  const fixtures = readdirSync(path.join(root, 'test/fixtures'))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(root, 'test/fixtures', f), 'utf8')).name);

  const harness = await startHarness();
  const results = [];
  try {
    for (const { name, exe } of runnable) {
      const suite = new Suite(name, harness.url, fixtures);
      const started = Date.now();
      await (BROWSERS[name].engine === 'firefox' ? runFirefox(name, exe, suite) : runChromium(name, exe, suite));
      const failed = suite.results.filter((r) => !r.ok);
      const notRun = suite.results.filter((r) => r.notRun !== undefined);
      const passed = suite.results.length - failed.length - notRun.length;
      const unrun = notRun.length > 0 ? `, ${notRun.length} not run` : '';
      console.log(`${name}: ${passed}/${suite.results.length} checks passed${unrun} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      for (const r of notRun) console.log(`  NOT RUN ${r.area} / ${r.name}\n    ${r.notRun}`);
      for (const r of failed) console.log(`  FAIL ${r.area} / ${r.name}\n    ${(r.detail ?? '').replaceAll('\n', '\n    ')}`);
      results.push(...suite.results);
    }
  } finally {
    harness.stop();
  }

  await writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\nScreenshots and report.json in ${path.relative(root, outDir)}/`);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(String(error?.message ?? error));
  process.exitCode = 1;
});
