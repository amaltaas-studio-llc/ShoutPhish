# 0015. Firefox releases are listed on addons.mozilla.org

**Status:** Accepted. Supersedes [0013](0013-firefox-signed-unlisted.md).

## Context

[0013](0013-firefox-signed-unlisted.md) had Mozilla sign each version on the unlisted channel and attached
the signed `.xpi` to the GitHub Release. It rejected a listing mainly because Firefox would then have been
the only browser distributed through a store, and said to revisit that together with the Chrome Web Store.
ShoutPhish is now submitted to the Chrome Web Store, so that reason is gone. The cost of staying unlisted
remains: a self-distributed install never updates itself, so every Firefox user is left on whatever
version they first downloaded, detection fixes included.

## Decision

- The release workflow submits each version on the listed channel with `web-ext sign` and does not wait
  for Mozilla's review. The version appears on addons.mozilla.org when the review passes, and Firefox
  updates existing installs from there.
- The GitHub Release no longer carries a Firefox file. Its notes send Firefox users to the listing.
- The listing text, the licence, the compatible applications and the notes for reviewers live in
  `docs/amo-metadata.json` and are submitted with every version, so the listing says what the tagged
  commit says. A test checks the fields Mozilla would otherwise reject only after the version is spent.
- The listing is for desktop Firefox only. The manifest's Android minimum stays, since it marks the first
  release with built-in data consent, but Gmail's mobile site is markup the selectors were never written
  for.
- Everything else from 0013 holds: the package submitted is the one the build job tested, every submission
  carries a `git archive` of the tag, and the key lives in a job of its own that runs only `web-ext`.

## Consequences

- Firefox users get automatic updates and can find ShoutPhish in Firefox's add-on manager.
- Every version waits for Mozilla's review before Firefox users get it. The automated review is usually
  quick; a human review can take days, and in that window the GitHub Release exists while the listing still
  offers the previous version.
- The privacy policy, the screenshots and the support URL have no field `web-ext` submits. They are set
  once in the Developer Hub, as `docs/STORE-LISTING.md` describes, and have to be kept true by hand.
- A version number is still accepted once. A submission that fails after its upload was accepted is fixed
  by the next patch version.
- Installs from an `.xpi` attached to an earlier release have the same add-on ID, so Firefox is expected to
  move them onto the listed versions.

## Rejected alternatives

- **Staying unlisted**: keeps releases independent of review, but leaves every Firefox install frozen at
  its first version, which for a security tool is the larger risk.
- **Listing, and attaching the `.xpi` when approval arrives within the job**: gives a download most
  releases would not have, since approval time is unpredictable, and two ways to install invite running
  a version the listing has since replaced.
- **Submitting both channels for each version**: a version number belongs to one channel, so this would
  need two numbers per release.
- **Listing Firefox for Android as well**: the declaration would offer an install that cannot work on
  Gmail's mobile site. Worth adding once it is tested there.
