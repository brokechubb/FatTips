# Discord Bot

The Discord bot is the primary user interface for FatTips.

## Features

- Wallet generation and management
- Tipping with USD conversion
- Airdrop creation and claiming
- Balance checking
- Transaction history

## Commands

### Wallet Commands

- `/wallet create` - Generate a new Solana wallet
- `/wallet balance` - Check your wallet balance
- `/wallet export` - Export your seed phrase (DM only)
- `/wallet address` - Show your deposit address

### Tipping Commands

- `/tip @user $5` - Tip $5 USD worth of SOL
- `/tip @user 5` - Tip 5 SOL
- `/tip @user $5 USDC` - Tip $5 USD worth of USDC
- `/tip @user 10 USDT` - Tip 10 USDT

### Airdrop Commands

- `/airdrop $10 5m` - Create $10 airdrop for 5 minutes
- `/airdrop 10 SOL 1h 20` - Create 10 SOL airdrop for 1 hour, max 20 participants

### Utility Commands

- `/balance` - Show all token balances
- `/history` - View transaction history
- `/leaderboard` - View top tippers
- `/withdraw <amount> <address>` - Withdraw to external wallet

## Development

```bash
# From repo root
pnpm --filter bot dev

# Or
cd apps/bot
pnpm dev
```

## Environment Variables

See root `.env.example` for required variables.
