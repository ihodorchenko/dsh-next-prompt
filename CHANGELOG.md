# Changelog

## 0.1.0 — 2026-10-30

First public release.

- **Suggested next prompt in the message field.** After a completed assistant
  turn the Host half asks the model for a few short next messages and the
  browser half shows the best one as ghost text over the composer placeholder.
  Tab (or a click) inserts it as an ordinary draft; Escape or typing hides it.
  Nothing is sent automatically.
- **Host half** (`index.js`): listens to the durable `session/event` feed,
  collects the last human prompt and assistant answer through
  `session.deriveMessages()`, makes one small `ctx.llm.stream()` completion
  (cheapest reasoning effort, 512 output tokens, 15 s deadline,
  `AbortController` cancellation when superseded), and serves results at
  `GET /next-prompt/suggest`, `GET /next-prompt/config` and
  `POST /next-prompt/regenerate`. Root sessions only; subagent sessions,
  aborted/forked/interrupted turns and answers shorter than `minAnswerChars`
  are ignored. No session-log writes, no model-facing tools.
- **Deterministic fallback.** A language-matched heuristic list (ru/en) is
  published immediately and refined by the LLM; provider errors, timeouts and
  unparsable output leave the heuristic in place.
- **Browser half** (`lib/client.js`): hand-written lazy-CJS bundle (no build
  step) registering one entry in the `conversation.input.overlay` list slot.
  Detects turn completion through `useSessionStatus()` (`running` true→false),
  polls while the Host reports `pending:true`, aligns the ghost text to the real
  `[data-composer-placeholder]` (measured rects + copied computed styles, so it
  follows any theme), and degrades silently when DOM anchors or services are
  missing.
- **Configuration**: `enabled`, `maxSuggestions`, `showGhost`, `language`,
  `model`, `minAnswerChars` (all optional).
- **Packaging**: installable as a DSH bundle (`dsh plugin --profile <name> add
  link:<dir>` or from git), plugin-manager metadata (icon, en/ru descriptions),
  MIT license.
- **Tests**: dependency-free Host black-box, bundle static/fake-loader and
  fake-DOM render suites behind `node test/run.mjs`, plus GitHub Actions CI on
  Node 20/22/24.
