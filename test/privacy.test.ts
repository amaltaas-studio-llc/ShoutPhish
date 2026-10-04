/**
 * The privacy boundary.
 *
 * Two things are tested here, and they are the two places where a mistake would leak mailbox content:
 *
 *  1. **Settings validation.** The defaults must favour local processing, and a value read back from
 *     storage (possibly written by an older build) must never be able to turn the cloud path on or
 *     point it somewhere unintended.
 *  2. **Redaction.** `buildCloudPayload` is the *only* function whose output would ever leave the
 *     browser. These tests assert what it drops, not just what it keeps, because a field silently
 *     added to it later is exactly the regression worth catching.
 */
import { describe, expect, it } from 'vitest';
import { resolveAnalyzer } from '../src/analysis/llm/index.js';
import { ModelServerAnalyzer } from '../src/analysis/llm/model-server.js';
import {
  buildCloudPayload,
  describeNameShape,
  redactAddresses,
  sanitizeCloudPayload,
} from '../src/analysis/llm/redact.js';
import {
  DEFAULT_SETTINGS,
  isCloudConfigured,
  isModelServerConfigured,
  isModelServerRemote,
  normalizeBackendUrl,
  normalizeModelBaseUrl,
  normalizeModelName,
  normalizeSettings,
} from '../src/shared/settings.js';
import type { EmailMessage } from '../src/shared/types.js';
import { loadFixture } from './fixtures/load.js';

describe('default settings', () => {
  it('runs no model and requires no backend', () => {
    expect(DEFAULT_SETTINGS.aiMode).toBe('off');
    expect(DEFAULT_SETTINGS.backendBaseUrl).toBe('');
    expect(isCloudConfigured(DEFAULT_SETTINGS)).toBe(false);
  });

  it('is not cloud-capable out of the box under any reading of the defaults', () => {
    // Belt and braces: cloud mode requires *both* an explicit choice and a URL, so a single mistaken
    // default cannot start sending content anywhere.
    expect(isCloudConfigured({ ...DEFAULT_SETTINGS, aiMode: 'cloud' })).toBe(false);
    expect(isCloudConfigured({ ...DEFAULT_SETTINGS, backendBaseUrl: 'https://x.example' })).toBe(false);
  });

  it('reaches no model server out of the box, and not without all three of the pieces', () => {
    expect(DEFAULT_SETTINGS.modelBaseUrl).toBe('');
    expect(DEFAULT_SETTINGS.modelName).toBe('');
    expect(isModelServerConfigured(DEFAULT_SETTINGS)).toBe(false);

    const url = 'http://localhost:11434/v1';
    expect(isModelServerConfigured({ ...DEFAULT_SETTINGS, aiMode: 'server' })).toBe(false);
    expect(isModelServerConfigured({ ...DEFAULT_SETTINGS, modelBaseUrl: url })).toBe(false);
    // Mode and URL but no model: these servers substitute or reject silently, so a half-configured
    // mode would look enabled while every request failed.
    expect(isModelServerConfigured({ ...DEFAULT_SETTINGS, aiMode: 'server', modelBaseUrl: url })).toBe(
      false,
    );
    expect(
      isModelServerConfigured({
        ...DEFAULT_SETTINGS,
        aiMode: 'server',
        modelBaseUrl: url,
        modelName: 'qwen2.5:7b',
      }),
    ).toBe(true);
  });
});

