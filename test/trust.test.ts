/**
 * Trusted senders.
 *
 * An allowlist in a phishing tool is a spoofing hole waiting to happen, so these tests are written from
 * the attacker's side: every case asks what a trust entry can be made to do to a message the user did not
 * mean it to cover. The three properties they exist to hold are that trust needs cryptographic proof of
 * origin, that it never touches a technical finding, and that it never removes anything.
 */
import { describe, expect, it } from 'vitest';
import { analyzeDeterministic } from '../src/analysis/engine.js';
import { buildContext } from '../src/analysis/context.js';
import { MAX_TRUSTED_SENDERS, normalizeTrustList } from '../src/shared/settings.js';
import {
  isSenderProven,
  matchingTrustEntry,
  trustEntryFor,
  trustState,
  withTrustedSender,
  withoutTrustedSender,
} from '../src/shared/trust.js';
import type {
  AnalysisResult,
  EmailAuthInfo,
  EmailMessage,
  SecuritySignal,
} from '../src/shared/types.js';
import { loadAllFixtures, loadFixture, toEmailLink } from './fixtures/load.js';

const FIXED_NOW = 1_760_000_000_000;

function signalFor(result: AnalysisResult, id: string): SecuritySignal | undefined {
  return result.signals.find((s) => s.id === id);
}

const PROVEN: EmailAuthInfo = {
  spf: 'pass',
  dkim: 'pass',
  dmarc: 'pass',
  signedBy: 'ledgerworks-billing.com',
  mailedBy: 'ledgerworks-billing.com',
};

/**
 * Ordinary mail from an organisation no brand table contains, worded the way a real service notice is
 * worded. The wording is what trust is allowed to quieten, so it has to be present for the tests that
 * assert dampening to mean anything.
 */
const routine: EmailMessage = {
  senderName: 'Ledgerworks Billing',
  senderEmail: 'notices@ledgerworks-billing.com',
  recipientEmail: 'sam.okafor@northwind-logistics.com',
  subject: 'Action required: confirm your billing details before Friday',
  bodyText:
    'Your billing details need to be confirmed before Friday or invoicing for next month will be suspended. Please verify your account details by signing in to the billing portal.',
  links: [toEmailLink({ text: 'Billing portal', href: 'https://ledgerworks-billing.com/portal' })],
  attachments: [],
  auth: PROVEN,
  raw: {
    senderEmail: 'notices@ledgerworks-billing.com',
    subject: 'Action required: confirm your billing details before Friday',
  },
};

function score(email: EmailMessage, trustedSenders: readonly string[] = []): number {
  return analyzeDeterministic(email, { now: FIXED_NOW, trustedSenders }).score;
}

// ---------------------------------------------------------------------------
// What an entry covers
// ---------------------------------------------------------------------------

describe('trustEntryFor', () => {
  it('offers the registrable domain for an organisation', () => {
    // Not the sending host: real mail moves between `email.`, `mail.` and `notifications.` subdomains.
    expect(trustEntryFor('notices@mail.ledgerworks-billing.com')).toBe(
      'ledgerworks-billing.com',
    );
  });

  it('offers only the single address on a shared mailbox host', () => {
    // Trusting `gmail.com` as a domain would mean trusting everybody who has an account there.
    expect(trustEntryFor('tom@gmail.com')).toBe('tom@gmail.com');
    expect(trustEntryFor('tom@outlook.com')).toBe('tom@outlook.com');
  });

  it('offers nothing for a disposable mailbox', () => {
    expect(trustEntryFor('someone@mailinator.com')).toBeNull();
  });

  it('offers nothing for input that is not an address', () => {
    expect(trustEntryFor('')).toBeNull();
    expect(trustEntryFor('not-an-address')).toBeNull();
    expect(trustEntryFor(`${'a'.repeat(300)}@example.com`)).toBeNull();
  });

  it("offers a shared platform tenant's own host, never the platform", () => {
    expect(trustEntryFor('support@northwind.zendesk.com')).toBe('northwind.zendesk.com');
    expect(trustEntryFor('it@northwind.onmicrosoft.com')).toBe('northwind.onmicrosoft.com');
  });
});

