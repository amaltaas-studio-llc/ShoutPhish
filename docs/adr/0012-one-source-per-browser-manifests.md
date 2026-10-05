# 0012. One source tree; a manifest per browser family, chosen at build time

**Status:** Accepted

## Context

Chromium browsers (Chrome, Edge, Brave, Opera, Vivaldi) load the same package unchanged. Firefox needs a
different manifest: it has no extension service worker and runs `background.scripts` as an event page,
signs only extensions that carry `browser_specific_settings.gecko.id`, and requires new extensions to
declare what data they transmit. The code itself already ports: every `chrome.*` call uses promises,
which Firefox and Safari both accept in Manifest V3, and Gmail's markup is the same in every desktop
browser.

## Decision

- `scripts/build.mjs --target=firefox` builds the same sources into `dist-firefox/`, shallow-merging
  `src/manifest.firefox.json` over `src/manifest.json`. The Chromium build stays in `dist/`, so every path
  that loads or packages it is unchanged.
- `__SHOUTPHISH_TARGET__` (`src/shared/target.ts`) is the only runtime difference, and gates one thing:
  Firefox's data-collection consent. It is a build constant rather than feature detection because Chrome
  rejects the key outright, so probing would mean calling the API wrongly in one browser to find out which
  one this is.
- Firefox's declaration is `required: ["none"]`, `optional: ["personalCommunications"]`. A default install
  sends nothing anywhere, so nothing is required. Connecting a model server sends message text outside the
  browser (another process counts, even on loopback), so that consent is requested on the same Connect
  click as the host permission, and the worker checks both before every request
  (`src/shared/egress-permissions.ts`). The minimum is Firefox 142, the first release with built-in consent on
  both desktop and Android, so no older version needs a consent screen of ShoutPhish's own. Desktop has
  it from 140, but the floor covers Android too unless a `gecko_android` key overrides it, and that key
  lists the add-on for Android on addons.mozilla.org ([0015](0015-firefox-listed-on-amo.md)).
- `check-dist --target=firefox` pins `browser_specific_settings` to the overlay and forbids a
  `service_worker`; CI also runs Mozilla's `web-ext lint` on the Firefox build.
- Any browser can withhold the Gmail host permission (Firefox asks for it separately; Chrome's site-access
  menu can restrict it), so the popup has a `no-gmail-access` state that says nothing is checked and offers
  to ask again, rather than "nothing to check here".

## Consequences

- One codebase, one test suite. The detection engine never learns which browser it runs in.
- `npm run verify` builds and checks both packages.
- Firefox users cannot keep an unsigned build installed on release Firefox, so releases carry a build
  signed through addons.mozilla.org ([0013](0013-firefox-signed-unlisted.md)). The gecko ID is permanent
  once the first version is signed.

## Rejected alternatives

- **`webextension-polyfill`**: unnecessary in Manifest V3, where `chrome.*` already returns promises in
  every target, and it would be the project's first runtime dependency ([0001](0001-esbuild-not-vite.md)).
- **WXT or Plasmo**: they generate per-browser manifests well, but replace the esbuild build that 0001
  chose and bring a framework, which [0008](0008-no-ui-framework-shadow-dom.md) rejects for the UI.
- **One manifest with both `service_worker` and `scripts`**: Chrome 121+ and Firefox 121+ accept it, but
  `browser_specific_settings` and the data declaration would ship to Chrome, and check-dist could no longer
  say which keys each browser is promised.
- **Detecting Firefox at runtime**: see the second decision.
