# Tests

Dependency-free verification for both halves of the plugin. Node 20+ (uses only
`node:` builtins). Run from the repository root:

```bash
node test/run.mjs
```

`run.mjs` executes, in order:

| Step | File | What it proves |
|---|---|---|
| syntax | `index.js`, `lib/client.js` | both files parse under the running Node |
| host acceptance | `test/check-host.mjs` | mounts `index.js` on a mock Cordis context, drives `session/event`/`session/disposed`, asserts the JSON contract of `/next-prompt/suggest`, `/next-prompt/config` and `/next-prompt/regenerate`: completed-turn generation (heuristic immediately + LLM refinement), fenced-JSON parsing, provider-failure and garbage fallbacks, subagent/short-answer/disabled suppression, `400/404/405` handling and state cleanup |
| client static | `test/check-client.mjs` | `window.__ModuleLoader__.load({ id, factory })` wrapper shape, factory materialises without DOM, `apply`/`inject` exports, `require()` targets limited to the shell baseline table, forbidden-syntax scan, `apply(ctx)` registers the composer overlay entry + locale dictionaries + style tag |
| client render | `test/render.mjs` | runs the shipped bundle on a fake DOM + fake React: ghost visibility predicates, placeholder hide/restore, measured geometry and relayout, `pending:true` heuristic→LLM polling, Tab accept through `inputActions.setDraft`, Escape/typing dismissal, disabled config and HTTP-failure degradation, zero requests while a turn runs |

The fakes are intentionally small and dependency-free (`test/fake-dom.mjs`,
`test/fake-react.mjs`); they implement only the DOM/React surface used by the
bundle. `test/test-bundle.js` is a structural fixture for the loader checks.

No real browser is involved — visual pixel alignment and the ordering of real
Lexical/menu handlers are verified manually in the running app.
