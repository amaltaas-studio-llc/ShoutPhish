#!/usr/bin/env node
/**
 * Reads one version's entry from CHANGELOG.md, the release notes people see when they update.
 *
 *   node scripts/release-notes.mjs 0.16.3                          # prints the entry
 *   node scripts/release-notes.mjs 0.16.3 --amo-metadata=out.json  # docs/amo-metadata.json plus the entry
 *
 * The entry goes into the metadata here rather than living in docs/amo-metadata.json, because that file is
 * sent with every version and a fixed note would be repeated on each one.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The text under `## <version>`, up to the next heading; undefined when there is no such entry. */
export function releaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('#'));
  const text = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  return text === '' ? undefined : text;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, ...flags] = process.argv.slice(2);
  if (version === undefined) {
    console.error('usage: release-notes.mjs <version> [--amo-metadata=<out.json>]');
    process.exit(2);
  }
  const notes = releaseNotes(await readFile(path.join(root, 'CHANGELOG.md'), 'utf8'), version);
  if (notes === undefined) {
    console.error(`CHANGELOG.md has no entry for ${version}. Add a "## ${version}" section first.`);
    process.exit(1);
  }
  const out = flags.find((flag) => flag.startsWith('--amo-metadata='))?.slice('--amo-metadata='.length);
  if (out === undefined) {
    console.log(notes);
  } else {
    const metadata = JSON.parse(await readFile(path.join(root, 'docs/amo-metadata.json'), 'utf8'));
    metadata.version = { ...metadata.version, release_notes: { 'en-US': notes } };
    await writeFile(out, `${JSON.stringify(metadata, null, 2)}\n`);
  }
}
