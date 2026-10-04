# Development

## Requirements

Node.js **≥ 24** (declared in `package.json` `engines` and tested in CI), and Chrome or Edge
**≥ 120** or Firefox **≥ 140**.

```bash
npm install
npm run build          # Chromium build into dist/
npm run build:firefox  # Firefox build into dist-firefox/
```

Then load it:

- Chrome or Edge: `chrome://extensions` (or `edge://extensions`) → **Developer mode** → **Load unpacked**
  → select `dist/`.
- Firefox: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → select
  `dist-firefox/manifest.json`. It lasts until Firefox restarts: release Firefox keeps only signed
  extensions. Both builds come from the same sources; see
  [adr/0012](adr/0012-one-source-per-browser-manifests.md) for what differs.

## Commands

```bash
npm run dev          # esbuild watch; reload the extension in Chrome to pick up changes
npm run build        # production build to dist/
npm run build:dev    # unminified, inline sourcemaps, debug logging enabled
npm run build:firefox  # production build to dist-firefox/
npm run lint:firefox # Mozilla's web-ext lint on dist-firefox/, the check addons.mozilla.org runs
npm run clean        # remove dist/

npm run harness      # UI harness on http://127.0.0.1:5199 (see below)
npm run screenshots  # regenerate docs/assets/ from the harness
npm run eval -- <path>...  # score a corpus of stored mail (see "Measuring against real mail")
npm run eval:prompts # export paired prompt requests for a real-model comparison; contacts nothing

npm run typecheck    # tsc --noEmit
npm run lint         # eslint .
npm run lint:fix
npm test             # vitest run
npm run test:watch
npm run test:coverage

npm run verify       # lint, typecheck, test, build, dist check: the gate before committing

npm run smoke:browsers  # load the extension and harness in every installed browser (see "Browser smoke test")
npm run smoke:docker    # the same in Chromium and Firefox ESR in a container; needs only Docker
```

The icons are drawn by code: every build reruns `scripts/gen-icons.mjs` into `assets/icons/` and copies
them to `dist/icons/`, so what ships is reviewable as source rather than an opaque blob in a repository whose
whole value is being auditable. The PNGs in `assets/icons/` are committed as well, only because the README
displays `icon128.png` and GitHub can render nothing that is not in the repository. The generator is
deterministic, so a build leaves them unchanged; if `assets/icons/` shows a diff after building, the
generator changed and the regenerated icons belong in the same commit.

One generated *source* file is committed instead: `src/shared/tlds.ts`, the list of top-level domains IANA
has delegated, refreshed by hand with `node scripts/gen-tlds.mjs`. It is not part of the build, because a
build that reaches the network cannot be reproduced offline and a detection rule whose input changes
silently between builds is one nobody can review. Refreshing it is a visible diff.

## Project layout

```text
src/
  content/      orchestration: observe → extract → analyse → render. All state lives here.
                Also inbox-row markers and the session health log.
  background/   service worker: settings, model-server egress. Deliberately stateless.
  gmail/        DOM adapter + SPA observer. The only place that knows Gmail's markup.
  analysis/
    rules/      deterministic detectors: identity, link, attachment, content, authentication
                (wording packs under rules/languages/)
    scoring/    weights, ceilings, thresholds, and the pure aggregation function
    llm/        semantic layer: prompt, strict output parsing, on-device + cloud adapters
    triage.ts   the sender-only subset, for what an inbox row can honestly support
  ui/           badge, panel, highlighting. No framework; Shadow DOM; textContent only.
  popup/        the toolbar popup: verdict for the tab, AI status, extraction health
  options/      settings page
  welcome/      the page shown once on install
  shared/       types, URL/Unicode/brand primitives, settings, trust list, logging
harness/        development-only UI harness. Not shipped.
docs/           product and contributor docs; design history in docs/adr/
```

Data flows one way. `gmail/` produces an `EmailMessage`, `analysis/` turns it into an `AnalysisResult`,
`ui/` renders it. `analysis/` imports nothing from `gmail/` or `ui/` and touches no browser API, which is
why the whole detection engine runs under `vitest` in plain Node. Where to change what:
[ARCHITECTURE.md](ARCHITECTURE.md). Why not the obvious alternative: [adr/](adr/).

## Toolchain choices

