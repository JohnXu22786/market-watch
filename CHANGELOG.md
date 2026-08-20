# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-20

Initial release as a dsh (DeepSeek Harness) bundle.

### Added

- Real-time quotes for A-share (Shanghai/Shenzhen/Beijing) stocks, indices,
  and cryptocurrencies via Tencent and CoinGecko providers.
- Local watchlist with persistent storage and on-demand refresh.
- Configurable threshold alerts with in-chat notifications.
- Periodic polling with deduped alerts and an in-flight guard.
- In-chat ASCII and mermaid sparkline/trend charts.
- Model-facing tools plus a standalone CLI (`dsh-market-watch`).
