import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The listing addons.mozilla.org shows, submitted with every release by `web-ext sign --amo-metadata`.
 * A mistake here otherwise surfaces only as a rejected submission, after the version number is spent.
 */
const metadata = JSON.parse(readFileSync(new URL('../docs/amo-metadata.json', import.meta.url), 'utf8')) as {
  categories: Record<string, string[]>;
  summary: Record<string, string>;
  description: Record<string, string>;
  version: { license: string; compatibility: string[]; approval_notes: string };
};
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
  scripts: Record<string, string>;
};
const firefoxManifest = JSON.parse(
  readFileSync(new URL('../src/manifest.firefox.json', import.meta.url), 'utf8'),
) as { browser_specific_settings: Record<string, unknown> };
const license = readFileSync(new URL('../LICENSE', import.meta.url), 'utf8');

describe('the addons.mozilla.org listing', () => {
  it('has a summary within the 250 characters AMO accepts', () => {
    const summary = metadata.summary['en-US'] ?? '';
    expect(summary.length).toBeGreaterThan(0);
    expect(summary.length).toBeLessThanOrEqual(250);
    expect(metadata.description['en-US']?.length ?? 0).toBeGreaterThan(summary.length);
  });

  it('declares the licence the repository is published under', () => {
    expect(metadata.version.license).toBe('MIT');
    expect(license.startsWith('MIT License')).toBe(true);
  });

  /**
   * Gmail's mobile site is different markup from the desktop view the selectors target, and it is
   * untested, so an Android listing would offer an install that does nothing. AMO lists a version for
   * Android whenever the manifest has `gecko_android`, overriding the compatibility submitted here, so
   * both have to say desktop.
   */
  it('lists desktop Firefox only, with a category for exactly the apps it lists', () => {
    expect(firefoxManifest.browser_specific_settings).not.toHaveProperty('gecko_android');
    expect(metadata.version.compatibility).toEqual(['firefox']);
    expect(Object.keys(metadata.categories)).toEqual(['firefox']);
    expect(metadata.categories['firefox']).toContain('privacy-security');
  });

  /**
   * Run as the release workflow runs it, so a version with no entry fails here rather than in the
   * workflow after the tag is pushed. Short, because it is read by someone deciding whether to update.
   */
  it('has release notes for the version being released', () => {
    const notes = execFileSync(process.execPath, ['scripts/release-notes.mjs', pkg.version], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
    }).trim();
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.length).toBeLessThanOrEqual(400);
    expect(notes).not.toMatch(/^#/m);
  });

  it('tells reviewers a build command that exists', () => {
    expect(metadata.version.approval_notes).toContain('npm run build:firefox');
    expect(pkg.scripts).toHaveProperty('build:firefox');
  });
});