| Choice | Why |
| --- | --- |
| TypeScript ES2022, `strict` | Plus `noUncheckedIndexedAccess` and `noPropertyAccessFromIndexSignature`, because most of this code indexes into structures derived from hostile input. |
| **esbuild**, not Vite | IIFE content script + ESM worker/options; no useful app-style HMR for Gmail-injected UI. See [adr/0001](adr/0001-esbuild-not-vite.md). |
| Vitest | ESM-native, no transform config, and fast enough that the fixture suite is usable as an inner-loop tool. |
| ESLint + `typescript-eslint` (`strictTypeChecked`) | Flags `any`, unused vars and floating promises, plus house rules that make the XSS posture mechanical rather than aspirational: no `eval`, and no HTML sink (`innerHTML`, `outerHTML`, `insertAdjacentHTML`, `createContextualFragment`, `setHTMLUnsafe`, `document.write`, `srcdoc`, `DOMParser`). Also mechanical: `fetch` only in `src/background/`, and no `chrome`, `document`, `window`, `navigator`, `localStorage` or `Date.now` in `src/analysis/`. |
| Zero runtime dependencies | `"dependencies": {}`. Everything shipped into the browser is in `src/` and can be read end to end. `jsdom` is a dev dependency for the few DOM tests. |

## The UI harness

The badge and card only exist injected into a Gmail message, so there is nothing an ordinary dev server can
preview and every UI state otherwise has to be reached by finding an email that produces it. The harness
closes that gap:

```bash
npm run harness   # http://127.0.0.1:5199
```

It mounts the **real** `Badge` and `Panel` against the **real** engine output for any fixture in
`test/fixtures/`, inside a deliberately minimal header mock. Every control is also a query parameter, so
each state is a link:

```text
?fixture=microsoft-phish   any file in test/fixtures/
?semantic=ready            ready | pending | skipped | unavailable | no-output | error | cancelled | off
?ai=local                  local | server | cloud | off: which analyzer the card names
?missing=none              none | sender | subject: a part the adapter could not read. `sender`
                           withholds the score and shows the "Not checked" card; `subject` must not
?trust=none                none | offer | trusted | unproven: the sender's trust state in the card
?view=full                 full (mock message) | card (card alone) | badges (one row per risk band)
                           | list (the whole corpus as an inbox, with the real row scanner over it)
?card=1                    open the explanation card
?bare=1                    hide the harness controls, for screenshots
?ms=4800                   how long the canned reading took, shown in the card's footer and as the
                           running counter while pending
?tall=1                    with view=card, lift the height cap to review the whole card in one image
```

`view=list` is worth singling out. The row markers' failure mode is not a wrong verdict but too many of
them, and no test can answer "would you leave this switched on", so the list renders every fixture as one
inbox, using markup that mirrors `SELECTORS.listRow` and its neighbours. A stale selector candidate shows
up here as a missing mark rather than as a passing test.

Fixtures are injected into the bundle by `scripts/harness.mjs`, so adding a fixture file is enough to make
it appear in the picker.

### Regenerating the screenshots

```bash
npm run harness      # in one terminal
npm run screenshots  # in another
```

`scripts/screenshots.mjs` drives headless Chrome (no Puppeteer or Playwright, since a browser automation
stack is a large amount of supply chain to own for a dozen PNGs) and overwrites `docs/assets/`. Set
`CHROME_PATH` if Chrome is somewhere unusual. Because the images are renders of the shipping components, a
UI change is one command away from being reflected in the README instead of silently outdating it.

## Testing

Tests run in plain Node: no Chrome, no Gmail, no network. A handful of files ask for a DOM and get it from
`jsdom`, which is why that is the only dev dependency here that is not build, lint or test tooling; see the
note below the table. `npm run test:coverage` uses `@vitest/coverage-v8`, which must stay on the same
version as `vitest`.

