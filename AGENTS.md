# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, Cursor, …) working in this repository.

## Read first

| File | What it answers |
|---|---|
| `docs/STATUS.md` | What is verified, what is not yet, known limits, next candidates. **Start here.** |
| `docs/ARCHITECTURE.md` | How a diagnosis flows from the band to the Worker and back; apply, ledger, data boundaries |
| `docs/DECISIONS.md` | Why it is built this way (D1–D10). Check a decision's reason before changing it |
| `CHANGELOG.md` | What each release changed. Add an entry with every version bump |

Update `docs/STATUS.md` and `CHANGELOG.md` in the same commit as the change they describe.

## What this is

`cstoken-finops` is a Claude Code **mod**: a plugin of function hooks (one hooks module, no build step). It is the customer-facing client of **CSTOKEN FinOps**, a sub-tool of CSTOKEN.

- It draws a line above the prompt (`AbovePrompt`) and a side pane (`Pane`, id `finops`) and registers `/finops`.
- It sends the task to the CSTOKEN FinOps Worker at `https://finops.cstoken.net`, which classifies it with Cloudflare Workers AI `@cf/cloudflare/clef-flash`, recommends a Claude model + effort, and ranks installed and PluginWorld tools.
- **[적용]** runs `/model <id>` and holds the effort on main-thread requests through a `turn.step` hook. **[해제]** goes back.
- A `turn.complete` hook books each turn's list-price cost into a local ledger (`$.store`), read by `/finops report`.

The recommendation engine, question set, price table and catalog live on the server (a separate, private Worker project). This repository holds only the client. Keep it that way: no pricing logic, scoring rules or secrets in here.

## Layout

| Path | What it is |
|---|---|
| `.claude-plugin/plugin.json` | Manifest: name, version, `userConfig` (`apiKey` is `sensitive`), `types` |
| `.claude-plugin/marketplace.json` | Makes this repo installable: `/plugin install cstoken-finops --marketplace haminmarket/cstoken-finops` |
| `hooks/hooks.json` | Names the one hooks module |
| `hooks/register.tsx` | Every hook and every function that takes `$` |
| `hooks/lib.ts` | Pure helpers: request building, response validation, ledger math, display words. No `$` |
| `hooks/fixtures.ts` | A realistic Worker answer for tests |
| `hooks/*.test.ts` | Tests run by `claude plugin test` |
| `types/index.d.ts` | The API types (mirror of the Worker's `src/contract.ts`) and the `PluginState` contract |

## Commands

Requires Claude Code **2.1.295 or later** (the mod API is early access and moves between releases).

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

Run both before every commit. `validate` must say `✔ Validation passed`, and `test` must report `0 fail`.

To type-check, use the `tsconfig.json` the engine lays beside a loaded mod (`.claude-plugin/types/`, git-ignored), or the one in the header of the engine's `claude-code.d.ts`.

## Rules the engine enforces

`claude plugin validate` refuses a module that breaks these, so follow them up front:

- **`$` goes only to top-level functions.** Write `$.noun.method(...)` at the call site, or pass `$` to a function declared at the top of `register.tsx`. Never to a closure inside `register`, never destructured or spread. Closures in `onPress` and `onSubmit` may capture `$`.
- **State refs are literals.** `atom({ plugin: 'cstoken-finops', key: '<key>' } as const, initial)`. Every key must be declared under `'cstoken-finops'` in `types/index.d.ts`. Only this plugin writes its own state, and never while a `ui.render` hook draws: write from handlers and other events through `update($, atom, fn)`.
- **Environment variable names are string literals.** The mod reads only `CSTOKEN_FINOPS_API_KEY` and `CSTOKEN_FINOPS_ENDPOINT`.
- **Matchers use literal names**, e.g. `{ command: 'finops' }` and `{ component: 'Pane', requestId: 'finops' }`, so the validator sees that the command answers itself.
- **No `import()`**, no Node or DOM APIs. Everything outside the module goes through `$`: `$.http.fetch`, `$.store`, `$.clock` and so on.
- **Elements come from `$.ui.resolve(e)`**, never globals. `mobile` has no `Input` or `Select`, so check with `'Input' in el` before drawing them.

## Conventions

- **Names carry `finops`.** Anything a person reads or types says it: env vars `CSTOKEN_FINOPS_*`, key format `cst_finops_…`, command `/finops`, pane `finops`, title `CSTOKEN FinOps`.
- **UI copy is Korean.** Short sentences, plain words instead of probabilities (`level()`, `needWords()` in `lib.ts`), and costs through `formatUsd`. Each state of the band has one primary action.
- **Order in the pane:** answer first (the hero card), then the other options as cost bars against the current model, then the reading, tips, tools and spend. Keep that order.
- **Fail open.** No key, a Worker error, a timeout (9 s) or a malformed answer leaves the session as it was and says so ("현재 모델을 그대로 쓰세요"). Never switch a model on a guess.
- **Validate everything that crosses the network.** `parseResponse`, `pricesFrom` and `isQuota` in `lib.ts` check every answer before the pane draws it. Extend them when the contract grows.
- **Privacy is part of the product.**
  - Send only the task text, the chosen priority, the current model id and, when `shareInstalled` is on, installed names with one-line descriptions.
  - Never send file contents, the transcript, or any `.env`.
  - The spend ledger stays local.
- **Code style** follows `register.tsx`: short doc comments that say *why*, `is`/`has` prefixes for booleans, no semicolons, single quotes.

## API contract

Types are in `types/index.d.ts` and must match the Worker's `src/contract.ts`. If you change one, the other must change in the same release.

| Endpoint | Auth | Use |
|---|---|---|
| `POST /v1/diagnose` | Bearer organisation key | `DiagnoseRequest` → `DiagnoseResponse` (classification, recommendation with `current`, tools, `meta.quota`) |
| `GET /v1/models` | Bearer | Price table for the ledger, cached daily under `prices.v1`. `FALLBACK_PRICES` in `lib.ts` is used until it answers |
| `GET /v1/usage` | Bearer | Today's quota |
| `POST /v1/keys` | none | Closed (403): FinOps is customer-only, and keys are issued by CSTOKEN |

Errors come back as `{ error: { code, message } }`. `failureText()` maps them to Korean (401 key rejected, 413 too long, 429 quota or rate limit).

## Tests

- Test through the engine's kit (`claude-code/testing`).
- Mock every noun the plugin calls beneath it (`mock.env`, `mock.store`, `mock.clock`, plus `on('http.fetch' | 'session.model' | 'command.run' | …)`). An unmocked call throws.
- Mount UI tests on **both** `terminal` and `desktop` when they use `Input`.
- Op events (`http.fetch`, `session.model`, `ui.open`, …) answer `{ value }`. Engine events (`command.run`, `prompt.fill`, `turn.complete`) answer their result directly.
- Add a test for every new behaviour. The existing tests describe it in their names.

## Releasing

1. Bump `version` in `.claude-plugin/plugin.json` and the plugin entry in `.claude-plugin/marketplace.json`, and add a `CHANGELOG.md` entry.
2. `claude plugin validate .` and `claude plugin test .` must both pass.
3. Commit and push to `main`. Customers update with `claude plugin update cstoken-finops`.

Never commit keys, `.env` files or engine-laid types (`.claude-plugin/types/`); `.gitignore` covers them. Before pushing, search the diff for `cst_finops_` followed by 40 characters.

## License

MIT, see `LICENSE`.
