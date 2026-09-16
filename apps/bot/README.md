# Discord Bot

The Discord bot is the primary user interface for FatTips.

## Features

- Wallet generation and management
- Tipping with USD conversion
- Role-, channel-, and voice-channel rain
- Voice channel tips (`/vctip`)
- Airdrop creation and claiming
- Balance checking
- Transaction history
- Per-server role gating for airdrops and rain

## Commands

### Wallet Commands

- `/wallet create` - Generate a new Solana wallet
- `/wallet balance` - Check your wallet balance
- `/wallet export` - Export your recovery phrase (DM only)
- `/wallet address` - Show your deposit address

### Tipping Commands

- `/tip @user $5` - Tip $5 USD worth of SOL
- `/tip @user 5` - Tip 5 SOL
- `/tip @user $5 USDC` - Tip $5 USD worth of USDC
- `/tip @user 10 USDT` - Tip 10 USDT
- `/rain $10 count:5` - Rain on random active users
- `/rain $10 role:@Role` - Rain on members of a role
- `/rain $10 voice:true` - Rain on your current voice channel
- `/vctip amount:$10` - Tip everyone in your current voice channel

### Airdrop Commands

- `/airdrop $10 5m` - Create $10 airdrop for 5 minutes
- `/airdrop 10 SOL 1h 20` - Create 10 SOL airdrop for 1 hour, max 20 participants

### Utility Commands

- `/balance` - Show all token balances
- `/deposit` - Show deposit address with QR code
- `/history` - View transaction history
- `/leaderboard` - View top tippers
- `/stats [@user]` - View tipping stats
- `/withdraw <amount> <address>` - Withdraw to external wallet

### Admin Commands

- `/config role feature:<airdrop|rain> role:@Role` - Gate a feature to a role
- `/config view` - Show current per-server settings

### Prefix Commands

The default prefix is `f`.

- `ftip @user $5` - Tip user
- `frain $10 5` - Rain on 5 active users
- `frain @role $10` - Rain on members of a role
- `frain vc $10 [count]` - Rain on your voice channel
- `fvctip $10 [count]` - Tip everyone in your voice channel
- `fairdrop $10 1h` - Create airdrop
- `fbalance` - Check balance
- `fdeposit` - Show deposit address
- `fhistory` - View history
- `fstats [@user]` - View tipping stats
- `flb [airdrops|rain|guild]` - View leaderboards
- `fsetprefix` - Change prefix (Admin)
- `fsetrole <airdrop|rain> @Role` - Gate a feature to a role (Admin)

## Intents

The bot requires the **Server Members** privileged intent (for role-based rain and member lookups) and the **Message Content** intent (for prefix commands). It also uses `GuildVoiceStates` to read voice channel membership for `/vctip`, voice rain, and `/rain voice:true`.

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
