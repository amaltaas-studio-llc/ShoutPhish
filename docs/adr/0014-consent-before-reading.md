# 0014. Nothing in Gmail is read until the reader agrees on the welcome page

**Status:** Accepted

## Context

Until now an install started reading mail the moment Gmail loaded. The welcome page described what was
read, but agreement was implied by installing. The Chrome Web Store asks for more for an extension that
handles personal communications: a disclosure inside the product, before the data is handled, and an
affirmative action from the user. An install alone does not count. The project's own rule points the same
way: something that reads every message someone opens should have to be told to.

## Decision

- `analysisConsent` is a setting, `false` by default. Until it is true the content script registers its
  listeners and nothing else: no observer, no list marks, no model warm-up, no extraction.
- The only control that turns it on is the welcome page's **Start checking my mail** button, under a
  paragraph naming what is read. The popup links to that page rather than consenting itself, so agreement
  is always given beside the full account. The options page has a switch that turns it off or back on.
- A Gmail tab cannot set it. `TAB_WRITABLE_SETTINGS` admits only the trust list.
- Turning it on or off reaches an open Gmail tab through `storage.onChanged`. Starting needs no reload.
  Stopping tears down the badge, the card, the highlights and the list marks, and drops the model's
  readings.
- Without consent the worker paints `OFF` on the toolbar icon as the default for every tab, repainted on
  startup and on every settings change, and the popup shows a `not-started` state ahead of anything a tab
  reports.
- Stored settings that lack the key count as consent. This is decided in `normalizeSettings` on every read,
  not once in `onInstalled`.

## Consequences

- A store install shows nothing in Gmail until one click on the welcome page. Someone who closes that page
  unread finds an icon saying `OFF` and a popup that names the fix.
- Existing manual installs keep working across the update: they predate the setting, were reading mail
  under the disclosure they saw at install, and an update they never asked for should not quietly stop
  protecting them.
- While another synced browser still runs a version from before consent, its writes drop the key, and this
  browser reads that as agreement again, even if the reader had turned reading off here. That lasts only
  until the other browser updates. In that window the older version is reading mail regardless.
- A tab whose reading was stopped repaints `OFF` on its own tab, because a tab's own badge hides the
  worker's default.

## Rejected alternatives

- **Migrating once in `onInstalled` on `update`**: the seeding write there would store `false` first, and
  an older version on another synced browser rewrites the object without the key. A one-off migration is
  undone by that; reading the absence on every load is not.
- **Consenting from the popup**: it is too small to hold the account of what is read, and agreement
  should be given where that account is.
- **No indicator before consent**: an unstarted install would look exactly like a clean inbox, which is
  the false all-clear this project refuses everywhere else.
- **Treating a malformed stored value as agreement**: a value that is present but not a boolean is damage,
  not history, and agreement is never inferred from damage.