describe('normalizeSettings', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'aiMode=cloud'],
    ['a number', 42],
    ['an array', []],
  ])('falls back to defaults for %s', (_label, raw) => {
    expect(normalizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });

  it('rejects an unrecognised AI mode rather than passing it through', () => {
    expect(normalizeSettings({ aiMode: 'remote' }).aiMode).toBe('off');
    expect(normalizeSettings({ aiMode: 42 }).aiMode).toBe('off');
    expect(normalizeSettings({ aiMode: null }).aiMode).toBe('off');
  });

  it('preserves valid choices', () => {
    expect(normalizeSettings({ aiMode: 'local' }).aiMode).toBe('local');
    expect(normalizeSettings({ aiMode: 'cloud' }).aiMode).toBe('cloud');
    expect(normalizeSettings({ highlightEnabled: false }).highlightEnabled).toBe(false);
    expect(normalizeSettings({ showBadgeWhenLow: false }).showBadgeWhenLow).toBe(false);
    expect(normalizeSettings({ listMarksEnabled: true }).listMarksEnabled).toBe(true);
    expect(normalizeSettings({ aiOnlyWhenFlagged: false }).aiOnlyWhenFlagged).toBe(false);
  });

  it('falls back to asking the model only about flagged mail for a malformed gate', () => {
    expect(normalizeSettings({ aiOnlyWhenFlagged: 'no' }).aiOnlyWhenFlagged).toBe(true);
    expect(normalizeSettings({}).aiOnlyWhenFlagged).toBe(true);
  });

  /**
   * The defaults a fresh install gets, asserted rather than described, because each is a promise the
   * README makes on the strength of nobody having changed it.
   */
  it('defaults to no AI, no network address, and no annotation of unopened mail', () => {
    const fresh = normalizeSettings({});
    expect(fresh.aiMode).toBe('off');
    expect(fresh.backendBaseUrl).toBe('');
    expect(fresh.modelBaseUrl).toBe('');
    expect(fresh.trustedSenders).toEqual([]);
    // Marking inbox rows annotates mail the user has not chosen to open, so it is opt-in.
    expect(fresh.listMarksEnabled).toBe(false);
  });

  /**
   * A new install has nothing in storage, and reads no mail until the welcome page's button is pressed.
   * Stored settings without the key predate consent and were already reading mail, so they count as
   * agreed; a stored `false` is a choice, and is kept.
   */
  it('reads no mail on a new install until the reader agrees', () => {
    expect(normalizeSettings(undefined).analysisConsent).toBe(false);
    expect(DEFAULT_SETTINGS.analysisConsent).toBe(false);
    expect(normalizeSettings({ aiMode: 'local' }).analysisConsent).toBe(true);
    expect(normalizeSettings({ analysisConsent: false }).analysisConsent).toBe(false);
    expect(normalizeSettings({ analysisConsent: 'yes' }).analysisConsent).toBe(false);
    expect(normalizeSettings([]).analysisConsent).toBe(false);
  });

  it('ignores unknown keys instead of carrying them forward', () => {
    const normalized = normalizeSettings({ aiMode: 'off', apiKey: 'sk-secret', debug: true });
    expect(Object.keys(normalized).sort()).toEqual(
      [
        'aiMode',
        'aiOnlyWhenFlagged',
        'analysisConsent',
        'backendBaseUrl',
        'highlightEnabled',
        'listMarksEnabled',
        'modelBaseUrl',
        'modelName',
        'showBadgeWhenLow',
        'trustedSenders',
      ].sort(),
    );
  });
});

/**
 * The one place where plaintext HTTP is permitted, so the rule is pinned from both directions. The
 * asymmetry is the whole design: loopback has no wire to intercept, anything else carries the subject
 * and body of the open message and must therefore use TLS.
 */
