# Handling secrets safely

All secrets for this bot live in **`.env`** in the repo root. Nothing else reads
or needs them.

## The safe place

| File | Committed to git? | Put secrets here? |
|------|-------------------|-------------------|
| `.env` | **No** — gitignored | **Yes. This is the one.** |
| `.env.local`, `.env.bak`, any `.env.*` | **No** — gitignored | Yes, also safe |
| `.env.example` | Yes (template) | **Never** |
| `data/` (PnL ledger) | No — gitignored | Not secrets, but ignored anyway |

`.gitignore` ignores `.env`, `.env.*`, `*.pem`, `*.key`, and `data/`, and
explicitly re-allows the `.env.example` template.

## How to add a secret

1. Open `.env` in your editor (**not** in a chat window).
2. Set the value with no quotes and no trailing spaces:

```bash
TYPESAFE_API_KEY=your_key_here
```

3. Save. That's it — `npm run watch` and `npm run once` read `.env`
   automatically (via `tsx --env-file=.env` plus `src/loadEnv.ts`).

A real shell export always wins over the file, so one-off overrides work too:

```bash
TYPESAFE_API_KEY=xyz npm run once
```

## Secrets this bot can use

| Variable | Needed for | Risk if leaked |
|----------|-----------|----------------|
| `TYPESAFE_API_KEY` | Any real judgment (non-`--stub-judge`) | Someone spends your TypeSafe quota |
| `WALLET_PVK` | `LIVE_TRADING=1` only | **Total loss of funds in that wallet** |
| `POLYMARKET_FUNDER` | `LIVE_TRADING=1` for Proxy/Safe/Deposit Wallet types | Public address; low risk |

`WALLET_PVK` is a raw private key. Use a dedicated, low-balance signer wallet — never a wallet holding anything you care about. For live trading, `LIVE_TRADING_CONFIRM=I_ACCEPT_REAL_MONEY_RISK` is also required, and `LIVE_MAX_ORDER_USD` caps each order. The bot must use `POLYMARKET_SOURCE=live`; it will not use fixtures as order inputs.

## Verify nothing is exposed before you commit

```bash
# Should print nothing:
git status --short --ignored=no | grep -iE '\.env$|\.env\.'

# Should print "IGNORED (safe)" for each:
for f in .env .env.local .env.bak; do
  printf "%-14s " "$f"
  git check-ignore -q "$f" && echo "IGNORED (safe)" || echo "TRACKABLE — DANGER"
done

# Confirm .env is not in git history:
git log --all --oneline -- .env
```

## If a key ever leaks

Rotate it at the source — deleting the file or rewriting history is not enough:

- **`TYPESAFE_API_KEY`** — revoke and reissue from your TypeSafe dashboard.
- **`WALLET_PVK`** — immediately move all funds out of that wallet to a new one.
  A leaked private key is permanently compromised.
