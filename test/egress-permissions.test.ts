import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MODEL_DATA_COLLECTION, egressPermissions } from '../src/shared/egress-permissions.js';
import { originPattern } from '../src/shared/settings.js';

const manifest = JSON.parse(readFileSync(new URL('../src/manifest.json', import.meta.url), 'utf8')) as {
  optional_host_permissions: string[];
};

const firefoxManifest = JSON.parse(
  readFileSync(new URL('../src/manifest.firefox.json', import.meta.url), 'utf8'),
) as { browser_specific_settings: { gecko: { data_collection_permissions: Record<string, string[]> } } };
const declared = firefoxManifest.browser_specific_settings.gecko.data_collection_permissions;

describe('egressPermissions', () => {
  /** Chrome rejects an unknown key in a permissions request outright, so it must never see this one. */
  it('asks Chromium browsers for the origin alone', () => {
    expect(egressPermissions('http://127.0.0.1/*', 'chromium')).toEqual({ origins: ['http://127.0.0.1/*'] });
  });

  it('asks Firefox for the origin and consent to send message text, together', () => {
    expect(egressPermissions('https://models.example/*', 'firefox')).toEqual({
      origins: ['https://models.example/*'],
      data_collection: ['personalCommunications'],
    });
  });
});

describe('originPattern', () => {
  it('asks Chromium browsers for one port of a loopback server', () => {
    expect(originPattern('http://localhost:11434/v1', 'chromium')).toBe('http://localhost:11434/*');
    expect(originPattern('http://127.0.0.1:1234/v1', 'chromium')).toBe('http://127.0.0.1:1234/*');
  });

  /**
   * Firefox refuses a port-specific pattern under a declared named host as undeclared, before any prompt
   * appears, so Connect could never succeed for a server on a non-default port, which is every runner.
   */
  it('asks Firefox for the loopback host exactly as the manifest declares it', () => {
    for (const url of ['http://localhost:11434/v1', 'http://127.0.0.1:12434/engines/v1', 'http://localhost/v1']) {
      const pattern = originPattern(url, 'firefox');
      expect(manifest.optional_host_permissions).toContain(pattern);
    }
  });

  it('keeps the port of an https server in both builds, which the declared wildcard host subsumes', () => {
    for (const target of ['chromium', 'firefox'] as const) {
      expect(originPattern('https://models.example:8443/v1', target)).toBe('https://models.example:8443/*');
      expect(originPattern('https://models.example/v1', target)).toBe('https://models.example/*');
    }
  });

  it('has no pattern for an unset or unparseable address', () => {
    expect(originPattern('', 'firefox')).toBeNull();
    expect(originPattern('not a url', 'chromium')).toBeNull();
  });
});

/**
 * Firefox only lets an extension request data consent it declared as optional, and shows required data
 * at install. A default install sends nothing, so nothing may be required, and what is requested on
 * Connect must be exactly what the manifest declares.
 */
describe('the Firefox data-collection declaration', () => {
  it('requires nothing, so a default install truthfully collects no data', () => {
    expect(declared['required']).toEqual(['none']);
  });

  it('declares as optional exactly what Connect asks for', () => {
    expect(declared['optional']).toEqual([...MODEL_DATA_COLLECTION]);
  });
});
