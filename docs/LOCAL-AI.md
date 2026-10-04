# Local AI

What the language model is asked, what it may change, and how to turn it on. Caps and history:
[adr/0006](adr/0006-llm-cannot-outvote-checks.md),
[adr/0009](adr/0009-model-server-and-inert-cloud.md).

AI is **off** until chosen (welcome page or Settings). Default install makes no model calls.

## One interface

`ChromePromptAnalyzer` (Chrome’s built-in model), `ModelServerAnalyzer` (a server you run), and an inert
`CloudAnalyzer` share:

```ts
interface SemanticAnalyzer {
  isAvailable(): Promise<boolean>;
  analyze(email: EmailMessage, options?: { signal?: AbortSignal }): Promise<SemanticAnalysis | null>;
}
```

The model returns structured JSON only: `risk` (0–100), `categories`, up to three short `reasons`, and
`confidence`. The card names the source; scoring and UI otherwise treat all analyzers the same.

## Three guarantees

Asserted in `test/semantic.test.ts`:

1. **Cap.** The `llm` category is at most 15 of 100 points, additive. It cannot remove a finding, lower a
   score past a deterministic floor, or change a classification alone.
2. **No origination.** Without a corroborating deterministic signal, the model contributes **zero**.
3. **Separate UI.** Model output is labelled as an assessment, not a technical observation.

## What the model sees

Display name, subject, and body (body capped). **No** sending domain, Reply-To, link destinations, or
attachment types; those are checked in `analysis/rules/` from the real values. The prompt asks for the
requested action before tone; concerning reasons should quote a short excerpt from the mail (any language)
and explain in English. Each reason is asked to be one sentence of at most 15 words, so it reads as one
line on the card; the parser allows up to 20 and cuts anything longer on a sentence or word boundary,
never mid-word. The limits are `reasonWords` and `maxReasonWords` in `scoring/config.ts`.

Calibration also applies a dead zone (low risk scores zero) and drops routine categories from the headline
when they add nothing. Details of thresholds live next to scoring config; see
[DETECTION.md](DETECTION.md).

## Chrome’s on-device model

Implemented in `src/analysis/llm/chrome-prompt.ts` / `on-device.ts`. The Prompt API surface has moved
between builds; the code probes shapes and fails closed to “unavailable.”

- Turn on **On-device AI** in `chrome://settings/system`. Chrome may download several GB on eligible devices
  ([Google’s help](https://support.google.com/chrome/answer/16961953)).
- Opening mail never starts a download. The welcome page can, **on a click**, after you choose the local model.
- `downloadable` / `downloading` count as unavailable for analysis until ready.
- Other Chromium browsers load the same build. Stable Edge offers extensions no Prompt API today, so the
  probe reports `unsupported` there, and the welcome page says so without sending the reader to Chrome's
  settings, which could not fix it (`browserFamily` in `src/welcome/guidance.ts`). A browser that ships the
  same `LanguageModel` global is used without a code change.
- Where the probe reports `unsupported` (Edge, Firefox), the welcome and options pages grey the choice out
  with the reason beside it (`onDeviceChoice` in `src/shared/on-device-choice.ts`). The gate is the probe,
  not the browser's name, so it lifts by itself wherever a model appears. A mode already set to on-device
  is left as it is and labelled as doing nothing here, rather than rewritten behind the reader's back.

### When there is no assessment

| Status | Meaning |
| --- | --- |
| `ready` | Assessment produced |
| `pending` | Inference in flight |
| `skipped` | Not asked (nothing could corroborate); card can ask anyway |
| `off` | User disabled AI |
| `unavailable` | No model / not configured |
| `no-output` | Ran but failed schema validation |
| `error` | Timeout or session failure |
| `cancelled` | Reader moved on |

By default the model is asked only when a technical check already found something. Readings are reused
while the prompt would be unchanged; cancelled or failed attempts are not cached as answers.

## Operational rules

- `temperature: 0`, `topK: 1` where supported; JSON schema constraint with unconstrained retry.
- Declare English **output**; where accepted, input languages `en`, `de`, `es`, `fr`, `ja`. Availability
  probes stay output-only.
- Malformed JSON, or a missing `risk`, `confidence` or usable reason → discard entirely. Within the lists,
  a non-string reason or an unknown category is dropped rather than failing the whole answer.
- 20 s inference timeout; one prompt at a time (queued); cancel via `AbortSignal`.
- Session lives in the **content script**; each message uses a clone (or a fresh session) so prior mail
  cannot steer later verdicts.
- Warm-up at startup never downloads a model.

## Your own model server

Settings → AI mode **Model server**. OpenAI-compatible `POST …/chat/completions`. Same 15-point cap and
corroboration rules: a larger model buys better reasons, not more weight.

- Base URL from settings; `http:` only for loopback; otherwise `https:`.
- Optional host permission requested per origin on a click from the options page, and checked by the
  worker before every request, since Chrome alone would still send an ungranted one.
- The server has to allow the extension's origin, which differs by browser: `chrome-extension://*` for
  Chrome and Edge, `moz-extension://*` for Firefox (for Ollama, both in `OLLAMA_ORIGINS`, comma-separated,
  set before it starts). A server allowing one refuses the other with 403, and Firefox omits `Origin` from
  the model-list GET, so on Firefox the connection test also sends a POST that only the origin check
  answers (`originRefusal` in `src/background/index.ts`).
- Endpoint and system prompt never arrive in a runtime message
  ([adr/0009](adr/0009-model-server-and-inert-cloud.md)); a Gmail tab can change only the trust list.

## Cloud

Designed and left inert. No default backend; not offered in options unless already stored. Do not
implement as a side effect of other work.

## Trying prompts on a real model

Unit tests use fakes. For a real comparison, `npm run eval:prompts` exports paired requests; it contacts
nothing by itself. Synthetic cases live in `test/fixtures/semantic/cases.json`. Do not claim accuracy gains
from unit tests alone.
