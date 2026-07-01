# FatTips 💸

**The Non-Custodial Social Tipping Layer for Solana.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Solana](https://img.shields.io/badge/Solana-Mainnet-green)](https://solana.com)
[![Discord](https://img.shields.io/badge/Discord-Bot-blue)](https://discord.com/oauth2/authorize?client_id=1469150968615669761)

FatTips is a next-generation Discord tipping bot designed specifically for the Solana ecosystem. It enables instant, seamless tipping of SOL, USDC, and USDT directly within Discord conversations, while strictly adhering to a **non-custodial philosophy**.

---

## 🚀 Why FatTips?

Unlike traditional tipping bots (like tip.cc) that operate as centralized banks holding your funds, **FatTips is different.** We believe that **not your keys, not your coins** should apply everywhere—even in a Discord chat.

### 🔑 True Non-Custodial Ownership

When you create a wallet with FatTips, the bot generates a standard Solana keypair.

- **You get the Private Key immediately** via a secure DM.
- **You own the wallet.** You can import this key into Phantom, Solflare, or any other Solana wallet.
- **We don't lock your funds.** You can withdraw everything at any time, with no approval process and no "minimum withdrawal" limits imposed by us (only network rent applies).

FatTips acts as a convenient interface to interact with the Solana blockchain from Discord, but the underlying assets are always yours.

### ⚡ Better Tipping Experience

We've streamlined the tipping experience to be fast, intuitive, and social.

- **USD-Native Tipping:** Type `/tip @user $5` and we automatically calculate the equivalent SOL amount using real-time Jupiter prices. No need to do math.
- **Automatic Conversions:** Tip in USD, receive in crypto.
- **Multi-Token Support:** First-class support for SOL, USDC, and USDT.
- **Zero Bot Fees:** We don't take a cut of your tips. You only pay standard Solana network fees.

---

## 🛠️ Key Features

### 1. Instant Tipping

Send crypto as easily as sending a message.

```
/tip @friend $10        # Sends $10 worth of SOL
/tip @friend 1 USDC     # Sends exactly 1 USDC
/tip @friend all        # Sends your entire wallet balance
/tip @friend1 @friend2 $5 mode:each # Sends $5 to each user
/tip @friend1 @friend2 $10 mode:split # Splits $10 among users
```

_Note: If you tip a user who doesn't have a wallet, FatTips creates one for them automatically!_

### 2. Rain

Randomly distribute tokens to active users in a channel or to all members of a specific role.

```
/rain amount:$10 count:5            # Rain $10 of SOL to 5 random active users
/rain amount:$10 role:@Role         # Rain $10 split among members of @Role
/rain amount:100 USDC count:10      # Rain 100 USDC to 10 users
/rain amount:$5 count:10 mode:each  # Rain $5 per user to 10 random users
```

### 3. Token Swaps

Swap between SOL, USDC, and USDT using Jupiter with gasless swaps available.

```
/swap amount:1 from:SOL to:USDC     # Swap 1 SOL to USDC
/swap amount:$50 from:USDC to:USDT  # Swap $50 of USDC to USDT
```

### 4. Airdrops

Create engaging community airdrops. Drop a pot of tokens in a channel, and users can click a button to claim their share. Funds are held in a pooled wallet system for efficient management and are distributed automatically when the timer ends or max participants is reached.

```
/airdrop amount:$10 duration:1h
/airdrop amount:1 SOL duration:30m max-winners:5
```

### 5. External Transfers & Withdrawals

Send funds to any external Solana address directly from Discord.

```
/send address:9HMqa... $20
/withdraw address:9HMqa... all      # Drains wallet completely (empties balance)
```

### 6. Leaderboards & Stats

Track community engagement and personal performance.

```
/leaderboard type:airdrops          # Top airdrop creators
/leaderboard type:rain              # Top rain senders
/leaderboard type:guild             # Server-wide stats
/stats                               # Your tipping stats (sent, received, created, won)
/stats @user                         # Another user's stats
```

### 7. Wallet Management

```
/balance                # Check balance & address
/deposit                # Get deposit address with QR code
/history                # View transaction history
/wallet action:create   # Create a new wallet
/wallet action:export   # Export recovery phrase (DM)
/wallet action:export-key # Export raw private key (DM)
/wallet action:clear-dms # Delete bot DMs for privacy
/help                   # List all commands
```

### 8. QR Code Deposits

Use `/deposit` or `fdeposit` to get a QR code for your wallet address. Scan with any Solana wallet app (Phantom, Solflare, etc.) to deposit easily.

### 9. Network-Aware Transactions

FatTips monitors Solana network health in real time and adapts accordingly:

- **Dynamic Priority Fees:** Fees are fetched live from Helius before each transaction and escalate on retry to improve inclusion odds during congestion.
- **Network Status Warnings:** Users receive congestion warnings before queuing transactions.
- **Bot Presence Sync:** Discord status reflects network health (Online = healthy, Idle = degraded, DND = congested) with live TPS display.

### 10. User-Installed App

FatTips supports **Discord User Apps**. You can install the bot to your personal account and use it in **ANY** server or DM, even if the bot hasn't been invited there. This makes your wallet truly portable across Discord.

### 11. Prefix Commands

For power users and servers that prefer classic text commands, FatTips supports prefix commands.
**Default Prefix:** `f` (e.g., `ftip`, `fbalance`)

- `ftip @user $5` — Tip instantly (supports `max`/`all`, reply-to-tip)
- `frain $10 5` — Rain on 5 active users
- `frain @role $10` — Rain on members of a role
- `fswap 1 SOL USDC` — Swap tokens via Jupiter
- `fairdrop $10 30m 5` — Create an airdrop (duration + optional max winners)
- `fsend <address> $20` — Send to external wallet
- `fwithdraw <address> all` — Withdraw all funds
- `fbalance` — Check funds
- `fdeposit` — Show deposit address with QR code
- `fhistory` — View last 3 transactions
- `fstats [@user]` — View tipping stats
- `flb [airdrops|rain|guild] [limit]` — View leaderboards
- `fwallet create|export-key` — Wallet management
- `fsetprefix <new>` — Change server prefix (Admin only)
- `fhelp` — List all commands

### 12. REST API

A comprehensive REST API for integrations and programmatic access:

- User, wallet, balance, and transaction endpoints
- Tip, batch-tip, and withdrawal endpoints
- Leaderboard and stats endpoints with full filtering
- App wallet API keys for standalone bot wallets
- API key authentication with granular permissions

---

## 🔒 Security & Privacy

We take security seriously because we are dealing with real value.

- **AES-256-GCM Encryption:** All private keys are encrypted at rest using a master key derived securely.
- **Ephemeral Responses:** Sensitive data (like private keys) is only ever sent via ephemeral messages or direct DMs.
- **Open Source:** Our code is public. You can verify exactly how your keys are handled.

---

## 🚀 Getting Started

### Add to Discord

Add FatTips to your server or install as a personal app:

[**https://discord.com/oauth2/authorize?client_id=1469150968615669761**](https://discord.com/oauth2/authorize?client_id=1469150968615669761)

- **Server Bot:** Add to any server you manage
- **User App:** Install to your personal account and use in any server or DM

### Installation (Self-Host)

FatTips is open source and can be self-hosted.

1. **Clone the repo**

   ```bash
   git clone https://github.com/brokechubb/FatTips.git
   cd FatTips
   ```

2. **Install Dependencies**

   ```bash
   pnpm install
   ```

3. **Configure Environment**

   ```bash
   cp .env.example .env
   # Fill in DISCORD_BOT_TOKEN, SOLANA_RPC_URL, MASTER_ENCRYPTION_KEY, and DATABASE_URL
   ```

4. **Run Database & Bot (Local Dev)**
   ```bash
   docker compose up -d postgres
   pnpm db:migrate
   pnpm dev
   ```

### Production Deployment (Docker)

For production environments, use the provided Docker Compose configuration which creates isolated builds for stability:

```bash
# Start all services (Bot, API, Database, Redis)
docker compose up -d --build

# View logs
docker compose logs -f
```

See `AGENTS.md` for detailed production deployment guidelines.

---

## 💬 Support

Need help? Join the **CTRL-ALT-DEGEN** community on Discord:

**https://discord.gg/9wArQgz6cB**

---

## 🤝 Contributing

We welcome contributions! Whether it's adding new features, fixing bugs, or improving documentation, please feel free to fork the repo and submit a PR.

**License:** MIT
