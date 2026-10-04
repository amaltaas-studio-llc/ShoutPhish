<div align="center">

<img width="100%" alt="ShoutPhish: a second look before you click. The logo, a lens scanning a fish with signal waves rising from it, beside a magnifying lens that picks out the letters r and n in a sender address pretending to be Microsoft, next to a red High Risk badge scoring 76 out of 100." src="docs/assets/hero.svg">

<br>

<a href="https://github.com/amaltaas-studio-llc/ShoutPhish/releases/latest"><img alt="Download the latest release" src="https://img.shields.io/github/v/release/amaltaas-studio-llc/ShoutPhish?label=download&color=6366f1&style=for-the-badge"></a>
<img alt="Works in Chrome and Microsoft Edge, version 120 and later" src="https://img.shields.io/badge/Chrome%20%7C%20Edge-120%2B-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white">
<img alt="Works in Firefox, version 140 and later" src="https://img.shields.io/badge/Firefox-140%2B-FF7139?style=for-the-badge&logo=firefoxbrowser&logoColor=white">
<img alt="No network requests in the default configuration" src="https://img.shields.io/badge/uploads-none%20by%20default-3b1f8c?style=for-the-badge">
<a href="LICENSE"><img alt="MIT licence" src="https://img.shields.io/badge/licence-MIT-blue?style=for-the-badge"></a>

### Spot the signs of phishing in Gmail, with reasons you can check for yourself.

