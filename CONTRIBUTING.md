# Contributing

Thanks for considering a contribution to `dsh-market-watch`.

## Setup

```bash
npm install
npm run build       # tsc -> lib/
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run check       # typecheck + test + build
```

Requires Node `^22.19 || >=24`.

## Project layout

- `src/core/` — dependency-free domain logic: `client` (quote fetching),
  `providers/` (Tencent, CoinGecko), `symbols` (symbol parsing/normalization),
  `store` (watchlist persistence), `engine` (alert evaluation/polling),
  `chart` (ASCII/mermaid rendering), `format`, `kinds`, `types`, `errors`.
- `src/dsh/` — dsh integration: `tools` (model-facing), `poller`
  (periodic polling), `notify` (in-chat delivery).
- `src/cli/index.ts` — standalone CLI; `src/index.ts` — bundle entry.
- `tests/` — vitest tests (helpers in `tests/helpers.ts`).

## Guidelines

- Add or extend a test under `tests/` for any behavior change.
- Keep `src/core/` free of `@deepseek-ai/*` imports; only the dsh layer may
  import dsh packages.
- Provider parsing must be defensive about missing/odd fields from remote
  APIs; add a test that feeds in a malformed payload.
- Update `README.md` (English) and `README.zh.md` (Chinese) together when the
  user-visible surface changes, and add a CHANGELOG entry under `[Unreleased]`.
