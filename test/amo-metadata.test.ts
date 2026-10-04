import { readFileSync } from 'node:fs';
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
  scripts: Record<string, string>;
};
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
   * The manifest's Android minimum only marks the first release with built-in data consent. Gmail's mobile
   * site is different markup from the desktop view the selectors target, and it is untested, so AMO
   * would otherwise derive an Android listing from that key and offer an install that does nothing.
   */
  it('lists desktop Firefox only, with a category for exactly the apps it lists', () => {
    expect(metadata.version.compatibility).toEqual(['firefox']);
    expect(Object.keys(metadata.categories)).toEqual(['firefox']);
    expect(metadata.categories['firefox']).toContain('privacy-security');
  });

  it('tells reviewers a build command that exists', () => {
    expect(metadata.version.approval_notes).toContain('npm run build:firefox');
    expect(pkg.scripts).toHaveProperty('build:firefox');
  });
});
