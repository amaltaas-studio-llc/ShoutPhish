# Contributing to ShoutPhish

Thank you for helping. The most valuable contributions to a phishing checker are not code: they are the
messages it got wrong.

## Reporting a result that looks wrong

Use one of the [issue forms](https://github.com/amaltaas-studio-llc/ShoutPhish/issues/new/choose):

- **A genuine email was flagged**: a false alarm. These matter most, because a checker that warns about
  ordinary mail gets switched off.
- **A phishing email was missed**: it scored lower than it should have.
- **Something is not working**: no badge, a broken card, settings, or the optional AI.

Each form asks for the diagnostic report: with the message open, click the ShoutPhish icon in the toolbar
and choose **Copy a diagnostic report**. It lists which checks ran and what each added, and contains no
text, address or link from the message. Read it before pasting anyway.

**Describe the email; never paste it.** Issues are public and permanent. Say what kind of message it was
("a delivery notice", "an invoice from a supplier", "a shared-document notification") and what made it
genuine or suspicious, without the sender's name or address, links, or screenshots of real mail. The shape
is what a fix needs; the details only expose you and the people who wrote to you.

Security problems go through [SECURITY.md](SECURITY.md), not a public issue.

## Building it yourself

You need Node.js 24 or later.

```bash
npm ci
npm run build          # the Chrome and Edge build, in dist/
npm run build:firefox  # the Firefox build, in dist-firefox/
npm run harness        # the real card and badge on test messages, at http://127.0.0.1:5199
```

Load `dist/` with **Load unpacked** at `chrome://extensions` (Developer mode on), or `dist-firefox/manifest.json`
as a temporary add-on at `about:debugging#/runtime/this-firefox`. The
[development guide](docs/DEVELOPMENT.md) covers the project layout, every test suite, the harness, the
browser smoke test and releases.

## Sending a change

- **`npm run verify` passes.** It runs lint, typecheck, the tests, both builds and the package check, and
  it is what CI runs.
- **Detection changes come with a fixture**, in `test/fixtures/`, asserted in both directions: the new
  check fires on the phishing example, and every genuine example still scores Low Risk. Read
  [docs/DETECTION.md](docs/DETECTION.md) first; several checks already carry rules whose purpose is to
  prevent the false alarm a new check is likely to reintroduce.
- **Fixtures are invented.** Never base one on a real message, and never name a real organisation you saw
  in someone's mailbox. Use the `northwind-*` names the existing fixtures use.
- **Docs move with behaviour.** If what a user sees or what the extension does changes, update the page
  that describes it in the same pull request. `README.md` is for people installing the extension and stays
  free of technical detail; technical detail belongs in `docs/`.
- **Structural changes** start from [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and past decisions with
  the alternatives that were rejected are in [docs/adr/](docs/adr/).

Some things are deliberate and need a discussion before a pull request: adding a runtime dependency or a
framework, a new permission, any network request in the default configuration, and anything that lets the
optional AI outweigh the checks.
