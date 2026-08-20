# dsh-market-watch

**English · [简体中文](README.zh.md)**

A financial market monitor bundle for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh):
real-time quotes, a local watchlist, threshold alerts, periodic polling, and
in-chat ASCII/mermaid charts for A-share stocks/indices and cryptocurrencies —
using free public data sources only. This is the first market/finance data
plugin in the dsh ecosystem.

- **Quote** — latest quotes for stocks, indices, and crypto via free sources
  (Tencent `qt.gtimg.cn` for CN securities, CoinGecko for crypto).
- **Watchlist** — locally persisted watch items (code / name / market / kind),
  shared by the plugin and the CLI.
- **Alerts** — threshold rules (`changePercent` / `price`, `gt/gte/lt/lte`)
  evaluated on every poll, with per-rule cooldowns. Delivery: a typed harness
  event `market-watch/alert` plus optional injection into live agent sessions.
- **Polling** — timer-based periodic refresh of the whole watchlist
  (overlapping ticks are dropped; free sources are rate-limit friendly).
- **Charts** — ASCII column charts, sparklines, and mermaid `xychart-beta`
  blocks rendered in chat.
- **Dual entry** — six dsh tools (`quote`, `list`, `watch`, `unwatch`, `alert`,
  `chart`) and a standalone CLI (`dsh-market-watch`) over the same data.

## Data sources and latency

| Market | Source | Notes |
| --- | --- | --- |
| Shanghai / Shenzhen / Beijing stocks & indices | Tencent `qt.gtimg.cn`, `web.ifzq.gtimg.cn` | Free endpoints; quotes may lag the tape by seconds to minutes. Daily bars are qfq (forward-adjusted) for stocks, raw for indices. |
| Crypto | CoinGecko public API | Free tier is rate limited (calls are spaced by `coingeckoDelayMs`, `Retry-After` honored). Prices may lag; OHLC from `market_chart` is bucketed to UTC days. |

All quotes carry a per-source disclaimer (`delayNote`). **Nothing here is
investment advice**; never trade on delayed free data without verification.

## Requirements

- Node.js `^22.19 || >=24`
- dsh `>=0.1.0-rc.6` with the `web` or `headless` profile

## Install as a dsh bundle

A bundle is an npm package whose manifest declares `dsh.bundle.patch` (this
package ships `cordis.patch.yml` plus a `lib/` build). Two typical paths:

```bash
# 1. From a local checkout of this repo:
pnpm build                # or: npm run build
dsh plugin --profile web add .  # relative/absolute path to this directory

# 2. Git-hosted installs run the prepare script on install; pnpm >= 10 blocks
#    build scripts until allowlisted — add to the profile's pnpm-workspace.yaml:
#      allowBuilds:
#        dsh-market-watch: true
#    then:
dsh plugin --profile web add github:some-owner/dsh-market-watch
```

`dsh plugin` adds the package to the profile's `dsh.profile.bundles` list
because it declares `dsh.bundle`; the patch inserts the `market-watch` row and
the plugin's tools appear in every agent prompt after a restart.

Verify:

```bash
dsh config dump | grep market-watch   # row present
```

### Configuration

Every option has a default; the bundle row ships without a `config` section.
Override by id in your profile's `cordis.patch.yml` — remember a patch
replaces the **whole** config value, so restate every key you keep (copy
`examples/cordis.patch.example.yml`):

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch for the plugin. |
| `pollIntervalSeconds` | `60` | Poll period (schema: 5..86400). |
| `dataDir` | `$DSH_HOME/market-watch` | Directory holding `watchlist.json`. |
| `timeoutMs` | `10000` | Per-request network timeout. |
| `maxRetries` | `2` | Extra attempts after the first try. |
| `retryBackoffBaseMs` | `500` | Exponential backoff base. |
| `vsCurrency` | `usd` | Crypto quote currency (CoinGecko id). |
| `coingeckoDelayMs` | `1200` | Min spacing between CoinGecko calls. |
| `agentNotify` | `true` | Deliver alerts into live dsh agent sessions. |
| `agentWakeup` | `false` | Wake idle agents on alert (`followup`) instead of quiet `inject`. |

