# Chrome Web Store listing

Every field the [developer dashboard](https://chrome.google.com/webstore/devconsole) asks for, with the
text to paste. Kept in the repository because the privacy answers are a public claim about the code: the
store removes an item whose dashboard answers, privacy policy and behaviour disagree, so when behaviour
changes, this file changes in the same commit, the same way `docs/PRIVACY.md` does.

The same zip and most of this text also serve Microsoft's
[Edge Add-ons](https://partner.microsoft.com/dashboard/microsoftedge/overview), which is free.

## Package

Upload `shoutphish-VERSION.zip` from the [GitHub release](https://github.com/amaltaas-studio-llc/ShoutPhish/releases),
never a local build: the release zip is the one CI verified, and its source is the tagged commit. The
manifest's `name`, `description` and `version` become the listing's title, summary and version, so neither
is typed in the dashboard.

## Store listing tab

**Description** (plain text; the store does not render Markdown):

```text
ShoutPhish checks the email you open in Gmail for signs of phishing, scores it from 0 to 100, and explains every point of that score in plain words, with the evidence so you can check it yourself.

WHAT IT NOTICES
• Sender names that claim a company the address does not belong to, and addresses one letter away from a real one
• Links whose text says one thing while the destination is somewhere else
• A reply in a conversation from a lookalike of someone already in it
• Requests for codes, passwords, payments or gift cards, and urgent pressure to act
• Dangerous or disguised attachments, judged by file name only
• Hidden text and other tricks used to get past filters

QUIET ON ORDINARY MAIL
Genuine messages stay Low Risk, and the badge can stay hidden until something is worth a look. When ShoutPhish cannot read a message properly, it says "Not checked" instead of pretending it is safe.

YOUR MAIL STAYS ON YOUR COMPUTER
• Every check runs inside your browser. Out of the box, ShoutPhish makes no network requests at all.
• No account, no analytics, no advertising, no tracking. There is no ShoutPhish server.
• Message content is never saved. Only your settings and the senders you choose to trust are stored.
• Links, images and attachments in a message are never opened.
• Two permissions: access to Gmail, and storage for your settings.

OPTIONAL AI
You can add a plain-language reading from Chrome's built-in AI, which runs on your computer, or from an AI server you run yourself, such as Ollama. Both are off until you turn them on. The AI can add at most 15 of the 100 points and can never outvote the checks.

OPEN SOURCE
The source code, the privacy policy, and a full account of what is read and why are public: https://github.com/amaltaas-studio-llc/ShoutPhish

ShoutPhish is not affiliated with Google. It is a second opinion, not a guarantee: no checker catches every phishing message.
```

**Category:** Privacy & Security. **Language:** English.

**Images**, from `npm run harness` then `npm run store:images`, written to `store-assets/`:

| Dashboard field | File |
| --- | --- |
| Store icon (128×128) | `dist/icons/icon128.png` |
| Screenshots (1280×800, up to 5, in this order) | `1-explained.png` … `5-private.png` |
| Small promo tile (440×280) | `tile-small.png` |
| Marquee promo tile (1400×560, optional) | `tile-marquee.png` |

**Official URL:** none (it requires a verified domain). **Homepage URL:**
`https://github.com/amaltaas-studio-llc/ShoutPhish`. **Support URL:**
`https://github.com/amaltaas-studio-llc/ShoutPhish/issues/new/choose`.

## Privacy practices tab

**Single purpose:**

```text
Shows the phishing risk of the email open in Gmail, with an explanation of each finding, so the reader can decide whether to trust it.
```

**Permission justifications:**

`storage`

```text
Saves the user's settings (display options, whether optional AI is on, the address of the user's own AI server) and the list of senders the user chooses to trust. No message content is stored.
```

Host permissions (`https://mail.google.com/*`, and the optional `http://localhost/*`, `http://127.0.0.1/*`, `https://*/*`):

```text
https://mail.google.com/* is the only site ShoutPhish runs on: its content script reads the open message from the page to check it for phishing. All checks run locally in the tab.

The optional entries are not granted at install and are never requested automatically. They exist for one opt-in feature: a user who runs their own AI model server can enter its address in the settings page and click Connect, which requests access to that one origin only, through Chrome's permission prompt. Loopback addresses cover a server on the user's own machine (Ollama, LM Studio); the https pattern exists because such a server can be hosted anywhere the user chooses, and Chrome can only grant an origin that a manifest pattern covers. The address comes only from the user's settings, never from an email, and the service worker checks the grant before every request.
```

**Remote code:** No, I am not using remote code. (All JavaScript is in the package; the extension pages'
CSP is `script-src 'self'`.)

**Data usage.** The store requires declaring data that is handled even when it never leaves the device.
Tick:

- **Personally identifiable information**: the sender's and other participants' names and email addresses.
- **Personal communications**: the content of the email being checked.
- **Website content**: the text and links of the Gmail message view.

Leave the rest unticked: health, financial and payment, authentication, location, web history, and user
activity. ShoutPhish keeps no history of what is read and records no clicks or browsing.

Tick all three certifications: data is not sold to third parties, not used or transferred for purposes
unrelated to the single purpose, and not used to determine creditworthiness.

**Privacy policy URL:** `https://github.com/amaltaas-studio-llc/ShoutPhish/blob/main/PRIVACY-POLICY.md`

## Distribution tab

Free, all regions. Visibility is a choice: **Unlisted** installs from a link only and suits a first
release; **Public** appears in search and category pages. It can be changed later.

## Test instructions tab

Leave Username and Password empty. **Additional instructions** (the field holds 500 characters; this is 484):

```text
Only a Gmail account is needed. On install, a welcome page explains what is read; click "Start checking my mail" (until then the toolbar icon shows OFF). Open any email in Gmail: a badge appears by the sender, and clicking it opens a card explaining the score. Ordinary mail is Low Risk. To see a warning, email yourself from another Gmail account with the display name "PayPal Billing" and the text "Please verify your account": it shows High Risk. AI is optional and off by default.
```

## Review notes

Reading mail puts the item in the store's in-depth review, which can take from days to a few weeks. The
optional `https://*/*` pattern is the line most likely to draw a question; the justification above is the
answer, and `docs/PRIVACY.md` has the long form. Version updates usually review faster than the first
submission.

The prominent-disclosure requirement is met by the welcome page: the paragraph beside its button names
what is read, and nothing in Gmail is read before the click
([ADR 0014](adr/0014-consent-before-reading.md)).
