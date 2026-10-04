# Security policy

ShoutPhish reads the email you have open, so a flaw in it can expose mail. Please report security problems
privately, so they can be fixed before they are public.

## Reporting

Use GitHub's private reporting:
[**Report a vulnerability**](https://github.com/amaltaas-studio-llc/ShoutPhish/security/advisories/new).
Only the maintainers can see the report. Please do not open a public issue or pull request for it.

Include the ShoutPhish version, the browser, and the steps or an invented example message that shows the
problem. As with any report, do not send real mail.

You should get a reply within a week. Fixes ship in the next release, and the advisory is published once
an update is available.

## What counts

Anything that breaks a guarantee in [docs/PRIVACY.md](docs/PRIVACY.md), for example:

- text from an email reaching the page as markup, or running as code;
- message content, or anything identifying the mailbox, leaving the browser without the user having set up
  a model server;
- the extension contacting an address that did not come from the user's own settings, or fetching
  anything named in an email;
- a way for a web page or an email to change ShoutPhish's settings or permissions;
- a trusted sender silencing a warning about who the sender is.

A phishing email that scores too low, or a genuine one that scores too high, is a detection problem rather
than a vulnerability: please use the [issue forms](https://github.com/amaltaas-studio-llc/ShoutPhish/issues/new/choose).

## Supported versions

Only the latest release is supported. Manual installs do not update themselves, so check that the problem
still occurs on the [latest release](https://github.com/amaltaas-studio-llc/ShoutPhish/releases/latest).
