# Web Dashboard

Next.js web dashboard for FatTips.

## Features

- Public leaderboard
- User statistics and transaction history
- Discord OAuth authentication
- Real-time updates

## Pages

- `/` - Home page with features and invite
- `/leaderboard` - Public leaderboard
- `/dashboard` - User dashboard (requires auth)
- `/history` - Transaction history (requires auth)

## Development

```bash
# From repo root
pnpm --filter web dev

# Or
cd apps/web
pnpm dev
```

## Build

```bash
pnpm --filter web build
```