| File | Covers |
| --- | --- |
| `test/aggregate.test.ts` | The scoring functions in isolation: per-severity ceilings, category caps, `[0, 100]` clamping, and zero contribution from an empty category, which is the "no local model" path. |
| `test/detection.test.ts` | The full pipeline against the fixture corpus (including multilingual `northwind-*` lures, code deliveries and newsletters), invariants across all of them, and which message in a thread gets picked, including the forged-from-yourself cases that must *not* be skipped. |
| `test/languages.test.ts` | Language-pack structure: every theme id exists, patterns use Unicode boundaries and bounded gaps, diacritic folding keeps indices, gating stays off ordinary English, and after-verb negation reverses a solicitation. |
| `test/semantic.test.ts` | The containment guarantees, the calibration limits, and the unavailable / throwing / hanging / cancelled analyzer paths, including which status each reports. |
| `test/chrome-prompt.test.ts` | The on-device adapter against fakes for every API shape Chrome has shipped and every malformed shape it might, plus concurrency: a session fake that rejects overlapping prompts the way the real one does. Also the welcome page's state probe, its click-started download, and the input/output language declarations. |
| `test/url.test.ts` | Obfuscated IP forms, forged suffix boundaries, redirect chains, hostnames `new URL()` accepts but that cannot exist. |
| `test/unicode.test.ts` | Punycode decoding, script mixing, bidi tricks, confusable folding, bounded edit distance. |
| `test/privacy.test.ts` | Settings validation, the model-server URL policy from both directions (loopback `http:` yes, anything else no), and what `buildCloudPayload` **drops** as well as what it keeps, then the same contract again against payloads the builder could not have produced, because the worker is what actually sends. |
| `test/observer.test.ts` | The SPA observer's emit and suppress decisions in both directions, since every negative decision it makes is silent by design. |
| `test/hidden-text.test.ts` | Which inline styles count as hiding, and (mostly) which do not: this is the one scan whose output is *removed* from the body before scoring, so an over-eager rule deletes the evidence rather than finding it. Includes the escape rule: only a descendant with an absolute size or its own `visibility: visible` is freed, never the container's own text. |
| `test/highlight.test.ts` | Locating a finding's excerpt in the rendered body: one bounded pass over text nodes, quoted blocks searched only when nothing outside them matches, links matched through the shared selector. Needs a DOM. |
| `test/extraction.test.ts` | The extraction-gap rule, starting by demonstrating the danger: a thread hijack scored with its sender removed comes back **Low Risk**, because a reply-chain attack is detectable only from identity. Also that the card's wording never reassures, and that neither diagnostic (the single-message one or the session tally) carries anything from a message, including the section that accounts for the score, where every free-text field of a message is asserted absent at once. |
| `test/background.test.ts` | The service worker's handlers against a stub of `chrome`: no request to an origin the user has not granted, the worker's own system prompt in place of the caller's, a Gmail tab limited to changing the trust list, and a toolbar badge painted only on the tab that asked and only when every field is well-formed. Overlapping settings patches retain both changes, and overlapping toolbar paints finish in order. |
| `test/model-protocol.test.ts` | The OpenAI-compatible request and response shapes, and the URL policy the worker enforces before any of it is sent. |
| `test/trust.test.ts` | Each of the four limits on trusted senders, from both sides: that trust dampens what it should, and that it does nothing at all when authentication did not prove the sender, against an identity finding, or against a `high` finding. |
| `test/triage.test.ts` | The sender-only verdicts, that none of them can read as an all-clear, that no low-scoring fixture is marked, and the allowlist guard that fails when a new identity rule is classified as neither safe nor unsafe for a list row. |
| `test/popup.test.ts` | The popup's wording for every state (in particular that "nothing was found" and "nothing was checked" never share a phrasing) and the health line for each shape of extraction failure. |
| `test/toolbar-badge.test.ts` | Toolbar icon badge text and colours for each tab status, including `showBadgeWhenLow` and the unreadable `?`. |
| `test/welcome.test.ts` | The welcome page's guidance for each on-device model state: the `chrome://settings/system` steps when the model is unavailable, an update when Chrome has no Prompt API, a download only from a button, and that every state says the checks work without the model. In any other browser (Edge, Brave, Opera), no state names a Chrome page or offers a Chrome button, and the browser is told apart by its client-hint brand, never the user-agent string. |
| `test/on-device-choice.test.ts` | When the welcome and options pages grey out the on-device choice: only where the browser has no Prompt API at all, never for a state a setting or download can fix, always with a reason, and with its own wording when the choice is already selected. |
| `test/gmail-dom.test.ts` | The adapter against Gmail-shaped markup: sender, subject, body, links and attachment chips read out of a rendered page, authentication read from the details table, a warning banner distinguished from an unrelated live region, an unreadable sender reported as unread rather than empty, and which message is chosen when the candidate selectors disagree about which element is a message. Needs a DOM. |
| `test/observer-dom.test.ts` | The observer and adapter over a real `MutationObserver`: in-place collapse and evidence changes, visibility before the first readable extraction, nested message IDs, heading-only navigation, and debounce-first reconciliation. Needs a DOM. |
| `test/list-marks.test.ts` | The list marker against inbox-shaped rows: that ordinary mail is left alone, that a recycled row is re-evaluated rather than trusted, that rows already on screen are re-triaged once Gmail exposes the signed-in address (which arrives after they do, and without which the check for a domain imitating the reader's own cannot run), that a mark Gmail discards when it redraws a row as read comes back, and that marking survives Gmail replacing the region being watched. Needs a DOM. |
| `test/settings.test.ts` | What each setting asks of a view already on screen, with a guard that fails until a newly added setting is classified, "changes nothing" being the one answer that cannot be right for something offered as a choice. |
| `test/readings.test.ts` | Availability waits and late answers cannot survive cancellation or a model change into the reading cache. |
| `test/controller.test.ts` | The orchestration's timing, with the model's answer held as a promise this file resolves by hand: that a settings change abandons the inference it supersedes, that the superseded answer reaches neither the screen nor the cache, that a presentation-only change leaves the inference running, and that a header Gmail redraws gets its badge back without another inference. Also that a redraw joins or reuses a reading rather than asking twice, that clean mail is not sent to the model by default while flagged mail is, and that a reading asked for from the card is kept. Out-of-order settings reads cannot repaint an older preference. Needs a DOM. |
| `test/card.test.ts` | The rendered card: message text set as text even when it looks like markup, findings and the model's reading in separate sections, every ring segment named by a row beside it, the floor shown when a severe finding raised the score, and a skipped reading never worded as an all-clear. Also the card's wording helpers: durations, timing lines, quoted excerpts, score summaries. Needs a DOM. |

**What the DOM tests prove, and what they cannot.** They prove the adapter's logic: that a details table
becomes an `EmailAuthInfo`, that an unread part is reported rather than dropped. They do not prove the
selectors still match Gmail, because the markup is written from the same table the code reads. Nothing in a
repository can prove that; it needs the live product, which is what the session health tally and the
copied diagnostic in the popup exist for. The value is that a refactor can no longer quietly break
extraction, and that a gate like `isSenderProven` is now asserted against what the adapter can actually
read rather than against a hand-written `auth` block, which is precisely how it came to be unsatisfiable
in production while passing in CI.

Fixture philosophy and the both-directions assertion are described in
[DETECTION.md](DETECTION.md#the-score) and [AGENTS.md](../AGENTS.md).

### Browser smoke test

Vitest runs in Node with jsdom, which has no layout and no extension runtime, so two kinds of breakage pass
it: a card that renders wider than its frame in one engine, and an extension page that throws on load in
one browser. `scripts/browser-smoke.mjs` loads the real thing into real browsers and checks both:

- **The harness**, over every fixture, every semantic state, the "not checked" card, and the badge and list
  views: the badge is visible, the card fits the viewport, nothing in it is wider than the card or clipped
  by its container, the badge and card agree on the score, the "not a judgement that the message is safe"
  sentence is on the unreadable card, and nothing logs an error.
- **The extension**, loaded unpacked: the background starts, the welcome page opens on install, and the
  welcome, options and popup pages load without errors. The on-device choice is offered exactly where
  the browser has a Prompt API, and the options page shows the right version. In Firefox, **Connect** on
  a localhost model server is clicked for real and must be granted, since which host permissions Firefox
  accepts is its own rule that no unit test reproduces.

Some Firefox releases (156, for one) refuse automated clicks in extension pages. That check is then
reported as **NOT RUN**, by name, instead of passing or failing; ESR, which `smoke:docker` uses, and
newer releases run it.

```bash
npm run smoke:browsers                           # every supported browser installed here
npm run smoke:browsers -- --browsers=edge,firefox
CHROME_PATH=/opt/chrome/chrome npm run smoke:browsers -- --browsers=chrome
npm run smoke:docker                             # nothing installed but Docker
```

Supported names are `chrome`, `edge`, `chromium` and `firefox`. A named browser that cannot be found fails
the run; without `--browsers`, missing ones are skipped with a note. Chromium browsers are driven over the
DevTools protocol on a pipe, which is the one way left to load an unpacked extension into branded Chrome
(137 and later ignore `--load-extension`); Firefox over WebDriver BiDi, which installs it as a temporary
add-on. Neither needs a dependency: Playwright and Puppeteer are left out for the reason in
`scripts/screenshots.mjs`, and Playwright's Firefox and WebKit cannot load extensions at all.

The checks are about structure and geometry, never pixels. Fonts render differently on every operating
system, so a pixel baseline only matches the machine that recorded it. Screenshots of each browser's
pages still go to `smoke-output/`, with `report.json`, for a person to look at. Firefox refuses to capture
its own extension pages over BiDi, so it contributes harness screenshots only.

`smoke:docker` builds `scripts/browser-smoke.Dockerfile` (Debian's Chromium and Firefox ESR on Node 24) and
runs the suite inside it, with `smoke-output/` mounted back to the host. The first run downloads the
browsers into the image; later runs reuse it.

Safari is not covered: it runs only on macOS, and ShoutPhish does not support it yet.

### Measuring against real mail

Fixtures prove a rule does what it was written to do; only a corpus says what it does to mail nobody wrote
for the test. `npm run eval` scores stored mail with the deterministic engine and prints, per corpus, how
many messages landed in each band, which floors fired, and which rules at which severities:

```bash
npm run eval -- ~/corpora/hard_ham                       # a directory of single messages
npm run eval -- --group lures ~/corpora/phishing-*.mbox  # several files reported as one
npm run eval -- ~/Takeout/mail.mbox --since 2025-10-01   # your own mailbox; split into mail and spam
npm run eval -- ~/corpora/dataset.csv                    # pre-extracted rows (columns in scripts/eval/main.ts)
```

A legitimate corpus measures false positives and a phishing corpus misses, and neither number means much
alone: a change is judged by running both before and after. The conversion in `scripts/eval/message.ts`
follows what Gmail renders (the HTML part over the plain one, hidden subtrees removed by the adapter's own
scan), and the places it cannot, such as Gmail's warning banner, are listed there. A corpus result can
differ from what a user sees exactly there.

The report holds rule ids and counts only. `--rows <dir>` adds each flagged message's sender, subject, link
hosts and findings for investigation, and refuses a directory inside the repository. Treat what it writes
as the mail it came from: a finding traced to someone's own mailbox goes into a fixture as its *shape*,
under an invented `northwind-*` name, never as the message (see [AGENTS.md](../AGENTS.md)).

## Continuous integration

`.github/workflows/ci.yml` runs `lint`, `typecheck` and `test` on Node 24.0.0 (the `engines` floor, pinned
exactly, because an untested promise is a guess) and on Node 26, the newest release line. It then builds and uploads the
extension as an artifact, so every commit has an installable package attached. Before uploading, it runs
`npm run check:dist` (`scripts/check-dist.mjs`), which catches what a broken build would otherwise ship
silently: a file the manifest names but the build did not produce, a `<script>` in `options.html` pointing
at a renamed bundle, a manifest version out of step with `package.json` or in a form Chrome rejects, a
sourcemap reference or HTML sink in any bundle, or a permission the README and `docs/PRIVACY.md` do not
advertise. The file list is read out of the manifest rather than hardcoded, so adding a reference to the
manifest extends the check automatically; the permission list is hardcoded on purpose, so that changing it
fails until the documents promising it are updated too. Run it locally after `npm run build` if you are
touching the build. It checks both packages; for `dist-firefox/` it also pins `browser_specific_settings`
(the extension ID and the data-collection declaration Firefox shows at install) to
`src/manifest.firefox.json`. CI then runs `npm run lint:firefox`, Mozilla's own validator, which knows
Firefox's rules better than any check written here.

The build and the dist check run once, on Node 24 (the LTS line): the bundle is the same bytes whichever Node
produced it, and the floor is already exercised by lint, typecheck and test.

A separate job runs the [browser smoke test](#browser-smoke-test) against the stable Chrome, Edge and
Firefox the Ubuntu runner image already ships, so nothing is downloaded. The browsers are named
explicitly, so one that disappears from a future image fails the job rather than being skipped. The
screenshots are uploaded as an artifact even when a check fails, since that is when they are wanted.

Every job checks out with `persist-credentials: false`, because `npm ci` runs dev-dependency install
scripts and nothing after the checkout needs to act as this repository. Third-party actions are pinned to a
commit SHA with the version in a trailing comment, since a tag can be moved to different code after review.

Dependabot (`.github/dependabot.yml`) proposes weekly updates, grouped into one pull request per ecosystem
so the noise stays proportionate to a dev-only dependency tree. That includes the action pins: it rewrites
the SHA and the version comment together.

## Releasing

```bash
npm version patch      # writes package.json and creates the tag
git push --follow-tags
```

`.github/workflows/release.yml` verifies, builds both targets, runs `check:dist` and Mozilla's validator,
zips `dist/` and `dist-firefox/` separately, has Mozilla sign the Firefox zip, and publishes a GitHub Release
carrying the Chromium zip, the signed `.xpi` and install instructions for each. There is no per-platform or
per-processor build: an extension contains no compiled code, so one Chromium zip serves Chrome, Edge and the
other Chromium browsers everywhere.

Signing uses addons.mozilla.org's unlisted channel, which signs for self-distribution without a store
listing ([adr/0013](adr/0013-firefox-signed-unlisted.md)). It needs two repository secrets, `AMO_JWT_ISSUER`
and `AMO_JWT_SECRET`, the "JWT issuer" and "JWT secret" from the API-key page of the account that owns the
add-on. Each upload carries a `git archive` of the tag, because the bundles are minified and Mozilla's
reviewers rebuild from source with `npm ci && npm run build:firefox`. Mozilla accepts a version number once,
so a release that fails after its upload was accepted is fixed by releasing the next patch version, not by
re-running the job. It refuses to publish when the tag disagrees with `package.json`, because
the manifest version is generated from that field and a release whose contents contradict its label is worse
than no release.

It is three jobs. The build job installs and runs project code with read-only access and no secrets; the
sign job is the only one with the Mozilla key, installs with `--ignore-scripts`, and runs nothing but
`web-ext sign`; the publish job holds the only `contents: write` token and runs nothing but
`gh release create` on the other two jobs' artifacts. Keep it that way: merged, any dev dependency's install
script could publish a release or sign as ShoutPhish.

A `v*` tag cannot be deleted or moved once pushed (see below), so a mistagged release is corrected by
releasing the next patch version, never by repointing the tag. Someone may already have downloaded the asset,
and a tag that no longer describes what they have is a worse outcome than a skipped version number.

## Branch and tag protection

Configured as repository rulesets, which live on GitHub rather than in this repository, hence recorded here.
Both apply to every account including the owner, since a rule that the person most likely to be typing at
2am can bypass is documentation, not protection.

| Target                | Rule                            | Reason                                                                              |
| --------------------- | ------------------------------- | ----------------------------------------------------------------------------------- |
| `main`                | No force-push, no deletion      | History is the audit trail for a security tool; losing it silently is unrecoverable. |
| `refs/tags/v*`        | No deletion, no moving          | A release asset is public and permanent, so its tag has to be too.                   |

Status checks are deliberately **not** required. A commit cannot have passing checks before it is pushed, so
requiring them would block direct pushes to `main` and force every change through a pull request: friction
that buys little on a single-maintainer repository, given `npm run verify` runs before every commit anyway.

If that changes, do not require the matrix jobs by name: they are called `Verify (Node 24.0.0)` and
`Verify (Node 26)`, so the floor is baked into the string, and the ruleset would silently demand a check that
no longer runs the next time the floor moves. Add an aggregate job with a stable name and require that.

## Conventions

- `npm run verify` must pass before a commit (lint, typecheck, test, both builds, `check:dist`).
- Scoring numbers live in `src/analysis/scoring/config.ts`; Gmail selectors in `src/gmail/selectors.ts`.
- New detection behaviour needs a fixture asserted in both directions.
- Commit messages are a short subject and at most three lines of why; longer reasoning goes in the code,
  `docs/`, or a fixture. Do not add co-author trailers.

Invariants agents break most often are listed in [AGENTS.md](../AGENTS.md). Design history: [adr/](adr/).
