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
- **Zero Bot Fees:** We don't take a cut of your tips. You only pay standard Solana network fees (~$0.0004).

---

## 🛠️ Key Features

### 1. Instant Tipping

Send crypto as easily as sending a message.

```
/tip @friend $10        # Sends $10 worth of SOL
/tip @friend 1 USDC     # Sends exactly 1 USDC
/tip @friend all        # Sends your entire wallet balance
```

_Note: If you tip a user who doesn't have a wallet, FatTips creates one for them automatically!_

### 2. External Transfers & Withdrawals

Send funds to any external Solana address directly from Discord.

```
/send address:9HMqa... $20
/withdraw address:9HMqa... all   # Drains wallet completely (empties balance)
```

### 3. Airdrops (New!)

Create engaging community airdrops. Drop a pot of tokens in a channel, and users can click a button to claim their share. Funds are distributed automatically when the timer ends.

```
/airdrop amount:$10 duration:1h
/airdrop amount:1 SOL duration:30m max-winners:5
```

### 4. Transaction History

Keep track of your spending and earnings.

```

/history

```

### 5. Wallet Management

```

/balance # Check balance & address
/wallet action:create # Create a new wallet
/wallet action:export # Export recovery phrase (DM)
/wallet action:clear-dms # Delete bot DMs for privacy
/help # List all commands

```

### 6. User-Installed App 🆕

FatTips supports **Discord User Apps**. You can install the bot to your personal account and use it in **ANY** server or DM, even if the bot hasn't been invited there. This makes your wallet truly portable across Discord.

### 7. Prefix Commands ⚡

For power users and servers that prefer classic text commands, FatTips supports prefix commands.
**Default Prefix:** `f` (e.g., `ftip`, `fbalance`)

- `ftip @user $5` — Tip instantly
- `ftip $5` (Reply to message) — Tip the message author
- `frain $10 5` — Rain on 5 active users
- `fairdrop $10 30m` — Create an airdrop
- `fbalance` — Check funds
- `fdeposit` — Show deposit address
- `fsetprefix <new>` — Change server prefix (Admin only)

---

## 🔒 Security & Privacy

We take security seriously because we are dealing with real value.

- **AES-256-GCM Encryption:** All private keys are encrypted at rest using a master key derived securely.
- **Ephemeral Responses:** Sensitive data (like private keys) is only ever sent via ephemeral messages or direct DMs.
- **Open Source:** Our code is public. You can verify exactly how your keys are handled.

---

## 🚀 Getting Started

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
   # Fill in DISCORD_TOKEN, HELIUS_RPC_URL, and Encryption Key
   ```

4. **Run Database & Bot (Local Dev)**
   ```bash
   docker-compose up -d postgres
   pnpm db:migrate
   pnpm dev
   ```

### Production Deployment (Docker)

For production environments (e.g., VPS), use the provided Docker Compose configuration which creates isolated "Fat Images" for stability:

```bash
# Start all services (Bot, API, Database, Redis)
docker compose up -d --build

# View logs
docker compose logs -f
```

See `AGENTS.md` for detailed production deployment guidelines.

---

## 🤝 Contributing

We welcome contributions! Whether it's adding new features, fixing bugs, or improving documentation, please feel free to fork the repo and submit a PR.

**License:** MIT
