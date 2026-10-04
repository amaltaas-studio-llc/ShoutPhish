#!/usr/bin/env node
/**
 * Renders the Chrome Web Store images into store-assets/ from the UI harness.
 *
 *   npm run harness       # in one terminal
 *   npm run store:images  # in another
 *
 * Each screenshot is a slide: a sentence on the left and the real harness on the right, in an iframe, so
 * every pixel of UI in a listing is the shipped component scoring a fixture, not a mock-up. That is a
 * policy matter as much as a taste one: the store removes listings whose screenshots misrepresent the
 * product.
 *
 * Only invented organisations appear. The README's screenshots use a Microsoft lookalike because that is
 * the most recognisable case; on a store listing, a famous brand in the images reads as a claim of
 * association, which the impersonation policy forbids. `fixtures=` narrows the multi-message views to
 * the house `northwind-*` names and the other invented senders.
 *
 * Output is not committed: the images are regenerated from the harness whenever the UI changes, exactly
 * like docs/assets/, and uploaded by hand. Same capture method as `screenshots.mjs`, for the reasons given
 * there; at scale 1 and on an opaque page Chrome writes the 24-bit PNG the store asks for.
 */
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'store-assets');
const base = process.env['SHOUTPHISH_HARNESS_URL'] ?? 'http://127.0.0.1:5199';

/** Invented senders across every band, so `view=badges` finds one of each without a real brand. */
const INVENTED_BANDS = [
  'legitimate',
  'echoed-form-lure',
  'fake-attachment-link',
  'anchor-mismatch',
  'mfa-code-request',
  'thread-hijack-lookalike',
  'payroll-change',
];

const SLIDES = [
  {
    name: '1-explained.png',
    title: 'Every point of the score, explained',
    body: 'ShoutPhish checks the open message in Gmail and shows what it noticed, in plain words, with the evidence to check it yourself.',
    query: { fixture: 'mfa-code-request', semantic: 'ready', view: 'card' },
    frame: { width: 404, height: 700 },
  },
  {
    name: '2-quiet.png',
    title: 'Quiet on ordinary mail',
    body: 'Genuine messages stay Low Risk. The badge can stay hidden until something is worth a look.',
    query: { fixture: 'legitimate', semantic: 'ready', view: 'card' },
    frame: { width: 404, height: 700 },
  },
  {
    name: '3-badge.png',
    title: 'A badge beside the sender',
    body: 'Four levels from Low Risk to High Risk, and an honest "Not checked" when a message could not be read.',
    query: { view: 'badges', semantic: 'ready', fixtures: INVENTED_BANDS.join(',') },
    frame: { width: 760, height: 330 },
  },
  // Not the inbox list: its markers fire on a sender claiming a brand it does not own, which needs a real
  // brand to show, so an invented inbox would display the feature doing nothing.
  {
    name: '4-thread.png',
    title: 'Spots a lookalike in the conversation',
    body: 'A reply from an address one letter away from someone already in the thread is called out. In light or dark mode, like Gmail.',
    query: { fixture: 'thread-hijack-lookalike', semantic: 'ready', view: 'card' },
    frame: { width: 404, height: 700 },
    dark: true,
  },
  {
    name: '5-private.png',
    title: 'Your mail stays on your computer',
    body: 'Everything runs inside your browser. No account, no tracking, and no network requests unless you add your own AI server.',
    image: path.join(root, 'docs/assets/privacy.svg'),
    frame: { width: 760, height: 520 },
  },
];

const BACKGROUND = 'linear-gradient(135deg, #1e1b4b 0%, #312e81 55%, #5b21b6 100%)';
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

function harnessUrl(query) {
  const url = new URL(base);
  for (const [key, value] of Object.entries({ ...query, bare: '1' })) url.searchParams.set(key, value);
  return url.toString();
}

