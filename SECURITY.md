# Security Policy

Transaction Guardian is a **read-only** security simulator and policy checker for
Safe (multisig) and EOA wallets. It:

- **Never stores or handles private keys.** It has no signing capability at all —
  it only reads on-chain data, Safe Transaction Service data, and simulates
  transactions via Tenderly.
- **Does not give financial advice.** Verdicts (✅ OK / ⚠️ Warning / 🚨 Danger) are
  informational; the decision to sign any transaction is always the user's.
- **Does not guarantee 100% protection.** Simulation and policy checks can miss
  novel attack patterns, unverified/obfuscated contracts, or protocols outside the
  configured whitelist. Treat alerts as one input, not a sole source of truth.

## Reporting a vulnerability

If you find a security issue (policy-engine bypass, calldata-decoding error that
could hide a malicious operation, webhook signature verification bypass, injection
via Telegram input, etc.), please **do not** open a public issue with exploit
details. Instead, open a private security advisory on GitHub
(**Security → Report a vulnerability**) or report privately to
[github.com/Sanexxxx777](https://github.com/Sanexxxx777).

## Secrets

`.env` (bot token, API keys, database/Redis URLs, webhook secret) is git-ignored —
never commit it. Never paste real credentials into an issue or PR; use the
placeholders from `.env.example`.
