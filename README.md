# Transaction Guardian

<!-- TODO: demo GIF (20-40s) -->

Open-source security bot for Safe (multisig) and EOA wallets. It analyzes a pending
DeFi transaction **before you sign it** — simulating the outcome, decoding the calldata,
and screening it against a policy engine — then delivers a verdict to Telegram.

The goal: stop a malicious or mistaken transaction from ever being signed.

**RU:** Open-source security-бот для Safe (мультисиг) и EOA кошельков. Анализирует
входящую DeFi-транзакцию **до подписания** — симулирует результат, декодирует calldata
и проверяет по policy engine — присылает вердикт в Telegram. Read-only: бот НЕ хранит
и НЕ подписывает приватные ключи, финальное решение — за пользователем.

## Features

**Wallet monitoring**
- Safe Transaction Service polling + push webhooks (HMAC-verified)
- EOA monitoring via Etherscan API V2
- 8 networks: Ethereum, Arbitrum, Polygon, Optimism, Base, BSC, Avalanche, Gnosis
- Smart tri-state polling (off / standby / active) to stay within API quotas

**Transaction simulation (Safe, via Tenderly)**
- Preview the result before signing
- Balance changes (what you send / receive)
- Detects transactions that would revert

**Calldata decoding**
- ERC20, WETH, Uniswap V3 / Universal Router, 1inch, AAVE, Lido, Curve, Compound,
  CoW Protocol, Across, Safe management ops, multiSend batches
- Contract-name resolution via Etherscan `getsourcecode` (Redis-cached)
- ERC20 metadata resolution via on-chain `symbol()`/`decimals()`
- 4byte.directory fallback for unknown selectors

**Policy engine (security checks)**

| Check | What it does |
|-------|--------------|
| Protocol whitelist | Only known protocols (AAVE, Uniswap, 1inch, …) |
| Address whitelist | Trusted recipient list (auto-includes Safe owners) |
| Blacklist | Known scam/exploit addresses (OFAC, bridge exploiters) |
| Contract verification | Warns on unverified source code |
| Contract age | Warns on contracts younger than 7 days |
| Amount anomaly | Flags abnormally large amounts vs. history |
| Phishing detection | Detects address-poisoning lookalikes |
| Unlimited approvals | Flags `MAX_UINT` approvals to non-whitelisted spenders |
| Recipient extraction | Pulls hidden recipients out of swap calldata |
| Safe-admin ops | Flags owner / threshold / module / guard changes |

**Analysis & notifications**
- LLM-generated, human-readable headline of what the transaction does
- Deterministic, audit-friendly educational templates per operation kind
  (no LLM in the security verdict — no hallucination, no prompt-injection surface)
- Telegram alerts with severity levels: ✅ OK / ⚠️ Warning / 🚨 Danger
- Manual `/sim` and `/analyze <url>` dry-run commands (Safe / Tenderly / tx-hash)

## Tech stack

- Node.js 20+ / TypeScript (ESM)
- Fastify 5 (webhook HTTP server)
- Prisma 6 + PostgreSQL
- Redis (cache, deduplication, rate limiting)
- grammY (Telegram bot)
- ethers.js v6 (ABI decoding)
- Tenderly API (simulation)
- Safe Transaction Service API + webhooks
- Etherscan API V2 (EOA monitoring, contract verification — one key, all chains)
- LLM for transaction headlines (configurable provider)

## Quick start

```bash
git clone https://github.com/Sanexxxx777/transaction-guardian.git
cd transaction-guardian
npm install

cp .env.example .env        # fill in your credentials
npm run db:push             # apply schema to PostgreSQL
npm run db:generate         # generate Prisma client

npm run build
npm run start
```

For development: `npm run dev`.

### Configuration

All configuration is via environment variables — see [`.env.example`](.env.example)
for the full list. Minimum required:

- `DATABASE_URL` — PostgreSQL connection string
- `REDIS_URL` — Redis connection string
- `TELEGRAM_BOT_TOKEN` — bot token from @BotFather
- `TELEGRAM_ADMIN_USER_ID` — your Telegram user id (admin)

Optional integrations enable extra features: `TENDERLY_*` (simulation),
`ETHERSCAN_API_KEY` (EOA + contract verification), `SAFE_API_KEY` (Safe TX Service),
`SAFE_WEBHOOK_SECRET` (webhook HMAC), and an LLM key for transaction headlines.

> **Prisma build note:** after `db:generate` or any schema change, always run
> `npm run build` — `tsc` does not copy the generated Prisma runtime into `dist/`.

## Usage

Admin commands (in a private chat with the bot):

- `/wallets` — manage monitored wallets (add/edit/remove, per-chain visibility)
- `/whitelist` — manage protocol & address whitelists
- `/groups` — manage notification groups
- `/sim <url|hash>` — dry-run analysis without recording or notifying
- `/analyze <url>` — full analysis with an audit-log entry
- `/settings` — monitoring mode and service status

Once a wallet is added, the bot monitors it automatically and posts an alert for
every pending transaction.

## Project structure

```
src/
├── config/                 # Network config, env, per-chain default protocols
├── db/                     # Prisma client, Redis, seed
├── services/
│   ├── wallet-monitor/     # Safe API + EOA polling, smart polling control
│   ├── webhook/            # Safe webhook event handler (HMAC)
│   ├── transaction-processor/  # Decode + simulate, resolver fan-out
│   ├── calldata-decoder/   # Per-protocol decoders + 4byte fallback
│   ├── contract-resolver/  # Etherscan source → contract name (cached)
│   ├── token-resolver/     # ERC20 metadata via RPC (cached)
│   ├── cow-orderbook/      # CoW Protocol order details
│   ├── policy-engine/      # Security checks (rules/)
│   ├── notification-templates/ # Deterministic per-operation templates
│   ├── manual-analyze/     # /sim & /analyze pipeline + URL parser
│   ├── ai-analyzer/        # LLM transaction headline
│   ├── telegram-bot/       # Bot (admin / user handlers, notifications)
│   └── price-fetcher/      # CoinGecko prices (cached)
├── server.ts               # Fastify (webhook endpoint + health check)
└── utils/                  # Logger, MarkdownV2 helpers, validators
```

## Security

This project handles untrusted on-chain calldata and stands between a user and
signing a transaction. Vulnerability reports are welcome — please open an issue
(or a private report) rather than a public PR for anything sensitive. See
[SECURITY.md](SECURITY.md) for the disclosure process.

**⚠️ Disclaimer:** Transaction Guardian is a **read-only** simulator and policy
checker. It never stores or signs private keys, and it cannot guarantee 100%
protection — simulation and policy checks can miss novel attack patterns.
Verdicts are informational, not financial advice; the final decision to sign
any transaction is always yours.

## Contact

Questions or issues: [github.com/Sanexxxx777](https://github.com/Sanexxxx777).

## License

[MIT](LICENSE) © 2026 Aleksandr Shulgin ([@Aleksandr_NFA](https://t.me/Aleksandr_NFA))