function escape(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function slideHtml(slide) {
  const { width, height } = slide.frame;
  const content =
    slide.image === undefined
      ? `<iframe src="${escape(harnessUrl(slide.query))}" width="${width}" height="${height}"></iframe>`
      : `<img src="${escape(pathToFileURL(slide.image).href)}" width="${width}">`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  /* Matching the framed page's scheme, or Chrome paints an opaque backdrop behind the transparent card. */
  :root { color-scheme: ${slide.dark === true ? 'dark' : 'light'}; }
  html, body { margin: 0; width: 1280px; height: 800px; overflow: hidden; }
  body { background: ${BACKGROUND}; font-family: ${FONT}; display: flex; align-items: center; gap: 56px; padding: 0 64px; box-sizing: border-box; }
  .copy { flex: 1 1 0; color: #ffffff; }
  .brand { display: flex; align-items: center; gap: 12px; font-size: 20px; font-weight: 600; color: #e0e7ff; margin-bottom: 28px; }
  .brand img { width: 40px; height: 40px; }
  h1 { font-size: 44px; line-height: 1.15; letter-spacing: -0.5px; margin: 0 0 20px; }
  p { font-size: 22px; line-height: 1.45; color: #e0e7ff; margin: 0; }
  .shot { flex: 0 0 auto; background: #ffffff; border-radius: 16px; padding: 16px; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35); }
  iframe { border: 0; display: block; }
  img.shot-img { display: block; }
</style></head><body>
  <div class="copy">
    <div class="brand"><img src="${escape(pathToFileURL(path.join(root, 'assets/icons/icon128.png')).href)}" alt="">ShoutPhish</div>
    <h1>${escape(slide.title)}</h1>
    <p>${escape(slide.body)}</p>
  </div>
  <div class="shot"${slide.dark === true ? ' style="background: #1f2023"' : ''}>${content}</div>
</body></html>`;
}

/** The 440x280 tile shown in search results and categories, where only the icon and name are legible. */
function tileHtml(width, height, scale) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; }
  body { background: ${BACKGROUND}; font-family: ${FONT}; display: flex; align-items: center; justify-content: center; gap: ${24 * scale}px; color: #ffffff; }
  img { width: ${96 * scale}px; height: ${96 * scale}px; }
  .name { font-size: ${40 * scale}px; font-weight: 700; letter-spacing: -0.5px; }
  .tag { font-size: ${16 * scale}px; color: #e0e7ff; margin-top: ${6 * scale}px; max-width: ${230 * scale}px; line-height: 1.35; }
</style></head><body>
  <img src="${escape(pathToFileURL(path.join(root, 'assets/icons/icon128.png')).href)}" alt="">
  <div><div class="name">ShoutPhish</div><div class="tag">Phishing checks for Gmail, with reasons you can verify.</div></div>
</body></html>`;
}

const CHROME_CANDIDATES = [
  process.env['CHROME_PATH'],
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env['LOCALAPPDATA'] ?? ''}/Google/Chrome/Application/chrome.exe`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((p) => typeof p === 'string' && p !== '');

async function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next location.
    }
  }
  throw new Error('Could not find Chrome. Set CHROME_PATH to the executable.');
}

async function reachable(url) {
  try {
    return (await fetch(url, { redirect: 'manual' })).status < 500;
  } catch {
    return false;
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited with ${String(code)}`)),
    );
  });
}

async function capture(chrome, work, name, html, width, height, dark = false) {
  const page = path.join(work, `${name}.html`);
  await writeFile(page, html);
  const profile = await mkdtemp(path.join(tmpdir(), 'shoutphish-store-'));
  try {
    await run(chrome, [
      '--headless=new',
      `--screenshot=${path.join(outDir, name)}`,
      `--window-size=${String(width)},${String(height)}`,
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--virtual-time-budget=4000',
      // The slides are file:// pages framing the http harness and reading the repository's own images.
      '--allow-file-access-from-files',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      // The slide itself ignores the scheme; only the framed harness follows it.
      ...(dark ? ['--force-dark-mode', '--blink-settings=preferredColorScheme=0'] : ['--blink-settings=preferredColorScheme=1']),
      pathToFileURL(page).href,
    ]);
    console.log(`  ${name.padEnd(20)} ${String(width)}x${String(height)}`);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

const chrome = await findChrome();
if (!(await reachable(base))) {
  console.error(`The harness is not answering on ${base}. Start it first:\n\n  npm run harness\n`);
  process.exit(1);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
const work = await mkdtemp(path.join(tmpdir(), 'shoutphish-store-pages-'));
try {
  console.log(`\nRendering store images from ${base}:\n`);
  for (const slide of SLIDES) {
    await capture(chrome, work, slide.name, slideHtml(slide), 1280, 800, slide.dark === true);
  }
  await capture(chrome, work, 'tile-small.png', tileHtml(440, 280, 1), 440, 280);
  await capture(chrome, work, 'tile-marquee.png', tileHtml(1400, 560, 2), 1400, 560);
  console.log(`\nWrote ${String(SLIDES.length + 2)} images to store-assets/\n`);
} finally {
  await rm(work, { recursive: true, force: true });
}