[**Install**](#install-in-two-minutes) · [How it works](#how-it-works) · [What the badge means](#what-the-badge-means) ·
[Privacy](#your-mail-stays-yours) · [Settings](#make-it-yours) · [Questions](#questions)

</div>

<br>

ShoutPhish is a free, open-source extension for Chrome, Edge and Firefox that puts a risk score beside the sender of every email
you open in Gmail. Click it and ShoutPhish shows you **what looks unusual, why it matters, and the exact
evidence**, down to the letter in an address that does not belong. It runs on your computer, needs no
account, and sends your mail nowhere.

<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/in-message-dark.png">
  <img width="838" alt="A Gmail message with a red High Risk badge beside the sender, and the ShoutPhish card open over the lower right of the message, explaining that the sending domain imitates Microsoft and that a link names Microsoft in front of an unrelated domain." src="docs/assets/in-message.png">
</picture>
</div>

## Why ShoutPhish

<table>
<tr>
<td width="33%" valign="top">

### 🔍 It shows its work

No mystery verdicts. Every point of the score comes with a plain-language reason and the evidence
behind it. Hover a finding and ShoutPhish highlights the part of the message it came from.

</td>
<td width="33%" valign="top">

### 🤫 It stays quiet on ordinary mail

A checker that cries wolf gets switched off. Most of the effort goes into *not* flagging your invoices,
newsletters and password resets, so a warning means something when it appears.

</td>
<td width="33%" valign="top">

### 🔒 Your mail stays on your computer

No account, no uploads, no tracking. ShoutPhish reads what Gmail already shows you and never opens a link
or an attachment to do it.

</td>
</tr>
</table>

## How it works

<div align="center">
<img width="838" alt="How ShoutPhish works, in three steps. One: open an email in Gmail as you always do; there is nothing to set up and nothing to click. Two: ShoutPhish takes a second look at the sender, links, requests and attachment names, all inside your browser. Three: a badge appears beside the sender. Green means few warning signs, red means stop and check, and clicking it shows every reason." src="docs/assets/steps.svg">
</div>

### What it notices

A familiar name can hide an unfamiliar address. A convincing link can lead somewhere else. ShoutPhish
brings those details into view while you read.

<div align="center">
<img width="838" alt="What ShoutPhish notices, in four cards. The sender: lookalike addresses such as rnicrosoft for microsoft, misleading display names, and replies that imitate someone already in the conversation. The links: text that names one place while the destination is another, or a trusted name placed in front of an unrelated address. The request: verification codes, payments, changed bank details or gift cards, and pressure to act right now. The attachments: programs and disguised file types, judged from the file name alone, without opening or downloading anything." src="docs/assets/notices.svg">
</div>

## Real results, not mock-ups

Both of these cards are the real ShoutPhish component, run against the examples in the project's tests.

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/card-dark.png">
  <img width="404" alt="The card scoring a message 76 out of 100, High Risk, in a ring coloured by where the points came from, mostly links and sender. The first finding, marked critical, is that a link places Microsoft's name in front of an unrelated domain, with the real destination shown beneath it." src="docs/assets/card-light.png">
</picture>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/card-low-dark.png">
  <img width="404" alt="The card scoring an ordinary supplier invoice 12 out of 100, Low Risk, all from wording: one low finding about the invoice request with the quoted sentence beneath it, and a note that the attachment was named but never opened." src="docs/assets/card-low.png">
</picture>
</p>

<table>
<tr>
<td width="50%" valign="top">

**🚩 A fake Microsoft alert: 76/100.** The sender's address is a
near-identical imitation, and the "sign in" link reads as Microsoft
while going somewhere else. Both findings show the evidence, so you
can check them yourself.

</td>
<td width="50%" valign="top">

**✅ An ordinary supplier invoice: 12/100.** The same checks run, and
the one thing they notice stays a quiet note. Everyday mail is the
common case, and it is what the scoring is tuned against.

</td>
</tr>
</table>

## What the badge means

The score sums up the warning signs ShoutPhish found. It is **not** a percentage chance that a message is
phishing. The same colour appears on the ShoutPhish icon in your toolbar.

<div align="center">
<img width="838" alt="What each badge means. Low Risk, scores 0 to 24: few or no warning signs, and not a guarantee, so stay as careful as you normally would. Caution, 25 to 49: some details deserve a closer look; open the badge to see which. Suspicious, 50 to 74: significant warning signs; check the request through a contact or website you already know. High Risk, 75 to 100: strong warning signs; do not use the message's links or attachments to follow up. Not checked, no score: ShoutPhish could not read enough of the message to judge it, which is not a sign that it is safe." src="docs/assets/levels.svg">
</div>

<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/badges-dark.png">
  <img width="760" alt="The badge beside five senders in a Gmail header: Low Risk 8 out of 100 in green, Caution 34 out of 100 in amber, Suspicious 50 out of 100 in light red, High Risk 75 out of 100 in solid red, and a dashed grey Not checked badge on a message whose sender could not be read." src="docs/assets/badges.png">
</picture>
</div>

<details>
<summary><strong>Why "Not checked" exists</strong></summary>

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/card-unreadable-dark.png">
  <img width="404" alt="The card headed Not checked, explaining that ShoutPhish could not read who the message is from, that this is not a judgement that the message is safe, and offering a diagnostic report to copy." src="docs/assets/card-unreadable.png">
</picture>

Gmail changes its page layout from time to time. When ShoutPhish cannot find a part of the message it
depends on, it tells you, rather than scoring what it managed to read. A confident **Low Risk** on a
message nobody actually checked is the one mistake this project refuses to make. The card offers a short
report naming what it could not find. The report contains none of your mail, and you can read it before
sending it anywhere.

</details>

> [!IMPORTANT]
> ShoutPhish is a reading aid, not a filter. It does not block links, downloads or replies, and a low
> score does not guarantee that a message is safe.

## Your mail stays yours

An extension that reads your email should be completely clear about what it does with it.

<div align="center">
<img width="838" alt="Five promises. Nothing is uploaded: messages are analysed inside your browser, and out of the box ShoutPhish makes no network requests. No account, analytics or tracking: there is no ShoutPhish server and nothing that records what you read. No copy of your mail is kept: message content is never saved to disk; results live in memory until you close the tab, and only settings and trusted senders are saved. Nothing in a message is opened: ShoutPhish never visits links, loads images or opens attachments; it reads the text and file names Gmail already shows you. Just two permissions: access to Gmail, and storage for your settings. The optional AI server connection asks separately, for the one address you choose." src="docs/assets/privacy.svg">
</div>

> [!NOTE]
> If you choose to connect your own AI model server, ShoutPhish sends it the sender's display name, the
> subject, and an excerpt of the message. A server on another computer receives that over the network.
> This only happens if you set it up yourself; it is never on by default.

[Read the full privacy and security details →](docs/PRIVACY.md)

## Install in two minutes

**You need:** Gmail on a computer, in Chrome or Microsoft Edge 120 or later, or Firefox 140 or later. Other
browsers built on the same engine as Chrome, such as Brave, Opera and Vivaldi, should accept the Chrome
download but are not tested yet. Safari is not supported yet. ShoutPhish does not run in the Gmail phone apps
or in other email programs.

**In Chrome or Edge:**

1. Open the **[latest release](https://github.com/amaltaas-studio-llc/ShoutPhish/releases/latest)** and, under
   **Assets**, download `shoutphish-<version>.zip`. (Not the **Source code** downloads.)
2. Unzip it into a folder you will keep, for example `Documents\ShoutPhish`.
3. Type `chrome://extensions` into Chrome's address bar, or `edge://extensions` into Edge's, and switch on
   **Developer mode** (top right in Chrome, in the left-hand panel in Edge).
4. Click **Load unpacked** and choose the unzipped folder, the one containing `manifest.json`.
5. Open or refresh Gmail and open an email you received. Look for the badge beside the sender. 🎉

**In Firefox:**

1. From the same **[latest release](https://github.com/amaltaas-studio-llc/ShoutPhish/releases/latest)**,
   download `shoutphish-firefox-<version>.xpi`.
2. Type `about:addons` into the address bar, click the gear icon, and choose **Install Add-on From File**.
3. Choose the downloaded file and click **Add** when Firefox asks, then open or refresh Gmail.

The Firefox download is signed by Mozilla, so it stays installed when Firefox restarts. It is not listed in
Mozilla's add-on store, which is why it comes from the release page instead.

Nothing else to configure: every core check works straight away. Pin ShoutPhish from the browser's
Extensions menu (the puzzle-piece icon) to keep its score and settings one click away.

<details>
<summary><strong>Updating a manual install</strong></summary>

<br>

Download and unzip the newer release over the same folder, click **Reload** on ShoutPhish at
`chrome://extensions` (or `edge://extensions`), then refresh Gmail. In Firefox, install the newer `.xpi` the
same way you installed the first one; it replaces the old version and keeps your settings. Manual installs
do not update themselves.

</details>

## Make it yours

Open **ShoutPhish in the browser toolbar → Settings**.

**🔕 Keep the inbox calm.** Hide the badge on low-risk mail, or turn on small warnings in the inbox list
itself. Inbox warnings can only see who a message is from (there is no message body or links to read from
the list), so a row without a warning means "not checked", not "safe".

<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/inbox-list-dark.png">
  <img width="760" alt="An inbox list where most rows carry no marker and four carry a small red warning beside the subject." src="docs/assets/inbox-list.png">
</picture>
</div>

**🤝 Trust the senders you know.** For eligible messages, the card offers to trust an address or a domain.
Trust softens notes about *wording*, and only while Gmail confirms the sender really is who they claim. It
never silences a warning about identity, links or attachments, so trusting `paypal.com` can never quieten
`paypa1.com`. Nothing is hidden, and one click undoes it.

**✨ Add optional AI.** AI is off until you turn it on. Where Chrome offers its built-in on-device model,
ShoutPhish can use it to add a view on the message's wording, and the welcome page walks you through
switching it on. Edge and Firefox do not offer one to extensions today. The AI is deliberately kept on a short leash: it can add at most 15 of the 100 points, it
cannot remove a finding, and it cannot raise a score that the checks do not already support. To save time
and battery it is only asked about messages where a check has already found something; the card tells you
when it was not asked and offers to ask anyway. Advanced users can connect their own model server.
[AI availability and setup →](docs/LOCAL-AI.md)

## Questions

<details>
<summary><strong>Is ShoutPhish free?</strong></summary>

<br>

Yes. It is free and open source under the MIT licence, with no paid tier, no account and no API key.

</details>

<details>
<summary><strong>Does ShoutPhish read my email?</strong></summary>

<br>

It reads the message you have open, in your own browser, the same way you do. Nothing is sent to
ShoutPhish or anyone else, and nothing is kept after you close the tab. The code is public, so anyone can
confirm this. [Full privacy details →](docs/PRIVACY.md)

</details>

<details>
<summary><strong>Will it slow Gmail down?</strong></summary>

<br>

No. ShoutPhish starts only after Gmail has finished loading, and it looks at an email after Gmail has
already shown it, so opening a message never waits for it. The score simply appears beside the message a
moment later.

The checks run on your own computer, with nothing sent to a server, and the bottom of the card shows
exactly how long they took. The optional AI is slower, so its reading is added afterwards without holding
anything up. By default it is only asked when a check has already found something.

</details>

<details>
<summary><strong>No badge appears</strong></summary>

<br>

Refresh Gmail after installing, and open a message you *received*; your own sent replies are not scored.
Low-risk badges may be switched off in Settings. Click the ShoutPhish toolbar icon to see what it is doing
on the current tab.

</details>

<details>
<summary><strong>A result looks wrong</strong></summary>

<br>

With the message open, click the ShoutPhish icon in the toolbar and choose **Copy a diagnostic report**.
It names the checks that ran and what each added to the score, without any text from the message. Then
[open an issue](https://github.com/amaltaas-studio-llc/ShoutPhish/issues/new/choose) and pick the form that
fits: a genuine email flagged, a phishing email missed, or something not working. Each form says what to
include. Please describe the email rather than pasting it, and leave out names, addresses, links and
screenshots of real mail.

</details>

<details>
<summary><strong>What can't it do?</strong></summary>

<br>

ShoutPhish can miss phishing, and it can flag genuine mail. It reads what Gmail displays, so a change to
Gmail's layout can stop a check working until ShoutPhish is updated. The wording checks cover English,
Spanish, French, German, Portuguese, Italian, Dutch, Hindi and Hinglish; the sender, link and attachment
checks help in any language. It never opens attachments and consults no blocklists or reputation
services: everything it knows comes from the message in front of you.

</details>

## Under the hood

For the technically curious, and anyone deciding whether to trust an extension with their inbox:

- **Zero runtime dependencies.** Every line that runs in your browser is in this repository and can be
  read. No frameworks, no third-party scripts, no remote code.
- **Rules first, AI second.** The score comes from deterministic checks that explain themselves. A
  language model, if you enable one, is capped at 15 points and scores nothing unless a check agrees.
- **Hostile input by default.** Every string in an email is treated as attacker-controlled: it never
  reaches the page as HTML, and nothing in a message is fetched or dereferenced.
- **Tested in both directions.** Every detection rule must catch its phishing example *and* leave every
  genuine example (invoices, password resets, newsletters, shared files and more) at Low Risk.

<div align="center">
<img width="838" alt="How ShoutPhish analyses a message: read from the Gmail page, extract the sender, links, attachments and authentication results, run deterministic checks, optionally consult a model capped at 15 points, then show a score from 0 to 100 as a badge and card. Every stage runs inside the browser." src="docs/assets/pipeline.svg">
</div>

| Document | What is in it |
| :--- | :--- |
| [Detection and scoring](docs/DETECTION.md) | Every category of check, how the 0–100 score is assembled, and how false alarms are held down. |
| [Privacy and security](docs/PRIVACY.md) | Permissions, exactly what data exists and where, and the threat model. |
| [Local AI](docs/LOCAL-AI.md) | The on-device model, connecting your own, and what a model is allowed to do. |
| [Development](docs/DEVELOPMENT.md) | Building, testing, the UI harness, project layout and releases. |
| [Architecture](docs/ARCHITECTURE.md) | A short map of where code runs and where to change what. |
| [Design decisions](docs/adr/) | Why not the obvious alternative. |

To build ShoutPhish yourself or help improve it, start with [CONTRIBUTING.md](CONTRIBUTING.md). To report a
security problem, please follow [SECURITY.md](SECURITY.md) rather than opening a public issue.

<br>

<div align="center">

<img src="assets/icons/icon128.png" width="64" height="64" alt="">

**ShoutPhish** · A second look before you click.

MIT licensed. An independent project, not affiliated with or endorsed by Google or any brand shown above.

</div>