describe('normalizeModelBaseUrl', () => {
  it.each([
    ['Ollama', 'http://localhost:11434/v1', 'http://localhost:11434/v1'],
    ['LM Studio', 'http://127.0.0.1:1234/v1', 'http://127.0.0.1:1234/v1'],
    ['Docker Model Runner', 'http://localhost:12434/engines/v1', 'http://localhost:12434/engines/v1'],
    ['IPv6 loopback', 'http://[::1]:11434/v1', 'http://[::1]:11434/v1'],
    ['a trailing slash', 'http://localhost:11434/v1/', 'http://localhost:11434/v1'],
    ['uppercase host', 'http://LOCALHOST:11434/v1', 'http://localhost:11434/v1'],
  ])('accepts %s over http', (_label, input, expected) => {
    expect(normalizeModelBaseUrl(input)).toBe(expected);
  });

  it('accepts a remote server only over https', () => {
    expect(normalizeModelBaseUrl('https://models.example.com/v1')).toBe('https://models.example.com/v1');
    expect(normalizeModelBaseUrl('https://box.tail1234.ts.net/v1')).toBe('https://box.tail1234.ts.net/v1');
  });

  it.each([
    ['plaintext to a LAN address', 'http://192.168.1.50:11434/v1'],
    ['plaintext to a hostname', 'http://models.example.com/v1'],
    ['plaintext to a host merely containing localhost', 'http://localhost.evil.example/v1'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a data: URL', 'data:text/plain,hi'],
    ['a file: URL', 'file:///etc/passwd'],
    ['credentials in the URL', 'https://user:pass@models.example.com/v1'],
    ['a bare hostname', 'localhost:11434'],
    ['an empty string', ''],
    ['a non-string', 42],
    ['null', null],
  ])('refuses %s', (_label, input) => {
    expect(normalizeModelBaseUrl(input)).toBe('');
  });

  it('drops query and fragment so a saved URL cannot smuggle parameters', () => {
    expect(normalizeModelBaseUrl('http://localhost:11434/v1?key=secret#x')).toBe(
      'http://localhost:11434/v1',
    );
  });

  it('cannot be turned on by storage alone', () => {
    // The same guarantee the backend URL has: a value arriving from an older build, or from a synced
    // profile, does not by itself start sending anything anywhere.
    const settings = normalizeSettings({ modelBaseUrl: 'https://models.example.com/v1' });
    expect(settings.aiMode).toBe('off');
    expect(isModelServerConfigured(settings)).toBe(false);
  });

  it('distinguishes a server on this machine from one that is not', () => {
    const on = { ...DEFAULT_SETTINGS, modelBaseUrl: 'http://localhost:11434/v1' };
    const off = { ...DEFAULT_SETTINGS, modelBaseUrl: 'https://models.example.com/v1' };
    expect(isModelServerRemote(on)).toBe(false);
    expect(isModelServerRemote(off)).toBe(true);
    expect(isModelServerRemote(DEFAULT_SETTINGS)).toBe(false);
  });
});

describe('the model-server adapter', () => {
  const email = loadFixture('legitimate').email;

  it('does nothing at all until the mode, the address and the model are all set', async () => {
    for (const settings of [
      DEFAULT_SETTINGS,
      { ...DEFAULT_SETTINGS, aiMode: 'server' as const },
      { ...DEFAULT_SETTINGS, aiMode: 'server' as const, modelBaseUrl: 'http://localhost:11434/v1' },
      // Configured but not chosen: the mode is what makes it a request, not the presence of an address.
      {
        ...DEFAULT_SETTINGS,
        modelBaseUrl: 'http://localhost:11434/v1',
        modelName: 'qwen2.5:7b',
      },
    ]) {
      const analyzer = new ModelServerAnalyzer(settings);
      expect(await analyzer.isAvailable()).toBe(false);
      // No message channel is opened either, which is what makes this safe to call in Node.
      expect(await analyzer.analyze(email)).toBeNull();
    }
  });

  it('is chosen only by an explicit mode, with no fallback from the on-device model', () => {
    const configured = {
      ...DEFAULT_SETTINGS,
      modelBaseUrl: 'http://localhost:11434/v1',
      modelName: 'qwen2.5:7b',
    };
    expect(resolveAnalyzer({ ...configured, aiMode: 'server' })).toBeInstanceOf(ModelServerAnalyzer);
    expect(resolveAnalyzer({ ...configured, aiMode: 'local' })).not.toBeInstanceOf(ModelServerAnalyzer);
    expect(resolveAnalyzer({ ...configured, aiMode: 'off' })).toBeNull();
  });
});

describe('normalizeModelName', () => {
  it('keeps the names real runners use', () => {
    for (const name of ['qwen2.5:7b', 'ai/smollm2', 'hf.co/user/repo:Q4_K_M', 'llama-3.1-8b-instruct']) {
      expect(normalizeModelName(name)).toBe(name);
    }
  });

  it('strips control characters and bounds the length, since it lands in a JSON body', () => {
    expect(normalizeModelName('  qwen2.5:7b\n  ')).toBe('qwen2.5:7b');
    expect(normalizeModelName('a\u0000b\u001fc')).toBe('abc');
    expect(normalizeModelName('x'.repeat(500))).toHaveLength(200);
    expect(normalizeModelName(42)).toBe('');
  });
});

describe('normalizeBackendUrl', () => {
  it('keeps an https origin and path prefix', () => {
    expect(normalizeBackendUrl('https://shoutphish.example.com')).toBe('https://shoutphish.example.com');
    expect(normalizeBackendUrl('https://example.com/api/v1')).toBe('https://example.com/api/v1');
    expect(normalizeBackendUrl('  https://example.com/  ')).toBe('https://example.com');
  });

  it.each([
    ['plain http, which would send content in the clear', 'http://example.com'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a data: URL', 'data:text/plain,hi'],
    ['a file: URL', 'file:///etc/passwd'],
    ['a chrome-extension: URL', 'chrome-extension://abc/page.html'],
    ['a bare hostname with no scheme', 'example.com'],
    ['an empty string', ''],
    ['whitespace', '   '],
    ['nonsense', 'not a url at all'],
    ['a non-string', 42],
    ['null', null],
  ])('refuses %s', (_label, input) => {
    expect(normalizeBackendUrl(input)).toBe('');
  });

  it('discards query and fragment, so a configured URL cannot smuggle parameters', () => {
    expect(normalizeBackendUrl('https://example.com/api?key=secret#frag')).toBe('https://example.com/api');
  });

  it('cannot be pointed at a model vendor by editing storage without also choosing cloud mode', () => {
    const settings = normalizeSettings({ backendBaseUrl: 'https://api.openai.com' });
    expect(settings.aiMode).toBe('off');
    expect(isCloudConfigured(settings)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const RICH_EMAIL: EmailMessage = {
  senderName: 'Microsoft Account Team',
  senderEmail: 'security-noreply@rnicrosoft-online.com',
  replyTo: 'collect@mailbox-relay.example',
  recipientEmail: 'jane.okonkwo@northwind-logistics.com',
  subject: 'Unusual sign-in activity on your account',
  bodyText:
    'Hello jane.okonkwo@northwind-logistics.com, we detected a sign-in. Contact us at help@rnicrosoft-online.com immediately.',
  links: [
    {
      text: 'Verify now',
      href: 'https://account-verify.example/login?uid=8f3a9c2b-jane-okonkwo&campaign=q4',
      normalizedDomain: 'account-verify.example',
    },
  ],
  attachments: [
    { filename: 'Northwind_Payroll_Q4_Okonkwo.xlsx', extension: 'xlsx' },
  ],
};

describe('buildCloudPayload: what is dropped', () => {
  const payload = buildCloudPayload(RICH_EMAIL, ['identity.lookalike_sender_domain']);
  const serialized = JSON.stringify(payload);

  it('never includes the recipient address', () => {
    expect(serialized).not.toContain('jane.okonkwo@northwind-logistics.com');
    expect(payload).not.toHaveProperty('recipientEmail');
  });

  it('reduces the sender to a domain, dropping the local part', () => {
    expect(payload.senderDomain).toBe('rnicrosoft-online.com');
    expect(serialized).not.toContain('security-noreply');
  });

  it('describes the display name by shape rather than including it', () => {
    expect(serialized).not.toContain('Microsoft Account Team');
    expect(payload.senderNameShape).toContain('three-words');
  });

  it('reduces links to registrable domains, dropping paths that carry recipient identifiers', () => {
    expect(payload.linkDomains).toEqual(['account-verify.example']);
    expect(serialized).not.toContain('8f3a9c2b');
    expect(serialized).not.toContain('uid=');
  });

  it('reduces attachments to extensions, dropping filenames that name people and cases', () => {
    expect(payload.attachmentExtensions).toEqual(['xlsx']);
    expect(serialized).not.toContain('Okonkwo');
    expect(serialized).not.toContain('Northwind_Payroll');
  });

  it('redacts addresses that appear inside the body, keeping only their domains', () => {
    expect(payload.bodyExcerpt).not.toContain('jane.okonkwo@');
    expect(payload.bodyExcerpt).not.toContain('help@');
    expect(payload.bodyExcerpt).toContain('<address@northwind-logistics.com>');
  });

  it('keeps the Reply-To domain, which is load-bearing for the analysis', () => {
    expect(payload.replyToDomain).toBe('mailbox-relay.example');
  });

  it('carries no identifiers that would let a backend correlate a mailbox across requests', () => {
    for (const forbidden of ['messageId', 'threadId', 'recipientEmail', 'senderEmail', 'senderName']) {
      expect(payload).not.toHaveProperty(forbidden);
    }
  });

  it('bounds every field, so payload size does not scale with message size', () => {
    const huge = buildCloudPayload(
      {
        senderEmail: 'a@example.com',
        subject: 'x'.repeat(5000),
        bodyText: 'y'.repeat(500_000),
        links: Array.from({ length: 400 }, (_v, i) => ({
          text: 't',
          href: `https://d${String(i)}.example/`,
          normalizedDomain: `d${String(i)}.example`,
        })),
        attachments: Array.from({ length: 100 }, (_v, i) => ({
          filename: `f${String(i)}.pdf`,
          extension: `ext${String(i)}`,
        })),
      },
      Array.from({ length: 200 }, (_v, i) => `signal.${String(i)}`),
    );

    expect(huge.subject.length).toBeLessThanOrEqual(300);
    expect(huge.bodyExcerpt.length).toBeLessThanOrEqual(4200);
    expect(huge.linkDomains.length).toBeLessThanOrEqual(25);
    expect(huge.attachmentExtensions.length).toBeLessThanOrEqual(15);
    expect(huge.deterministicSignalIds.length).toBeLessThanOrEqual(40);
  });

  it('produces a payload whose every field is inspectable in the options UI wording', () => {
    // The options page promises "subject, a body excerpt, and domains". Assert the shape matches the
    // promise, so the two cannot drift apart.
    expect(Object.keys(payload).sort()).toEqual(
      [
        'attachmentExtensions',
        'bodyExcerpt',
        'deterministicSignalIds',
        'linkDomains',
        'replyToDomain',
        'senderDomain',
        'senderNameShape',
        'subject',
      ].sort(),
    );
  });
});

/**
 * `EmailMessage.raw` holds un-normalised header values so that formatting detectors can see evidence
 * normalisation destroys. It is the least redacted data in the message, so it must never reach the
 * payload. `buildCloudPayload` uses an explicit allowlist, which is what makes this hold; these tests
 * exist so that a future refactor to spreading the email fails here.
 */
describe('buildCloudPayload never forwards raw header values', () => {
  const email = {
    senderName: 'Northwind Life Offer',
    senderEmail: 'donot.reply.donot.reply@kv38mailer.com',
    subject: 'YOUR QUOTE IS READY',
    bodyText: 'Body text.',
    links: [],
    attachments: [],
    raw: {
      senderEmail: 'DoNoT.rEpLy.DoNoT.rEpLy@kv38mailer.com',
      subject: `YOUR QUOTE IS READY${' '.repeat(40)}`,
    },
  };
  const payload = buildCloudPayload(email, []);
  const serialized = JSON.stringify(payload);

  it('omits the raw slot entirely', () => {
    expect(payload).not.toHaveProperty('raw');
    expect(serialized).not.toContain('DoNoT');
  });

  it('forwards no padding, only the collapsed subject', () => {
    expect(serialized).not.toMatch(/ {4}/u);
  });

  it('still forwards the fields it is supposed to', () => {
    expect(payload.senderDomain).toBe('kv38mailer.com');
    expect(payload.subject).toBe('YOUR QUOTE IS READY');
  });
});

describe('redactAddresses', () => {
  it('keeps the domain and drops the local part', () => {
    expect(redactAddresses('Write to alice.smith+tag@example.co.uk today')).toBe(
      'Write to <address@example.co.uk> today',
    );
  });

  it('redacts every occurrence, not just the first', () => {
    const redacted = redactAddresses('a@x.example and b@y.example and c@x.example');
    expect(redacted).not.toMatch(/\ba@|\bb@|\bc@/u);
    expect(redacted).toContain('<address@x.example>');
    expect(redacted).toContain('<address@y.example>');
  });

  it('leaves text without addresses untouched', () => {
    expect(redactAddresses('No addresses here at all.')).toBe('No addresses here at all.');
  });

  it('redacts a local part written outside ASCII', () => {
    expect(redactAddresses('Contact josé.müller@example.de now')).toBe('Contact <address@example.de> now');
  });
});

describe('cloud payload redaction at the edges of what is kept', () => {
  const base = { senderEmail: 'a@example.com', links: [], attachments: [] };

  it('redacts an address the body cut would otherwise split', () => {
    // Cut first, this would end in `jane.doe@example`: no dot after the @, so no longer an address.
    const bodyText = `${'x '.repeat(1994)}jane.doe@example.co.uk and more`;
    const payload = buildCloudPayload({ ...base, subject: 's', bodyText }, []);
    expect(payload.bodyExcerpt).not.toContain('jane.doe');
  });

  it('redacts addresses in the subject as well as the body', () => {
    const payload = buildCloudPayload(
      { ...base, subject: 'Re: invoice for sam.okafor@northwind-logistics.com', bodyText: 'b' },
      [],
    );
    expect(payload.subject).not.toContain('sam.okafor');
    expect(payload.subject).toContain('<address@northwind-logistics.com>');
  });
});

describe('describeNameShape', () => {
  it.each([
    ['', 'empty'],
    ['Jane', 'one-word'],
    ['Jane Okonkwo', 'two-words'],
  ])('describes %o as %s', (input, expected) => {
    expect(describeNameShape(input)).toBe(expected);
  });

  it('notes impersonation-relevant shape without revealing the name', () => {
    const shape = describeNameShape('Microsoft Account Team');
    expect(shape).toContain('role-account');
    expect(shape).not.toContain('Microsoft');
  });

  it('notes an address embedded in a display name, a common spoofing trick', () => {
    expect(describeNameShape('security@microsoft.com')).toContain('contains-address');
  });

  it('notes non-ASCII characters, which is where homoglyph names live', () => {
    expect(describeNameShape('Аpple Support')).toContain('non-ascii');
  });

  it('collapses an unbounded name to a bounded description', () => {
    expect(describeNameShape('word '.repeat(1000)).length).toBeLessThan(60);
  });
});

/**
 * The builder is not where the guarantee lives. It runs in the content script; the service worker is what
 * opens the socket, and it is handed the built payload over a runtime message. So every assertion above
 * describes a function the network never sees the output of directly, and a caller that skipped it (a
 * compromised content script, or any other surface able to reach `sendMessage`) could have posted an
 * unredacted mailbox while all of those tests still passed.
 *
 * These assert the same contract at the egress point, against payloads the builder could not have
 * produced.
 */
describe('sanitizeCloudPayload: the contract re-imposed where the request is made', () => {
  it('reduces a smuggled full address to its domain', () => {
    const payload = sanitizeCloudPayload({
      ...buildCloudPayload(RICH_EMAIL, []),
      senderDomain: 'security-noreply@rnicrosoft-online.com',
    });

    expect(payload?.senderDomain).toBe('');
    expect(JSON.stringify(payload)).not.toContain('security-noreply');
  });

  it('re-redacts addresses in a body excerpt that arrived with them intact', () => {
    const payload = sanitizeCloudPayload({
      ...buildCloudPayload(RICH_EMAIL, []),
      bodyExcerpt: 'Contact jane.okonkwo@northwind-logistics.com to confirm.',
    });

    expect(payload?.bodyExcerpt).not.toContain('jane.okonkwo@');
    expect(payload?.bodyExcerpt).toContain('<address@northwind-logistics.com>');
  });

  it('refuses a display name arriving in the field that exists to carry none', () => {
    const payload = sanitizeCloudPayload({
      ...buildCloudPayload(RICH_EMAIL, []),
      senderNameShape: 'Microsoft Account Team',
    });

    expect(payload?.senderNameShape).toBe('unknown');
    expect(JSON.stringify(payload)).not.toContain('Microsoft Account Team');
  });

  it('drops the subdomains a link domain can use to name a recipient', () => {
    const payload = sanitizeCloudPayload({
      ...buildCloudPayload(RICH_EMAIL, []),
      linkDomains: ['jane-okonkwo.tracking.account-verify.example'],
    });

    expect(payload?.linkDomains).toEqual(['account-verify.example']);
  });

  it('bounds fields that arrived unbounded', () => {
    const payload = sanitizeCloudPayload({
      ...buildCloudPayload(RICH_EMAIL, []),
      subject: 'x'.repeat(5000),
      bodyExcerpt: 'y'.repeat(500_000),
      linkDomains: Array.from({ length: 400 }, (_v, i) => `d${String(i)}.example`),
      attachmentExtensions: Array.from({ length: 100 }, (_v, i) => `ext${String(i)}`),
      deterministicSignalIds: Array.from({ length: 400 }, (_v, i) => `content.urgency.${String(i)}`),
    });

    expect(payload?.subject.length).toBeLessThanOrEqual(300);
    expect(payload?.bodyExcerpt.length).toBeLessThanOrEqual(4000);
    expect(payload?.linkDomains.length).toBeLessThanOrEqual(25);
    expect(payload?.attachmentExtensions.length).toBeLessThanOrEqual(15);
    expect(payload?.deterministicSignalIds.length).toBeLessThanOrEqual(40);
  });

  it('adds no field of its own, whatever it was given', () => {
    const payload = sanitizeCloudPayload({
      ...buildCloudPayload(RICH_EMAIL, []),
      recipientEmail: 'jane.okonkwo@northwind-logistics.com',
      messageId: 'thread-18f2a',
      raw: { senderEmail: 'DoNoT.rEpLy@kv38mailer.com' },
    });

    for (const forbidden of ['recipientEmail', 'messageId', 'raw', 'senderEmail', 'senderName']) {
      expect(payload).not.toHaveProperty(forbidden);
    }
    // The domain survives inside the body's redacted placeholder, which is deliberate; the address does not.
    expect(JSON.stringify(payload)).not.toContain('jane.okonkwo@northwind-logistics.com');
    expect(JSON.stringify(payload)).not.toContain('thread-18f2a');
  });

  // An array included on purpose: it is an object to `typeof`, and reading fields off one yields a
  // payload of empty strings rather than a refusal, which is a request worth not making.
  it('refuses anything that is not a payload at all', () => {
    for (const value of [null, undefined, 'a string', 42, [], () => undefined]) {
      expect(sanitizeCloudPayload(value)).toBeNull();
    }
  });
});

describe('redaction against real fixtures', () => {
  it.each(['legitimate', 'microsoft-phish', 'bec-gift-card', 'legitimate-invoice'])(
    'leaks no full email address for %s',
    (name) => {
      const email = loadFixture(name).email;
      const serialized = JSON.stringify(buildCloudPayload(email, []));

      // Placeholders are removed first, since `<address@example.com>` is the redacted form and would
      // otherwise match the pattern we are looking for.
      const withoutPlaceholders = serialized.replace(/<address@[\w.-]+>/gu, '');
      expect(withoutPlaceholders).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/u);
      if (email.senderEmail !== undefined) {
        expect(serialized).not.toContain(email.senderEmail);
      }
    },
  );
});
