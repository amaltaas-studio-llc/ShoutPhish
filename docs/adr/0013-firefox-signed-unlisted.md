# 0013. Firefox builds are signed by Mozilla for self-distribution, not listed

**Status:** Superseded by [0015](0015-firefox-listed-on-amo.md)

## Context

Release Firefox installs only add-ons Mozilla has signed; an unsigned package loads as a temporary add-on
that disappears on restart, which is not an install anyone can rely on. Mozilla signs through
addons.mozilla.org on two channels: *listed*, which publishes a store page and reviews before listing, and
*unlisted*, which signs a package for the developer to distribute themselves. Chromium releases are already
distributed as a GitHub Release download, and the README sends every user to that page.

## Decision

- The release workflow submits each version's Firefox zip on the unlisted channel with `web-ext sign` and
  attaches the signed `.xpi` to the GitHub Release. The unsigned Firefox zip is not published.
- The package signed is the one the build job built, checked and validated, unpacked unchanged. Signing
  never rebuilds.
- Every submission includes a `git archive` of the tag, since the bundles are minified and Mozilla's policy
  requires readable source for that.
- The key lives in two repository secrets read by a job of its own, which installs with scripts disabled and
  runs only `web-ext`; neither the build job nor the publish job can see it.
- A release is all or nothing: if signing fails, nothing is published, so a release never carries notes
  describing a Firefox download it does not have.

## Consequences

- Firefox users get a permanent install from the same page as Chromium users, with the same version.
- A version number is accepted by Mozilla once. A failure after the upload succeeded cannot be retried; the
  fix is the next patch version, which is already how a mistagged release is handled.
- Mozilla can review an unlisted version after signing it and ask for changes, so the source archive has to
  build to the same output with the documented commands.
- Installs do not update themselves, as on Chromium. Automatic updates would need an `update_url` in the
  manifest and an update manifest hosted somewhere stable; that is a separate decision.

## Rejected alternatives

- **Listing on addons.mozilla.org**: gives automatic updates and discoverability, but adds a public listing
  to maintain and a pre-publication review to every release, and would make Firefox the only browser
  distributed through a store. Worth revisiting together with the Chrome Web Store and Edge Add-ons, not
  alone.
- **Publishing the unsigned zip alongside the signed file**: release Firefox would keep it only until a
  restart, and two Firefox downloads invite picking the wrong one. CI artifacts keep the unsigned build for
  development.
- **Signing in the build job**: that job runs every dev dependency's install scripts, which would then share
  a process environment with the signing key.
- **Publishing first and signing afterwards with `gh release upload`**: a release would exist for a while,
  or indefinitely on failure, with notes promising a file it lacks.
