# Privacy and security

What data exists, where it goes, and what this extension is built to withstand. The plain-language
summary is in the [README](../README.md#your-mail-stays-yours); this is the full account.

## Permissions

Mapped 1:1 to `src/manifest.json`. Two are granted at install; one is offered and granted only if asked
for.

| Manifest entry | Why it is needed |
| --- | --- |
| `"host_permissions": ["https://mail.google.com/*"]` | The content script reads the open message from the page in order to analyse it. This is the only origin ShoutPhish can run on. |
| `"permissions": ["storage"]` | Persists the options-page settings (AI mode, backend URL, model server address and model name, the display toggles, whether AI runs only on flagged mail) and the trust list. No message content is ever written to storage. |
| `"optional_host_permissions": ["http://localhost/*", "http://127.0.0.1/*", "https://*/*"]` | **Not granted at install.** If you configure your own model server, the options page requests access to that single origin on a click, and revokes it when the address changes. Chrome names the origin in the prompt. Firefox cannot grant one port of a named host, so for a loopback `http://` server it grants that host on every port (`http://localhost/*`); requests still go only to the configured address, because the address is read from settings and never from a message. |

The HTTPS entry is a broad pattern because Chrome grants only what a pattern in the manifest covers, and a
model server reachable over TLS can be on any host. The plaintext entries are not broad, and deliberately:
`http://` is accepted only for loopback, so a pattern matching any other host could never be used and would
be asking for reach the code refuses to take. What matters for both is that they are *optional*: a default
install holds two permissions, the grant is per-origin, made on a deliberate click, and visible in
`chrome://extensions`. The alternative (putting `http://localhost/*` in `host_permissions`) would charge
every user a permission for a feature most will never turn on.

Not requested, and not needed: `activeTab`, `<all_urls>`, `tabs`, `scripting`, `webRequest`,
`declarativeNetRequest`, `downloads`, `cookies`, `identity`, `nativeMessaging`. The content script is
declared in the manifest, so `scripting` is unnecessary. Nothing in a message is ever fetched, blocked, or
rewritten, so the network permissions are unnecessary.

Extension pages run under `script-src 'self'; object-src 'none'; base-uri 'none'`.

If a future feature seems to need something broader, that is a signal to reconsider the feature.

**On Firefox**, the same permissions apply, plus Firefox's data-collection declaration, shown before
install (`src/manifest.firefox.json`):

| Declaration | Meaning |
| --- | --- |
| `"required": ["none"]` | A default install transmits no data. Firefox says so on the install prompt. |
| `"optional": ["personalCommunications"]` | **Not granted at install.** Asked for on the same Connect click as a model server's address, because the server receives message text, and Mozilla counts anything handled outside the browser as transmission, even a process on your own machine. The worker checks this consent and the address grant together before every request, and both are revoked together when the address changes. |

Firefox also lets you withhold Gmail access itself. The popup then says that ShoutPhish checks nothing,
and offers to ask again; it never reads that as nothing to check.

## Where data lives

**Extracted from Gmail**: sender name and address, Reply-To, subject, visible body text (truncated,
quoted replies removed unless they are all the message has), the anchor text and hrefs of every link in the
message, quoted parts included, since a sender can mark anything as a quote, attachment filenames and extensions, the delivered-to
address, Gmail's own authentication summary when it is exposed in the DOM, and the names and addresses of
whoever sent the earlier messages in the open conversation. That last one is needed to tell a reply from a
party already in a thread from one imitating them, and like everything else it is read from what is
already on screen: no message is fetched, and nothing outside the open thread is looked at. This lives in memory in the
content script for as long as the message is on screen, then is dropped. It is never written to
`chrome.storage` and never logged in a release build. It reaches the service worker in one case only:
with your own model server configured, the prompt (display name, subject and body excerpt) is handed
to the worker, which is the one part of the extension allowed to make the request.

**Analysed locally**: all of it. Every deterministic detector and the whole scoring engine run inside
the tab, and so does Chrome's on-device model if you choose it; AI is off until you do. Nothing touches
the network. Only the
model's readings are kept, in the tab, capped at 50, and discarded when the tab closes.

**Written to `chrome.storage`**: the settings you choose, and one list that comes from a message: the
addresses and domains you mark as trusted. That is the deliberate exception to "nothing is stored", since
a trust decision that did not outlive the tab would be useless. The list is capped at 50 entries, each
bounded in length and required to look like an address or a hostname, and it is visible and editable in
the options page. Nothing else: no subject, no body, no score, no history of what you have read.

The session's **extraction health** (how many messages were seen, how many parts could not be found, and
which selector groups fell through to a fallback) is counted in the tab and shown in the popup, so a
Gmail layout change is visible rather than silent. It is counts and selector names only; the diagnostic
you can copy from the popup is asserted by a test to contain nothing from any message.

