**ShoutPhish privacy policy**

Effective 1 October 2026. ShoutPhish is published by Amaltaas Studio LLC ("we").

ShoutPhish is a browser extension that checks the email you open in Gmail for signs of phishing and explains what it found. This policy says what it reads, where that goes, and what it keeps. The technical detail behind every statement here is at [https://github.com/amaltaas-studio-llc/ShoutPhish/blob/main/docs/PRIVACY.md](https://github.com/amaltaas-studio-llc/ShoutPhish/blob/main/docs/PRIVACY.md), and the source code is public at [https://github.com/amaltaas-studio-llc/ShoutPhish](https://github.com/amaltaas-studio-llc/ShoutPhish), so each of them can be checked.

**What ShoutPhish reads**

Nothing, until you agree. When ShoutPhish is installed it opens a page that explains what it reads, and it reads nothing in Gmail until you click **Start checking my mail** on that page. You can stop it at any time with the switch at the top of its Settings page.

Once you have agreed, when you open a message in Gmail, ShoutPhish reads what Gmail already shows on screen for that message: the sender's name and address, the reply-to address, the subject, the visible text, the links and their destinations, attachment file names, Gmail's own sender-verification summary, and the senders of earlier messages in the same conversation. If you turn on inbox warnings, it also reads the sender's name and address on inbox rows.

It never opens a link, downloads an attachment, loads an image, or fetches anything named in a message.

**Where it is analysed**

On your computer, inside your browser. Every check runs in the Gmail tab. **By default, ShoutPhish sends nothing to anyone**: it makes no network requests, has no server, and has no account, analytics, advertising or tracking of any kind. We never receive your mail or anything about it.

Two optional features, both off until you turn them on:

- **Chrome's built-in AI.** The message text is given to the model built into Chrome, which runs on your computer. It is not sent anywhere by ShoutPhish.
- **Your own AI server.** If you enter the address of a model server you run (for example Ollama on your own machine), ShoutPhish sends that server the sender's display name, the subject and an excerpt of the message text, and nothing else. It goes only to the address you entered, and only after you click **Connect** and your browser asks you to allow that address. We do not operate or have access to that server; whoever runs it is responsible for what it does with the data.

**What it keeps**

Results stay in the tab's memory and are gone when you close it. The only things saved are your settings and the list of senders you choose to trust. Your browser stores them, and if you use your browser's own sync, it copies them to your other signed-in browsers; we never receive them. Both are shown on the settings page, where you can change or delete them. No message text, subject, score or history of what you read is ever saved.

**Diagnostic reports**

The toolbar menu can copy a diagnostic report for you to paste into a bug report yourself. It contains the names of the checks that ran and counts, never text, addresses or links from a message. Nothing is sent unless you paste it somewhere.

**Sharing and sale**

We do not collect your data, so there is nothing for us to share or sell. ShoutPhish does not transfer user data to anyone except the model server you configure yourself, as described above, and never for advertising, profiling or creditworthiness.

**Browser store policies**

The use of information received through ShoutPhish adheres to the Chrome Web Store User Data Policy ([https://developer.chrome.com/docs/webstore/program-policies/policies](https://developer.chrome.com/docs/webstore/program-policies/policies)), including the Limited Use requirements. Message content is used only to show you the risk of the message in front of you; no person reads it, and it is not used or transferred for any other purpose.

In Firefox, ShoutPhish follows Mozilla's Add-on Policies ([https://extensionworkshop.com/documentation/publish/add-on-policies/](https://extensionworkshop.com/documentation/publish/add-on-policies/)) and uses Firefox's own data-sharing consent. It tells Firefox that it collects nothing by default, and Firefox asks for your permission to share message content before ShoutPhish can send anything to an AI server you set up.

**Children**

ShoutPhish is a general-purpose tool and does not knowingly collect information from anyone, including children.

**Changes**

If what ShoutPhish reads, keeps or sends ever changes, this policy will be updated before the release that changes it, and the change will be described in that release's notes. The history of this file is public in the repository.

**Contact**

Questions about this policy: open an issue at [https://github.com/amaltaas-studio-llc/ShoutPhish/issues/new/choose](https://github.com/amaltaas-studio-llc/ShoutPhish/issues/new/choose). Privacy or security problems you would rather not discuss in public: report them privately as described at [https://github.com/amaltaas-studio-llc/ShoutPhish/blob/main/SECURITY.md](https://github.com/amaltaas-studio-llc/ShoutPhish/blob/main/SECURITY.md).
