# Design decisions

Short records of structural choices and the alternatives that were rejected. Read these when you
are about to change the decision they describe; day-to-day work starts from
[ARCHITECTURE.md](../ARCHITECTURE.md) and [AGENTS.md](../../AGENTS.md).

| ADR | Title |
| --- | --- |
| [0001](0001-esbuild-not-vite.md) | esbuild, not Vite; zero runtime dependencies |
| [0002](0002-mv3-state-in-content-script.md) | Analysis state and the model session live in the content script |
| [0003](0003-gmail-two-signals.md) | Gmail view changes from hash and DOM, cross-checked |
| [0004](0004-scoring-floors-and-weights.md) | Scoring weights sum to 100; severity floors for single-dimension attacks |
| [0005](0005-false-positive-resistance.md) | Dampen content carefully; never silence identity via trust |
| [0006](0006-llm-cannot-outvote-checks.md) | The model is capped and cannot originate a score |
| [0007](0007-list-row-sender-only.md) | Inbox-row marks are sender-only warnings, never an all-clear |
| [0008](0008-no-ui-framework-shadow-dom.md) | Hand-built UI in Shadow DOM; card pinned, not modal |
| [0009](0009-model-server-and-inert-cloud.md) | Optional local model server; cloud designed but not shipped |
| [0010](0010-hostile-input-posture.md) | Nothing from a message is fetched or executed |
| [0011](0011-ci-harness-no-dist-in-repo.md) | verify includes build and dist check; no committed dist/ |
| [0012](0012-one-source-per-browser-manifests.md) | One source tree; a manifest per browser family, chosen at build time |
| [0013](0013-firefox-signed-unlisted.md) | Firefox builds are signed by Mozilla for self-distribution, not listed |
| [0014](0014-consent-before-reading.md) | Nothing in Gmail is read until the reader agrees on the welcome page |

Each file uses the same shape: **Status**, **Context**, **Decision**, **Consequences**,
**Rejected alternatives**.