## Tools

Registered on `ctx.tools`; their schemas join the system prompt automatically.

| Tool | Purpose |
| --- | --- |
| `quote` | Latest quotes for `codes` (array), e.g. `["sh600000","000001","bitcoin"]`. Optional `days` appends a sparkline per instrument (one history request each). |
| `list` | The local watchlist. |
| `watch` | Add instruments: `codes` (array), optional `market` (`cn`/`crypto`), `kind` (`stock`/`index`/`crypto`), `name`. |
| `unwatch` | Remove one instrument by code. |
| `alert` | Manage rules: `action` = `list` \| `add` \| `remove`. `add` needs `code`, `field` (`changePercent`/`price`), `op` (`gt`/`gte`/`lt`/`lte`), `value`, optional `cooldownSeconds` (default 300) and `note`; `remove` needs the rule `id` from `list`. |
| `chart` | `code`, optional `days` (default 30), `format` (`ascii`/`mermaid`), `width`, `height`. |

Accepted code forms for CN instruments: `sh600000`, `600000.sh`, `600000.ss`,
`600000` (prefix inferred from the leading digit), `000001` with `kind: index`
for the Shanghai Composite. Everything else is treated as a CoinGecko id
(`bitcoin`, `ethereum`, …).

Tools never throw for expected failures — they return `{ok:false, error}` so
the model can act on the message.

## Alerts

Rules live in the same file as the watchlist and are evaluated on every poll.
A rule fires when the comparison holds and the cooldown window since the last
trigger has elapsed; `lastTriggeredAt` is persisted.

Delivery channels (both best-effort, failures contained):

1. Harness event — `ctx.emit('market-watch/alert', alert)`. Any extension can
   listen:

   ```ts
   ctx.on('market-watch/alert', (alert) => { /* alert.message, alert.quote, alert.rule */ })
   ```

2. Agent sessions — when `ctx.agents` is mounted, every live agent receives the
   alert as a plugin-sourced `user/message`: quiet context for the next step
   (`agent.inject`) by default, or a full follow-up turn with `agentWakeup:
   true`.

## CLI

`dsh-market-watch` runs on the same data directory as the plugin, so commands
act on the exact state the plugin polls.

```bash
dsh-market-watch quote sh600000 bitcoin --days 5
dsh-market-watch watch sh600000 bitcoin --name "BTC"
dsh-market-watch list
dsh-market-watch unwatch sh600000
dsh-market-watch alert list
dsh-market-watch alert add bitcoin --field price --op gte --value 70000 --cooldown 600
dsh-market-watch chart sh600000 --days 30 --format mermaid
dsh-market-watch poll --once          # single pass (cron-friendly)
dsh-market-watch poll --interval 300  # keep polling every 5 min
```

Global flags: `--data-dir <path>` (or `MARKET_WATCH_DATA_DIR`), `--help`,
`--version`. Exit codes: `0` ok, `1` runtime error, `2` usage error.

## Data files

`<dataDir>/watchlist.json` — JSON document `{version, items, rules}`. Writes
are atomic (temp file + rename), serialized through a promise chain, and a
corrupt file is quarantined (`watchlist.json.corrupt-<ts>`) instead of
wedging the plugin. Because the plugin and the CLI share one file, the engine
re-reads it on every poll/json quotation, so edits made in a second process
become visible without a restart.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest (all network paths mocked)
npm run build       # tsc -> lib/
npm run check       # typecheck + test + build
```

Layout: `src/core/` is framework-free (types, symbols, formatting, HTTP
client, JSON store, chart renderers, providers, engine) so the CLI and tests
share it without importing dsh; `src/dsh/` adapts the core to Cordis (tools,
poller, notifier, entry point); `src/cli/` is the standalone binary.

## License

MIT — see [LICENSE](LICENSE).