describe('matchingTrustEntry', () => {
  it("does not let one tenant of a shared platform inherit another's trust", () => {
    expect(matchingTrustEntry(['northwind.zendesk.com'], 'help@northwind.zendesk.com')).toBe(
      'northwind.zendesk.com',
    );
    expect(matchingTrustEntry(['northwind.zendesk.com'], 'help@northwlnd.zendesk.com')).toBeUndefined();
    // An entry naming the platform itself trusts nobody, rather than every tenant.
    expect(matchingTrustEntry(['zendesk.com'], 'help@northwind.zendesk.com')).toBeUndefined();
  });

  it('matches a domain entry across subdomains and an address entry exactly', () => {
    expect(matchingTrustEntry(['ledgerworks-billing.com'], 'x@mail.ledgerworks-billing.com')).toBe(
      'ledgerworks-billing.com',
    );
    expect(matchingTrustEntry(['tom@gmail.com'], 'tom@gmail.com')).toBe('tom@gmail.com');
    expect(matchingTrustEntry(['tom@gmail.com'], 'tom.other@gmail.com')).toBeUndefined();
  });

  it('does not match a lookalike of a trusted domain', () => {
    expect(
      matchingTrustEntry(['ledgerworks-billing.com'], 'x@ledgerworks-biIling.com'),
    ).toBeUndefined();
    expect(
      matchingTrustEntry(['ledgerworks-billing.com'], 'x@ledgerworks-billing.com.attacker.test'),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Proof of origin
// ---------------------------------------------------------------------------

describe('isSenderProven', () => {
  it('accepts DMARC pass, and DKIM signed by the sender itself', () => {
    expect(isSenderProven(PROVEN, 'ledgerworks-billing.com')).toBe(true);
    expect(
      isSenderProven(
        { dkim: 'pass', signedBy: 'ledgerworks-billing.com' },
        'mail.ledgerworks-billing.com',
      ),
    ).toBe(true);
  });

  it('rejects SPF alone', () => {
    // SPF authenticates the envelope, not the From header, so it passes for mail that merely claims the
    // address: the exact case this gate exists to exclude.
    expect(isSenderProven({ spf: 'pass' }, 'ledgerworks-billing.com')).toBe(false);
  });

  it('rejects DKIM signed by somebody else', () => {
    expect(
      isSenderProven({ dkim: 'pass', signedBy: 'bulk-sender.test' }, 'ledgerworks-billing.com'),
    ).toBe(false);
  });

  it('rejects an absent or failing details table', () => {
    expect(isSenderProven(undefined, 'ledgerworks-billing.com')).toBe(false);
    expect(isSenderProven({}, 'ledgerworks-billing.com')).toBe(false);
    expect(isSenderProven({ dmarc: 'pass', spf: 'fail' }, 'ledgerworks-billing.com')).toBe(false);
  });

  /**
   * The shape the DOM adapter actually produces, and the reason a gate demanding more would reject every
   * message in existence: named `dkim`/`dmarc` verdicts are scraped from a tooltip most Gmail builds do not
   * carry, so a real message arrives with a `signed-by` row and no verdict at all. Gmail only renders
   * that row for a signature it verified, so its presence is the verdict.
   */
  it('accepts an aligned signed-by row with no named verdict', () => {
    expect(
      isSenderProven(
        { spf: 'pass', signedBy: 'ledgerworks-billing.com', mailedBy: 'ledgerworks-billing.com' },
        'mail.ledgerworks-billing.com',
      ),
    ).toBe(true);
  });

  it('still requires the signature to align', () => {
    expect(isSenderProven({ signedBy: 'bulk-sender.test' }, 'ledgerworks-billing.com')).toBe(false);
    expect(isSenderProven({ mailedBy: 'ledgerworks-billing.com' }, 'ledgerworks-billing.com')).toBe(
      false,
    );
  });

  it('lets an explicit non-pass verdict overrule the row', () => {
    // A scraped verdict is better evidence than the row's presence, in the one direction that matters.
    for (const dkim of ['neutral', 'softfail', 'none'] as const) {
      expect(isSenderProven({ dkim, signedBy: 'ledgerworks-billing.com' }, 'ledgerworks-billing.com')).toBe(
        false,
      );
    }
  });

  it('rejects a sender Gmail itself could not verify', () => {
    // The `?` avatar is Gmail saying it failed to establish the sender. Nothing else on the page
    // outranks that, including a signature that happens to align.
    expect(
      isSenderProven(
        { signedBy: 'ledgerworks-billing.com', unauthenticatedIndicator: true },
        'ledgerworks-billing.com',
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// What trust does to a score
// ---------------------------------------------------------------------------

describe('trust and scoring', () => {
  const entry = 'ledgerworks-billing.com';

  it('weights down wording findings on a proven message', () => {
    const before = score(routine);
    const after = score(routine, [entry]);
    expect(before).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
  });

  it('keeps every finding visible', () => {
    const before = analyzeDeterministic(routine, { now: FIXED_NOW });
    const after = analyzeDeterministic(routine, { now: FIXED_NOW, trustedSenders: [entry] });

    expect(after.signals.map((s) => s.id).sort()).toEqual(before.signals.map((s) => s.id).sort());
    expect(after.signals.some((s) => s.dampened === true)).toBe(true);
  });

  it('explains itself by naming the entry', () => {
    const after = analyzeDeterministic(routine, { now: FIXED_NOW, trustedSenders: [entry] });
    const dampened = after.signals.find((s) => s.dampened === true);
    expect(dampened?.description).toContain(entry);
  });

  it('does nothing when the message was not proven to come from the trusted domain', () => {
    // The spoof case: the From address is right and nothing authenticated it, which is what a forgery
    // looks like. An allowlist that applied here would be an instruction to ignore forgeries.
    const spoofed: EmailMessage = { ...routine, auth: { spf: 'pass' } };
    expect(score(spoofed, [entry])).toBe(score(spoofed));
  });

  it('does nothing for a lookalike of the trusted domain', () => {
    const lookalike: EmailMessage = {
      ...routine,
      senderEmail: 'notices@ledgerworks-biIling.com',
      auth: { ...PROVEN, signedBy: 'ledgerworks-biIling.com', mailedBy: 'ledgerworks-biIling.com' },
    };
    expect(score(lookalike, [entry])).toBe(score(lookalike));
  });

  it('is cancelled outright by a technical finding', () => {
    // A trusted sender whose mail now points somewhere else is the compromised-account case, and it is
    // the one case where the user's say-so must count for nothing.
    const withBadLink: EmailMessage = {
      ...routine,
      links: [
        toEmailLink({
          text: 'ledgerworks-billing.com',
          href: 'https://ledgerworks-billing.com.attacker.test/login',
        }),
      ],
    };
    expect(score(withBadLink, [entry])).toBe(score(withBadLink));
  });

  it('never softens a high or critical finding', () => {
    const shouting: EmailMessage = {
      ...routine,
      subject: 'Send the gift card codes now',
      bodyText:
        'I need you to buy five gift cards for a client today and send me the codes as soon as you have them. Keep this between us until the deal closes.',
      links: [],
    };
    const trusted = analyzeDeterministic(shouting, { now: FIXED_NOW, trustedSenders: [entry] });
    for (const signal of trusted.signals) {
      if (signal.severity === 'high' || signal.severity === 'critical') {
        expect(signal.dampened ?? false).toBe(false);
      }
    }
  });

  it('cannot lower a malicious fixture out of its band', { timeout: 15_000 }, () => {
    // Trusting the sender of every malicious fixture at once, with proof forged in the fixture's favour:
    // the strongest thing a user could do to their own protection.
    for (const fixture of loadAllFixtures()) {
      const email: EmailMessage = { ...fixture.email, auth: { ...fixture.email.auth, dmarc: 'pass' } };
      const baseline = analyzeDeterministic(email, { now: FIXED_NOW });
      if (baseline.classification === 'low') continue;

      const entryFor = trustEntryFor(email.senderEmail ?? '');
      const trusted = analyzeDeterministic(email, {
        now: FIXED_NOW,
        trustedSenders: entryFor === null ? [] : [entryFor],
      });
      expect(trusted.classification, `${fixture.name} dropped to ${trusted.classification}`).not.toBe(
        'low',
      );
    }
  });

  it('reaches the rule engine as context', () => {
    const context = buildContext(routine, { trustedSenders: ['ledgerworks-billing.com'] });
    expect(context.senderTrusted).toBe(true);
    expect(context.senderProven).toBe(true);
    expect(context.trustedEntry).toBe('ledgerworks-billing.com');

    const untrusted = buildContext(routine, {});
    expect(untrusted.senderTrusted).toBe(false);
    expect(untrusted.trustedEntry).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// What the card offers
// ---------------------------------------------------------------------------

describe('trustState', () => {
  it('offers trust on a proven, low-scoring message', () => {
    expect(trustState([], routine.senderEmail ?? '', PROVEN, 'low')).toEqual({
      kind: 'offer',
      entry: 'ledgerworks-billing.com',
    });
  });

  it('does not offer trust while the message is suspicious', () => {
    // The moment to allowlist a sender is not while looking at a message just called suspicious, which
    // is also the one click an attacker would most like to provoke.
    expect(trustState([], routine.senderEmail ?? '', PROVEN, 'suspicious').kind).toBe('none');
    expect(trustState([], routine.senderEmail ?? '', PROVEN, 'high-risk').kind).toBe('none');
  });

  it('does not offer trust on mail nothing authenticated', () => {
    expect(trustState([], routine.senderEmail ?? '', { spf: 'pass' }, 'low').kind).toBe('none');
  });

  it('reports trust that could not be applied', () => {
    expect(trustState(['ledgerworks-billing.com'], routine.senderEmail ?? '', { spf: 'pass' }, 'low')).toEqual(
      { kind: 'unproven', entry: 'ledgerworks-billing.com' },
    );
  });

  it('reports trust that was applied, whatever the score came out as', () => {
    // Removing the control from a message that scored badly would leave a user unable to undo trust from
    // the only place that names it.
    expect(trustState(['ledgerworks-billing.com'], routine.senderEmail ?? '', PROVEN, 'high-risk')).toEqual(
      { kind: 'trusted', entry: 'ledgerworks-billing.com' },
    );
  });

  it('stops offering once the list is full', () => {
    const full = Array.from({ length: MAX_TRUSTED_SENDERS }, (_, i) => `sender-${String(i)}.example`);
    expect(trustState(full, routine.senderEmail ?? '', PROVEN, 'low').kind).toBe('none');
  });
});

/**
 * Brand ownership is not mailbox authority.
 *
 * `gmail.com` belongs to Google, which is why `gmai1.com` can be reported as a lookalike, and it is also
 * where a billion individuals keep their mail. Reading ownership as "this sender is a verified brand"
 * would therefore hand brand dampening to every personal account at every consumer provider, quartering
 * the one category that carries "send me your code" and zeroing its combinations. Asserted through scores
 * rather than through the flag, because the flag is not what the user sees.
 */
describe('a consumer mailbox at a brand-owned domain', () => {
  const asking = (senderEmail: string): AnalysisResult =>
    analyzeDeterministic(
      {
        senderName: 'Alice Chen',
        senderEmail,
        recipientEmail: 'sam@northwind-logistics.com',
        subject: 'Quick favour',
        bodyText:
          'Hi, I am locked out of my account. Please send me your verification code as soon as it arrives. It is urgent.',
        links: [],
        attachments: [],
      },
      { now: FIXED_NOW },
    );

  it('is scored exactly as the same message from a domain nobody has enumerated', () => {
    const fromGmail = asking('alice.chen.1984@gmail.com');
    const fromElsewhere = asking('alice.chen.1984@mail.northwind-unrelated.com');

    expect(fromGmail.score).toBe(fromElsewhere.score);
    expect(fromGmail.classification).toBe(fromElsewhere.classification);
  });

  it('keeps the request finding at full weight', () => {
    const signal = signalFor(asking('alice.chen.1984@gmail.com'), 'content.mfa_request');
    expect(signal?.severity).toBe('high');
    expect(signal?.dampened).toBeUndefined();
  });

  /** The impersonation case: claiming the brand whose mail service you happen to be a customer of. */
  it('gets no dampening from claiming the brand that owns its own domain', () => {
    const result = analyzeDeterministic(
      {
        senderName: 'Google Security',
        senderEmail: 'google.security.team.2026@gmail.com',
        recipientEmail: 'sam@northwind-logistics.com',
        subject: 'Critical security alert',
        bodyText:
          'We detected unusual activity on your account and have restricted access. Reply to this email with the verification code we just sent you to confirm your identity and restore access immediately.',
        links: [],
        attachments: [],
      },
      { now: FIXED_NOW },
    );

    expect(result.signals.filter((s) => s.dampened === true)).toEqual([]);
    expect(result.classification).not.toBe('low');
  });

  /**
   * The other direction. Without brand dampening every personal message scores on its wording alone, so
   * ordinary correspondence has to stay quiet on its own merits.
   */
  it('leaves ordinary personal mail alone', () => {
    const result = analyzeDeterministic(
      {
        senderName: 'Alice Chen',
        senderEmail: 'alice.chen.1984@gmail.com',
        recipientEmail: 'sam@northwind-logistics.com',
        subject: 'Saturday',
        bodyText:
          'Thanks for sorting the tickets out. I will bring the cake and Dan is bringing the drinks, so there is nothing left for you to do. See you at seven.',
        links: [],
        attachments: [],
      },
      { now: FIXED_NOW },
    );

    expect(result.classification).toBe('low');
    expect(result.signals.filter((s) => s.score > 0)).toEqual([]);
  });
});

/**
 * Brand dampening needs the same proof of origin that trust needs.
 *
 * A From header is a claim, not evidence, and forging a famous one is the attack this whole extension is
 * about. Dampening on the domain alone would therefore reward exactly the mail it should punish: "send me
 * your verification code" from a `paypal.com` address that nothing ties to PayPal would come out Low Risk,
 * the most reassuring thing the extension can say, on a message whose sender is unverified and whose request
 * is the request no real organisation makes.
 *
 * Asserted through the score and through `dampened`, in both directions, because the useful half is that
 * genuine brand mail still gets the benefit: a gate this easy to over-tighten would quietly make the
 * feature unreachable, as a trust gate demanding named verdicts does.
 */
describe('brand dampening and proof of origin', () => {
  const impersonation: EmailMessage = {
    senderName: 'PayPal Security',
    senderEmail: 'security@paypal.com',
    recipientEmail: 'sam.okafor@northwind-logistics.com',
    subject: 'Verify your account',
    bodyText:
      'We detected unusual activity on your account. Please send me your verification code so we can confirm your identity and restore access immediately.',
    links: [],
    attachments: [],
  };

  const PROVEN_BRAND: EmailAuthInfo = {
    spf: 'pass',
    dkim: 'pass',
    dmarc: 'pass',
    signedBy: 'paypal.com',
    mailedBy: 'paypal.com',
  };

  it('does not dampen a message nothing ties to the brand it came from', () => {
    const result = analyzeDeterministic(impersonation, { now: FIXED_NOW });

    expect(result.signals.filter((s) => s.dampened === true)).toEqual([]);
    expect(result.classification).not.toBe('low');
    expect(signalFor(result, 'content.mfa_request')?.severity).toBe('high');
  });

  // The genuine shape: a security notice asking the reader to verify, with no link anywhere else.
  const notice: EmailMessage = {
    ...impersonation,
    bodyText:
      'We detected unusual activity on your account. Please verify your account to confirm your identity and restore access immediately.',
  };

  it('dampens a security notice when Gmail proved the sender', () => {
    const unproven = analyzeDeterministic(notice, { now: FIXED_NOW });
    const result = analyzeDeterministic({ ...notice, auth: PROVEN_BRAND }, { now: FIXED_NOW });

    expect(unproven.signals.filter((s) => s.dampened === true)).toEqual([]);
    expect(signalFor(result, 'content.credential_verification')?.dampened).toBe(true);
    expect(result.classification).toBe('low');
  });

  it('accepts an aligned signed-by row on its own, as the trust gate does', () => {
    // The only authentication evidence most Gmail builds actually render. A gate needing more than this is
    // a gate that never fires in production while passing every test here.
    const result = analyzeDeterministic({ ...notice, auth: { signedBy: 'paypal.com' } }, { now: FIXED_NOW });

    expect(signalFor(result, 'content.credential_verification')?.dampened).toBe(true);
  });

  it('never softens a high finding, however well the brand is proven', () => {
    // Asking for the code is the request no real organisation makes, and a genuine signature is what a
    // compromised brand mailbox produces, so the reason trust keeps `high` at full weight applies here too.
    const result = analyzeDeterministic({ ...impersonation, auth: PROVEN_BRAND }, { now: FIXED_NOW });
    const mfa = signalFor(result, 'content.mfa_request');

    expect(mfa?.severity).toBe('high');
    expect(mfa?.dampened).toBeUndefined();
    expect(result.classification).not.toBe('low');
  });

  it.each<[string, EmailAuthInfo]>([
    ['a failed DMARC', { spf: 'pass', dkim: 'pass', dmarc: 'fail', signedBy: 'paypal.com' }],
    ['a signature belonging to somebody else', { dkim: 'pass', signedBy: 'bulk-sender.example' }],
    ['an envelope and nothing more', { spf: 'pass', mailedBy: 'paypal.com' }],
    ["Gmail's own unauthenticated marker", { signedBy: 'paypal.com', unauthenticatedIndicator: true }],
  ])('refuses to dampen on %s', (_label, auth) => {
    const result = analyzeDeterministic({ ...impersonation, auth }, { now: FIXED_NOW });

    expect(result.signals.filter((s) => s.dampened === true)).toEqual([]);
    expect(result.classification).not.toBe('low');
  });
});

// ---------------------------------------------------------------------------
// Stored state
// ---------------------------------------------------------------------------

describe('normalizeTrustList', () => {
  it('lowercases, trims and deduplicates', () => {
    expect(normalizeTrustList([' Example.COM ', 'example.com'])).toEqual(['example.com']);
  });

  it('drops anything that is neither an address nor a domain', () => {
    expect(
      normalizeTrustList([
        'localhost',
        'a@b@example.com',
        '@example.com',
        'has space.example',
        'quote"example.com',
        '<script>.example',
        42,
        null,
        'ok.example',
      ]),
    ).toEqual(['ok.example']);
  });

  it('bounds the list', () => {
    const raw = Array.from({ length: MAX_TRUSTED_SENDERS + 20 }, (_, i) => `s${String(i)}.example`);
    expect(normalizeTrustList(raw)).toHaveLength(MAX_TRUSTED_SENDERS);
    expect(normalizeTrustList('not a list')).toEqual([]);
  });

  /**
   * The count and the per-entry length were each chosen against the 8 KB `storage.sync` item cap, but
   * together they permit about 13 KB, a write that fails and takes every other setting in the same item
   * with it. Absurd input, real consequence, and a quota error is the worst way to find out.
   */
  it('bounds the serialised size, not only the number of entries', () => {
    const long = `${'a'.repeat(240)}.example`;
    const raw = Array.from({ length: MAX_TRUSTED_SENDERS }, (_, i) => `s${String(i)}${long}`);
    const serialized = JSON.stringify(normalizeTrustList(raw));

    expect(serialized.length).toBeLessThan(8000);
    // Still accepts a realistic list of that size, which is what the bound must not cost.
    expect(
      normalizeTrustList(Array.from({ length: MAX_TRUSTED_SENDERS }, (_, i) => `sender${String(i)}.example`)),
    ).toHaveLength(MAX_TRUSTED_SENDERS);
  });
});

describe('withTrustedSender / withoutTrustedSender', () => {
  it('adds normalised and removes exactly', () => {
    const added = withTrustedSender(['a.example'], ' B.Example ');
    expect(added).toEqual(['a.example', 'b.example']);
    expect(withoutTrustedSender(added, 'B.EXAMPLE')).toEqual(['a.example']);
    expect(withoutTrustedSender(added, 'not-there.example')).toEqual(added);
  });
});

// ---------------------------------------------------------------------------
// The legitimate corpus, with nobody trusted
// ---------------------------------------------------------------------------

describe('an empty trust list changes nothing', () => {
  it('scores every fixture identically to no option at all', { timeout: 15_000 }, () => {
    for (const fixture of loadAllFixtures()) {
      const withOption = analyzeDeterministic(fixture.email, { now: FIXED_NOW, trustedSenders: [] });
      const without = analyzeDeterministic(fixture.email, { now: FIXED_NOW });
      expect(withOption.score, fixture.name).toBe(without.score);
    }
  });

  it('leaves a fixture untouched when the trusted entry belongs to someone else', () => {
    const invoice = loadFixture('legitimate-invoice').email;
    expect(score(invoice, ['somebody-else.example'])).toBe(score(invoice));
  });
});
