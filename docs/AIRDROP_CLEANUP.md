# Weekly Airdrop Wallet Cleanup

## Overview

This system automatically drains residual funds from expired/settled airdrop wallets on a weekly basis. Residual funds occur because:

1. **Rent Exemption**: Every Solana account must maintain at least 0.00089 SOL to exist
2. **Rounding**: When dividing the pot among winners, fractional lamports remain
3. **Failed Payments**: Some winner wallets may be invalid, leaving funds stuck

## Scripts

### `cleanup-airdrops.js`

Main cleanup script that:

- Queries all SETTLED/EXPIRED airdrop wallets from the database
- Decrypts each wallet's private key
- Drains any balance > 5000 lamports to a destination wallet
- Logs all transactions

**Usage:**

```bash
# Run manually with default destination
node scripts/cleanup-airdrops.js

# Run with custom destination
node scripts/cleanup-airdrops.js <WALLET_ADDRESS>
```

**Environment Variables Required:**

- `SOLANA_RPC_URL` - RPC endpoint for Solana
- `DATABASE_URL` - PostgreSQL connection string
- `MASTER_ENCRYPTION_KEY` - Key for decrypting wallet private keys

### `setup-cleanup-cron.sh`

Installs the cleanup script as a weekly cron job (Sundays at 3 AM).

**Usage:**

```bash
./scripts/setup-cleanup-cron.sh
```

## Setup

### Option 1: Cron Job (Recommended)

1. Deploy the scripts to production:

```bash
scp scripts/cleanup-airdrops.js scripts/setup-cleanup-cron.sh chubb@codestats.gg:/opt/FatTips/scripts/
```

2. SSH into production and run setup:

```bash
ssh chubb@codestats.gg
cd /opt/FatTips
./scripts/setup-cleanup-cron.sh
```

3. Verify the cron job is installed:

```bash
crontab -l
```

### Option 2: Manual Weekly Run

1. Add an entry to your personal calendar/reminder system
2. Run manually each week:

```bash
ssh chubb@codestats.gg "cd /opt/FatTips && node scripts/cleanup-airdrops.js"
```

## Logs

Logs are stored in `/opt/FatTips/logs/airdrop-cleanup.log`

View recent activity:

```bash
tail -f /opt/FatTips/logs/airdrop-cleanup.log
```

## Expected Results

Based on historical data:

- **~60 airdrop wallets** will be checked weekly
- **Average recovery**: 0.003-0.01 SOL per wallet with funds
- **Total weekly recovery**: ~0.2-0.5 SOL
- **Annual recovery**: ~10-25 SOL

## Safety Features

1. **Keypair Verification**: Each decrypted keypair is verified against the expected public key
2. **Balance Checks**: Wallets with < 5000 lamports are skipped (just rent exemption)
3. **Fee Buffer**: Always leaves 5000 lamports for the transaction fee
4. **Rate Limiting**: 500ms delay between transactions to avoid RPC throttling
5. **Error Handling**: Individual wallet failures don't stop the entire process

## Destination Wallet

Default: `9HMqaDgnbvy4VYi9VpNVb6u3xv4vqD5RG12cyxcsVRFY`

This is the FatTips operational wallet. Change in `setup-cleanup-cron.sh` if needed.

## Troubleshooting

### Script fails with "MASTER_ENCRYPTION_KEY not set"

Make sure environment variables are loaded. The script reads from the shell environment.

### No wallets found

Check database connection and that airdrops exist with status 'SETTLED' or 'EXPIRED'.

### RPC rate limiting errors

The script has built-in rate limiting (500ms delays). If you hit limits, increase the delay in the script.

### Wrong destination wallet

Update the `DESTINATION_WALLET` variable in `setup-cleanup-cron.sh` and re-run setup.
