#!/usr/bin/env node
/**
 * ShoutPhish build.
 *
 * esbuild is used instead of Vite because the five entry points do not share one output contract (the
 * content script must be IIFE; the worker and the options, popup and welcome pages are ESM), and because
 * the primary UI is injected into Gmail's DOM, so a dev server cannot preview it. See
 * docs/adr/0001-esbuild-not-vite.md.
 *
 * `--target=firefox` builds the same sources into dist-firefox/ with a Firefox manifest: see
 * docs/adr/0012-one-source-per-browser-manifests.md. The Chromium build is in dist/, the directory CI,
 * the release workflow and the install instructions load and package.
 */
import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir, rm, cp, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = new Set(process.argv.slice(2));
const watch = args.has('--watch');
const dev = args.has('--dev');
const cleanOnly = args.has('--clean-only');
const firefox = args.has('--target=firefox');
const outdir = path.join(root, firefox ? 'dist-firefox' : 'dist');
/** The Firefox floor is the first release with built-in data-collection consent; see the manifest. */
const engine = firefox ? 'firefox142' : 'chrome120';

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

/** CSS inside JS strings needs its own minifier; JavaScript minification preserves those bytes. */
const inlineCss = {
  name: 'inline-css',
  setup(build) {
    build.onLoad({ filter: /[/\\]ui[/\\]styles\.ts$/ }, async ({ path: filename }) => {
      const source = await readFile(filename, 'utf8');
      const module = await esbuild.transform(source, { loader: 'ts' });
      const styles = await import(`data:text/javascript;base64,${Buffer.from(module.code).toString('base64')}`);
      const declarations = await Promise.all(Object.entries(styles).map(async ([name, css]) => {
        if (typeof css !== 'string') throw new Error('Inline CSS exports must be strings');
        const result = await esbuild.transform(css, { loader: 'css', minify: true, target: engine });
        return `export const ${name} = ${JSON.stringify(result.code)};`;
      }));
      return { contents: declarations.join('\n'), loader: 'ts' };
    });
  },
};

/** @type {esbuild.BuildOptions} */
const common = {
  bundle: true,
  plugins: dev ? [] : [inlineCss],
  target: [engine],
  platform: 'browser',
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  legalComments: 'none',
  logLevel: 'info',
  define: {
    __SHOUTPHISH_DEV__: dev ? 'true' : 'false',
    __SHOUTPHISH_VERSION__: JSON.stringify(pkg.version),
    __SHOUTPHISH_TARGET__: JSON.stringify(firefox ? 'firefox' : 'chromium'),
  },
};

/** @type {esbuild.BuildOptions[]} */
const targets = [
  {
    ...common,
    entryPoints: { content: path.join(root, 'src/content/index.ts') },
    outdir,
    // MV3 declared content scripts are classic scripts, not modules.
    format: 'iife',
  },
  {
    ...common,
    entryPoints: { background: path.join(root, 'src/background/index.ts') },
    outdir,
    format: 'esm',
  },
  {
    ...common,
    entryPoints: { options: path.join(root, 'src/options/index.ts') },
    outdir,
    format: 'esm',
  },
  {
    ...common,
    entryPoints: { popup: path.join(root, 'src/popup/index.ts') },
    outdir,
    format: 'esm',
  },
  {
    ...common,
    entryPoints: { welcome: path.join(root, 'src/welcome/index.ts') },
    outdir,
    format: 'esm',
  },
];

/** Pages that ship as authored HTML, each loading the bundle of the same name. */
const pages = ['src/options/options.html', 'src/popup/popup.html', 'src/welcome/welcome.html'];

async function copyStatic() {
  let manifest = JSON.parse(await readFile(path.join(root, 'src/manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  manifest.description = pkg.description;
  if (firefox) {
    /*
     * A shallow overlay: each key in the Firefox file replaces the Chrome one whole. That is right for
     * `background`, where Firefox runs an event page from `scripts` and has no service worker, and it
     * keeps the Firefox-only keys in a file that reads as exactly what differs. Chrome's version floor
     * is meaningless there and Firefox warns about it.
     */
    const overlay = JSON.parse(await readFile(path.join(root, 'src/manifest.firefox.json'), 'utf8'));
    manifest = { ...manifest, ...overlay };
    delete manifest.minimum_chrome_version;
  }
  await writeFile(path.join(outdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const page of pages) {
    await cp(path.join(root, page), path.join(outdir, path.basename(page)));
  }

  const icons = path.join(root, 'assets/icons');
  if (await exists(icons)) {
    await cp(icons, path.join(outdir, 'icons'), { recursive: true });
  }
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

await rm(outdir, { recursive: true, force: true });
if (cleanOnly) {
  console.log(`cleaned ${path.basename(outdir)}/`);
  process.exit(0);
}
await mkdir(outdir, { recursive: true });
await mkdir(path.join(root, 'assets/icons'), { recursive: true });
await import('./gen-icons.mjs');

if (watch) {
  const contexts = await Promise.all(targets.map((t) => esbuild.context(t)));
  await Promise.all(contexts.map((c) => c.watch()));
  await copyStatic();
  console.log(`\nShoutPhish dev build watching. Load ${path.basename(outdir)}/ as an unpacked extension.\n`);
} else {
  await Promise.all(targets.map((t) => esbuild.build(t)));
  await copyStatic();
  console.log(
    `\nShoutPhish ${pkg.version} built to ${path.basename(outdir)}/ (${firefox ? 'Firefox' : 'Chromium'}, ${dev ? 'dev' : 'production'}).\n`,
  );
}
