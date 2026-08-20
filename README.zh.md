# dsh-market-watch

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的金融行情监控插件：
实时报价、本地自选列表、阈值提醒、定时轮询，以及在会话内的 ASCII/mermaid 图表渲染，
覆盖 A 股股票/指数与加密货币——仅使用免费公共数据源。这是 dsh 生态中的首个行情/金融数据插件。

- **报价** — 股票、指数、加密货币的实时报价，免费数据源（A 股用腾讯 `qt.gtimg.cn`，加密货币用 CoinGecko）。
- **自选列表** — 本地持久化的自选标的（代码 / 名称 / 市场 / 类型），插件与 CLI 共用同一份数据。
- **异动提醒** — 阈值规则（`changePercent` / `price`，`gt/gte/lt/lte`），每次轮询时评估，带规则级冷却时间。
  投递方式：类型化事件 `market-watch/alert` + 可选的活跃 agent 会话内注入。
- **定时轮询** — 定时器驱动的全量自选刷新（并发 tick 自动去重，对免费源限流友好）。
- **会话内图表** — ASCII 柱状图、sparkline 迷你走势、mermaid `xychart-beta` 代码块。
- **双入口** — 六个 dsh 工具（`quote`、`list`、`watch`、`unwatch`、`alert`、`chart`）+ 独立 CLI（`dsh-market-watch`），共享同一套数据。

## 数据源与延迟说明

| 市场 | 数据源 | 说明 |
| --- | --- | --- |
| 沪深京股票与指数 | 腾讯 `qt.gtimg.cn`、`web.ifzq.gtimg.cn` | 免费接口；报价可能有数秒至数分钟的延迟。日线对股票使用前复权（qfq），指数使用原始数据。 |
| 加密货币 | CoinGecko 公开 API | 免费档有限流（调用间通过 `coingeckoDelayMs` 间隔，并遵循 `Retry-After`）；`market_chart` 数据按 UTC 交易日聚合 OHLC。 |

每条报价都附带数据源延迟声明（`delayNote`）。**本插件不构成任何投资建议**；请勿仅凭延迟的免费数据做交易决策。

## 环境要求

- Node.js `^22.19 || >=24`
- dsh `>=0.1.0-rc.6`（`web` 或 `headless` profile）

## 以 bundle 方式接入 dsh

Bundle 是基于 npm 包的可安装配置层：package.json 声明 `dsh.bundle.patch`
（本包自带 `cordis.patch.yml` 与编译产物 `lib/`）。两种典型接入方式：

```bash
# 1. 本地目录接入：
pnpm build                # 或 npm run build
dsh plugin --profile web add .   # 指向本目录的路径

# 2. Git 安装会在安装时运行 prepare 脚本；pnpm >= 10 默认拦截构建脚本，
#    需在 profile 的 pnpm-workspace.yaml 中白名单放行：
#      allowBuilds:
#        dsh-market-watch: true
#    然后执行：
dsh plugin --profile web add github:some-owner/dsh-market-watch
```

因为包声明了 `dsh.bundle`，`dsh plugin` 会自动把它加入 profile 的
`dsh.profile.bundles`；补丁插入 `market-watch` 行，重启后六个工具即出现在
agent 的提示词中。

验证接入是否成功：

```bash
dsh config dump | grep market-watch   # 应能看到该行
```

### 配置项

所有配置均有默认值，bundle 行默认不带 config 段。如需调整，在 profile 的
`cordis.patch.yml` 中按 id 覆盖——注意补丁会**整体替换**该行的 config（不做深合并），
所以要保留的字段必须全部重写（参考 `examples/cordis.patch.example.yml`）：

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 插件总开关。 |
| `pollIntervalSeconds` | `60` | 轮询周期（schema 限制 5..86400）。 |
| `dataDir` | `$DSH_HOME/market-watch` | `watchlist.json` 所在目录。 |
| `timeoutMs` | `10000` | 单次请求网络超时。 |
| `maxRetries` | `2` | 首次尝试之后的额外重试次数。 |
| `retryBackoffBaseMs` | `500` | 指数退避基数。 |
| `vsCurrency` | `usd` | 加密货币报价货币（CoinGecko id）。 |
| `coingeckoDelayMs` | `1200` | CoinGecko 调用最小间隔。 |
| `agentNotify` | `true` | 提醒是否投递到活跃的 dsh agent 会话。 |
| `agentWakeup` | `false` | 提醒时唤醒空闲 agent（`followup`）而非静默注入（`inject`）。 |