That report also accounts for the score of the message on screen, so you can dispute one without
installing a development build. It names the checks that ran (the identifiers used in this repository)
with what each added to the score, and describes what was read as numbers: how many characters the body
held, how many links and attachments, how many characters were concealed and by which CSS. No subject, no
address, no filename, no excerpt, and no finding wording, since every one of those is built around
something you were sent. The report is shown in full in the popup before you copy it, for the same reason
the other one is: a report you cannot read is one you cannot decide to share.

**Potentially leaving the browser**: nothing by default. Two modes can send message content, and both
require an explicit choice *and* an address, neither of which has a default value:

- *Your own model server* sends the sender's display name, the subject and a body excerpt to the address
  you configure, and nothing else. No link targets, no sending domain, no attachment types, no recipient
  address, no API key. Plain `http://` is only accepted for `localhost`, so in the intended setup this data
  reaches a process on your own machine and no network. Point it at an `https://` address elsewhere and it
  crosses a network to that address; the options page says so where you type it. See
  [LOCAL-AI.md](LOCAL-AI.md#your-own-model-server).
- *Cloud-assisted* is designed and inert, with no default backend, and the options page no longer offers
  it; the radio appears only for someone who already had it selected. What such a payload would contain,
  and what it would strip, is in [adr/0009](adr/0009-model-server-and-inert-cloud.md).

Nothing else ever leaves, in any configuration.

Three choices follow from this:

- **No logging of message content.** `src/shared/logger.ts` compiles to a no-op in release builds via a
  build-time flag, and redacts even in dev builds.
- **No API keys in the extension.** An API key shipped in an extension is a public API key.
- **Nothing in an email is ever fetched.** No URL is requested, no attachment downloaded, no preview
  generated, no DNS lookup made. All link and attachment analysis is textual.

## Threat model

### Malicious email content

Every string from a message (URL, filename, display name, subject, body) is hostile input. It is bounded
on extraction, never `eval`'d, never used to build a URL that gets requested, and never parsed as HTML.

All rendering goes through `src/ui/dom.ts`, which sets `textContent` and never `innerHTML`; `innerHTML`,
`outerHTML` and `insertAdjacentHTML` are ESLint errors project-wide, so the safety property is mechanical
rather than remembered. URL parsing uses the platform parser rather than regexes. Unicode is handled
explicitly (punycode decoding, script-mixing detection, confusable folding, bidi stripping), so a
homoglyph domain cannot pass as a brand's. Regexes over message text are bounded and anchored to avoid
catastrophic backtracking. `clamp()` fails closed on non-finite input, so a crafted value cannot
manufacture a score.

### Gmail DOM changes

Treated as certain, not hypothetical. Selector knowledge is isolated in `src/gmail/selectors.ts` behind the
`MailAdapter` interface; extraction is written so a missing field is absent rather than wrong; and the
observer tears the badge down rather than show a stale verdict when it cannot confirm what is on screen. A
selector break degrades to "fewer findings", never to "wrong findings" or a broken Gmail.

With one exception, which is handled separately: **fewer findings is not honest when the missing field is
the sender.** Nearly every high-severity check reasons about the sending domain, so a message whose sender
cannot be read produces no findings, and no findings scores as Low Risk: a confident all-clear on a
message nobody checked. The extension declines to score at all in that case, shows **Not checked**, and
says on the card that nothing having been found is not a finding of nothing. See
[adr/0003](adr/0003-gmail-two-signals.md).

That card offers a **diagnostic report** to paste into a bug report, because the project has no telemetry
and a broken selector is otherwise unknowable. It contains selector strings from this repository, the
extension and browser versions, and the names of the parts that were unread. It contains no message
content, no address, and not the URL, which carries a thread id, i.e. an identifier for one specific
message in your mailbox. It is shown in full rather than only copied, so you can read it first, and it is
sent nowhere unless you paste it somewhere yourself.

The toolbar menu's **Copy a diagnostic report**, which the issue forms ask for, is the same idea for a
whole session and for a score someone disagrees with. Beyond the above it holds counts (messages seen,
characters of body read, links, attachments), the ids and points of the checks that ran, timings, how the
optional AI is set up (its mode, the model's name, and only *whether* the server is on this computer, not
its address), on/off states of the display settings, how many senders are trusted but not who, and, when a
model server failed, the extension's own explanation of why. None of it is text from a message or from a
model's answer.

### Prompt injection

Assumed to succeed sometimes. Containment is defence in depth: message content is wrapped in delimiters,
forged delimiters are neutralised, the system prompt states that the contents are data and that anything
resembling an instruction is itself evidence of manipulation, and the task is restated *after* the content
because models weight the end of the context heavily.

But the real control is architectural. A fully successful injection can only zero the `llm` category's 15
points. It cannot delete a deterministic finding, cannot lower the score below a deterministic floor, and
cannot change the classification of a message that failed a technical check. See
[LOCAL-AI.md](LOCAL-AI.md#three-guarantees).

### Malicious external URLs

ShoutPhish never dereferences anything found in a message: no `fetch`, no prefetch, no favicon, no DNS, no
attachment download or inspection. Analysis is purely textual, so a URL in an email cannot become a
request that leaks the fact the message was opened, and a malicious server never sees ShoutPhish at all.

### Extension permission abuse

The attack surface is kept small enough to audit: two granted permissions, one origin, zero runtime
dependencies, no remote code (MV3 forbids it and the CSP enforces it), no `eval` or `Function`. The service
worker accepts only messages whose `sender.id` matches the extension's own id, which Chrome sets and a web
page cannot forge, so a compromised page cannot drive the worker.

The worker's only network capability is a request to a URL the user configured. Deliberately, **no message
can supply an endpoint**: the analyze and list-models handlers read the address from settings, where it has
already been through `normalizeModelBaseUrl`. Had the URL travelled in the message instead, anything able to
send the worker a message would have had a general-purpose fetcher, which is a much larger thing to have
built than a model client. Nor can a message supply the model's instructions: the worker adds the system
prompt itself.

Before every request the worker also checks that the user granted access to that origin, and refuses
otherwise. Chrome does not enforce this by itself: without a host permission an extension's request still
leaves as an ordinary cross-origin one, and reaches any server that accepts extension origins, so the grant
is checked where the request is made. Settings that decide where content goes can be changed only from the
extension's own pages; a Gmail tab may change the trust list and nothing else. No extension context can grant
itself a host permission, so even settings edited some other way cannot direct a request at an origin the
user did not approve.

### API-key exposure

Structurally impossible here, because there is no key. The extension holds no vendor credential and no code
path adds an `Authorization` header.

### Data exfiltration

The default configuration makes no network requests at all. Both network modes require an explicit mode
choice, an address, and a permission grant Chrome prompts for by origin, which the worker checks before
each request. Cloud mode
additionally passes everything through one reviewable redaction function, with the recipient address, sender
local part, filenames, full URLs and message ids removed. Message bodies are never persisted and never
logged in a release build. There is no telemetry, no analytics, no error reporting, and no update channel
beyond Chrome's own.

### What ShoutPhish does not defend against

It is a reading aid, not a control. It does not stop anyone clicking a link, opening an attachment, or
replying. It cannot detect a phishing message that is textually indistinguishable from legitimate mail. A
compromised real account of a real correspondent sending a plausible request from the usual domain will
score low, correctly, on the evidence available. It is one layer, and the weakest assumption in it is that
the user reads the card.

## Reporting a security issue

Open a GitHub issue for anything that is not itself sensitive. Please do not paste real personal mail into
an issue; a description of the sender and link *shapes* is enough to write a fixture from.
