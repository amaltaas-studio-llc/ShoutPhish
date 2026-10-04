#!/usr/bin/env node
/**
 * Checks that dist/ is something Chrome will actually load, or with `--target=firefox`, that
 * dist-firefox/ is something Firefox will.
 *
 * Every failure here is one that is invisible until a person unzips the download and the browser refuses
 * it, or accepts it and silently does nothing. That is the worst place to find out, so the same check runs
 * in CI, in the release workflow before publishing, and locally via `npm run check:dist`.
 *
 * The file list is read out of the manifest rather than hardcoded. A hardcoded list only checks the files
 * someone remembered to add to it, which means the guard stops covering the manifest the moment the
 * manifest grows a new reference, exactly when it would start being useful.
 */
import { readFile, access, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const firefox = process.argv.slice(2).includes('--target=firefox');
const dist = path.join(root, firefox ? 'dist-firefox' : 'dist');
const distName = path.basename(dist);

const problems = [];
const fail = (message) => problems.push(message);

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(p) {
  return JSON.parse(await readFile(p, 'utf8'));
}

if (!(await exists(path.join(dist, 'manifest.json')))) {
  console.error(
    `${distName}/manifest.json is missing. Run \`npm run ${firefox ? 'build:firefox' : 'build'}\` first.`,
  );
  process.exit(1);
}

const manifest = await readJson(path.join(dist, 'manifest.json'));
const pkg = await readJson(path.join(root, 'package.json'));

if (manifest.manifest_version !== 3) {
  fail(`expected manifest_version 3, found ${JSON.stringify(manifest.manifest_version)}`);
}

// The manifest version is generated from package.json, so a mismatch means the build was stale, and a
// release whose asset reports a different version than its tag is worse than no release at all.
if (manifest.version !== pkg.version) {
  fail(`manifest version ${manifest.version} does not match package.json ${pkg.version}`);
}

// Chrome's own rule, which npm's semver does not share: `1.0.0-beta.1` is a valid package.json version
// that produces a manifest Chrome refuses to load.
const versionParts = typeof manifest.version === 'string' ? manifest.version.split('.') : [];
if (
  versionParts.length < 1 ||
  versionParts.length > 4 ||
  !versionParts.every((part) => /^(0|[1-9]\d{0,4})$/.test(part) && Number(part) <= 65535)
) {
  fail(`manifest version ${JSON.stringify(manifest.version)} is not 1-4 dot-separated integers of 0-65535`);
}

// The store shows this as the listing's summary and refuses an upload whose description runs past 132
// characters, which would otherwise surface only once a version number is already tagged.
if (typeof manifest.description !== 'string' || manifest.description.length === 0) {
  fail('manifest description is missing; the store shows it as the listing summary');
} else if (manifest.description.length > 132) {
  fail(`manifest description is ${String(manifest.description.length)} characters; the store allows 132`);
}

/*
 * The README and docs/PRIVACY.md tell users exactly which permissions they are granting. A change here is
 * a change to that promise, so it fails until this list (and both documents) are updated in the same
 * commit. Optional host permissions are not listed: they are requested per origin on a click, and a
 * default install never holds them.
 */
const EXPECTED_PERMISSIONS = ['storage'];
const EXPECTED_HOST_PERMISSIONS = ['https://mail.google.com/*'];
const sameList = (actual, expected) =>
  Array.isArray(actual) &&
  actual.length === expected.length &&
  actual.every((value, i) => value === expected[i]);
if (!sameList(manifest.permissions, EXPECTED_PERMISSIONS)) {
  fail(
    `manifest permissions are ${JSON.stringify(manifest.permissions)}, expected ` +
      `${JSON.stringify(EXPECTED_PERMISSIONS)}; README.md and docs/PRIVACY.md advertise that set`,
  );
}
if (!sameList(manifest.host_permissions, EXPECTED_HOST_PERMISSIONS)) {
  fail(
    `manifest host_permissions are ${JSON.stringify(manifest.host_permissions)}, expected ` +
      `${JSON.stringify(EXPECTED_HOST_PERMISSIONS)}; README.md and docs/PRIVACY.md advertise that set`,
  );
}

/*
 * Firefox: an event page rather than a service worker, and the keys that only Firefox reads, compared
 * whole against the overlay they came from. The data declaration is shown to users at install, so like
 * the permission list above it is a promise, and a build that drifts from it fails here.
 */
if (firefox) {
  const overlay = await readJson(path.join(root, 'src/manifest.firefox.json'));
  if (manifest.background?.service_worker !== undefined) {
    fail('background.service_worker is set; Firefox runs background.scripts as an event page instead');
  }
  if (!Array.isArray(manifest.background?.scripts) || manifest.background.scripts.length === 0) {
    fail('background.scripts is missing, so Firefox would start no background script');
  }
  if (JSON.stringify(manifest.browser_specific_settings) !== JSON.stringify(overlay.browser_specific_settings)) {
    fail('browser_specific_settings does not match src/manifest.firefox.json');
  }
  if ('minimum_chrome_version' in manifest) {
    fail('minimum_chrome_version is set; it means nothing to Firefox, which warns about it');
  }
} else if (manifest.browser_specific_settings !== undefined) {
  fail('browser_specific_settings is set in the Chromium build');
}

/** Every path the manifest points at, with the field that named it, for an error a reader can act on. */
function referencedPaths(m) {
  const found = [];
  const add = (file, field) => {
    if (typeof file === 'string' && file.length > 0) found.push({ file, field });
  };

  add(m.background?.service_worker, 'background.service_worker');
  for (const file of m.background?.scripts ?? []) add(file, 'background.scripts');
  add(m.options_ui?.page, 'options_ui.page');
  add(m.options_page, 'options_page');
  add(m.action?.default_popup, 'action.default_popup');
  add(m.devtools_page, 'devtools_page');
  add(m.sandbox?.pages, 'sandbox.pages');

  for (const [size, file] of Object.entries(m.icons ?? {})) add(file, `icons.${size}`);
  for (const [size, file] of Object.entries(m.action?.default_icon ?? {})) {
    add(file, `action.default_icon.${size}`);
  }

  for (const [i, script] of (m.content_scripts ?? []).entries()) {
    for (const file of script.js ?? []) add(file, `content_scripts[${i}].js`);
    for (const file of script.css ?? []) add(file, `content_scripts[${i}].css`);
  }

  for (const [i, entry] of (m.web_accessible_resources ?? []).entries()) {
    // Resources may be glob patterns, which cannot be checked by existence.
    for (const file of entry.resources ?? []) {
      if (!file.includes('*')) add(file, `web_accessible_resources[${i}].resources`);
    }
  }

  return found;
}

const referenced = referencedPaths(manifest);
for (const { file, field } of referenced) {
  if (!(await exists(path.join(dist, file)))) {
    fail(`${field} names ${file}, which is not in ${distName}/`);
  }
}

/*
 * Pages are copied verbatim rather than bundled, so a renamed output leaves a dead <script> that fails
 * silently at runtime with the page rendering as bare HTML.
 *
 * Every HTML file in dist/ is checked, not only the ones the manifest names: the welcome page is opened
 * with `chrome.tabs.create` and so is referenced by nothing the manifest can be read for, which makes it
 * exactly the page whose script reference would rot unnoticed.
 */
for (const page of (await readdir(dist)).filter((f) => f.endsWith('.html'))) {
  const html = await readFile(path.join(dist, page), 'utf8');
  for (const [, src] of html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) {
    if (/^[a-z]+:|^\/\//i.test(src)) {
      fail(`${page} loads a remote script (${src}), which the CSP forbids`);
    } else if (!(await exists(path.join(dist, src.replace(/^\.?\//, ''))))) {
      fail(`${page} loads ${src}, which is not in ${distName}/`);
    }
  }
  // An inline <script> would be blocked by the extension CSP, silently, at runtime.
  if (/<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html)) {
    fail(`${page} contains an inline <script>, which the CSP forbids`);
  }
}

/*
 * Every bundle in dist/, not only those the manifest names: options, popup and welcome are loaded by HTML
 * pages, for the same reason the page check above reads the directory.
 *
 * The HTML-sink names are a second line behind the ESLint ban. Lint sees only this repository's source;
 * the bundle also contains whatever a future dependency or build plugin inlines, and a minified build
 * carries no comments or wording that could mention these names innocently. If a legitimate occurrence
 * ever appears, find where it came from before narrowing this; it is the property docs/adr/0008 states.
 */
const HTML_SINKS =
  /\b(?:innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|setHTMLUnsafe|srcdoc|DOMParser)\b|\bdocument\.write(?:ln)?\b/;
const bundles = (await readdir(dist, { recursive: true })).filter((f) => f.endsWith('.js'));
for (const file of bundles) {
  const source = await readFile(path.join(dist, file), 'utf8');
  // A sourcemap reference in a production bundle leaks the original sources and paths.
  if (source.includes('sourceMappingURL')) {
    fail(`${file} contains a sourcemap reference`);
  }
  const sink = HTML_SINKS.exec(source);
  if (sink) {
    fail(`${file} contains ${sink[0]}, an HTML sink; message content must reach the DOM as text only`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) {
    // The ::error:: prefix is what surfaces the message on the job summary in GitHub Actions; it is
    // harmless noise anywhere else.
    console.error(process.env.GITHUB_ACTIONS ? `::error::${problem}` : `error: ${problem}`);
  }
  process.exit(1);
}

console.log(
  `${distName}/ looks loadable: manifest v${manifest.manifest_version}, version ${manifest.version}, ` +
    `${referenced.length} referenced files present, ${bundles.length} bundles clean.`,
);