## 工具（ctx.tools）

工具注册在 `ctx.tools` 上，schema 会自动进入系统提示词。

| 工具 | 用途 |
| --- | --- |
| `quote` | 查看 `codes` 的最新报价，例如 `["sh600000","000001","bitcoin"]`；可选 `days` 参数为每个标的追加 sparkline（每个标的多一次历史请求）。 |
| `list` | 查看本地自选列表。 |
| `watch` | 添加自选：`codes`（数组），可选 `market`（`cn`/`crypto`）、`kind`（`stock`/`index`/`crypto`）、`name`。 |
| `unwatch` | 按代码删除一条自选。 |
| `alert` | 管理提醒规则：`action` = `list` \| `add` \| `remove`。`add` 需要 `code`、`field`（`changePercent`/`price`）、`op`（`gt`/`gte`/`lt`/`lte`）、`value`，可选 `cooldownSeconds`（默认 300）与 `note`；`remove` 需要 `list` 输出的规则 `id`。 |
| `chart` | 绘制历史走势：`code`，可选 `days`（默认 30）、`format`（`ascii`/`mermaid`）、`width`、`height`。 |

A 股代码支持多种写法：`sh600000`、`600000.sh`、`600000.ss`、裸码 `600000`
（按首位数字推断交易所）；`000001` 配合 `kind: index` 表示上证指数。其余输入
一律按 CoinGecko id 处理（`bitcoin`、`ethereum` 等）。

工具对可预期的失败不会抛异常，而是返回 `{ok:false, error}`，让模型可以基于
报错信息继续处理。

## 提醒（Alerts）

规则与自选列表存于同一文件，每次轮询时评估。比较成立且距上次触发超过冷却时间
才会触发（`lastTriggeredAt` 持久化）。投递通道（均为尽力而为，失败互不影响）：

1. Harness 事件：`ctx.emit('market-watch/alert', alert)`。任何扩展都可以监听：

   ```ts
   ctx.on('market-watch/alert', (alert) => { /* alert.message / alert.quote / alert.rule */ })
   ```

2. Agent 会话：当 `ctx.agents` 存在时，提醒会以插件来源的 `user/message`
   注入每个活跃 agent——默认在下一步之前做静默上下文注入（`agent.inject`），
   配置 `agentWakeup: true` 后才走完整跟进回合（`followup`）。

## CLI

`dsh-market-watch` 与插件共用同一数据目录，命令行操作的就是插件轮询的同一份状态。

```bash
dsh-market-watch quote sh600000 bitcoin --days 5
dsh-market-watch watch sh600000 bitcoin --name "BTC"
dsh-market-watch list
dsh-market-watch unwatch sh600000
dsh-market-watch alert list
dsh-market-watch alert add bitcoin --field price --op gte --value 70000 --cooldown 600
dsh-market-watch chart sh600000 --days 30 --format mermaid
dsh-market-watch poll --once          # 单次轮询（适合 cron 调用）
dsh-market-watch poll --interval 300  # 持续轮询，每 5 分钟一次
```

全局参数：`--data-dir <path>`（或环境变量 `MARKET_WATCH_DATA_DIR`）、`--help`、
`--version`。退出码：`0` 成功、`1` 运行错误、`2` 用法错误。

## 数据文件

`<dataDir>/watchlist.json` — JSON 文档 `{version, items, rules}`。写入采用原子写
（临时文件 + 重命名），所有变更通过 promise 链串行化；遇到损坏文件会隔离为
`watchlist.json.corrupt-<ts>` 并重新开始，而不是卡死插件。由于插件与 CLI 共用同一
文件，引擎在每次轮询/查询时都会重新读取，第二个进程写入的变更无需重启即可生效。

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest（所有网络路径均用 mock）
npm run build       # tsc -> lib/
npm run check       # typecheck + test + build
```

目录结构：`src/core/` 为纯领域层（类型、代码规范化、格式化、HTTP 客户端、JSON 存储、
图表渲染、行情源、引擎），不依赖 dsh，供 CLI 与测试复用；`src/dsh/` 将其适配为
Cordis 插件（工具、轮询器、通知器、入口）；`src/cli/` 为独立可执行文件。

## 许可证

MIT — 见 [LICENSE](LICENSE)。