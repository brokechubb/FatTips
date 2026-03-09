# FatTips Database Backup Scripts

This directory contains scripts for backing up and restoring the FatTips PostgreSQL database.

## ⚠️ CRITICAL: Why Backups Are Essential

The FatTips database contains **encrypted user wallet private keys**. If the database is lost or corrupted:

- **User wallets CANNOT be recovered**
- All funds in bot wallets would be permanently lost
- No way to decrypt or regenerate private keys

**Regular backups are mandatory for production deployments.**

## Scripts

### 1. `backup-database.sh` - Manual/Scheduled Backup

Creates a compressed backup of the PostgreSQL database.

**Usage:**

```bash
# Manual backup
./scripts/backup-database.sh

# Automated via cron (recommended)
# See setup-backup-cron.sh below
```

**Features:**

- Compresses backups with gzip
- Stores in `backups/` directory with timestamp
- Automatically deletes backups older than 30 days
- Validates backup integrity
- Safe for production (no downtime)

**Output:**

```
backups/fattips_backup_2025-02-09_14-30-00.sql.gz
```

---

### 2. `restore-database.sh` - Restore from Backup

Restores the database from a backup file.

**Usage:**

```bash
# Interactive mode (lists available backups)
./scripts/restore-database.sh

# Direct restore
./scripts/restore-database.sh backups/fattips_backup_2025-02-09_14-30-00.sql.gz
```

**⚠️ WARNING:**

- **This DELETES the current database completely**
- Requires confirmation before proceeding
- Terminates all active connections
- Cannot be undone

**After restore:**

1. Restart the bot: `docker compose restart bot`
2. Run migrations (if needed): `pnpm db:migrate`
3. Verify data integrity

---

### 3. `setup-backup-cron.sh` - Automated Backups

Sets up automated database backups using cron.

**Usage:**

```bash
./scripts/setup-backup-cron.sh
```

**Interactive Setup:**

- Choose backup frequency (hourly, daily, custom)
- Automatically adds cron job
- Option to run test backup
- Logs to `/tmp/fattips-backup.log`

**Recommended Schedules:**

- **Production:** Daily at 2 AM + every 6 hours
- **Development:** Daily at midnight
- **High-volume:** Every hour

---

## Quick Start Guide

### First Time Setup

1. **Test manual backup:**

   ```bash
   ./scripts/backup-database.sh
   ```

2. **Test restore process:**

   ```bash
   # Create test backup
   ./scripts/backup-database.sh

   # Restore from it
   ./scripts/restore-database.sh
   ```

3. **Set up automated backups:**
   ```bash
   ./scripts/setup-backup-cron.sh
   # Choose option 3 or 5 for production
   ```

### Production Deployment

For production on `codestats.gg`:

```bash
# SSH into server
ssh -p 1337 chubb@codestats.gg

# Navigate to project
cd /opt/FatTips

# Set up automated backups
./scripts/setup-backup-cron.sh
# Recommended: Option 5 (twice daily)

# Verify cron job
crontab -l

# Check backup logs
tail -f /tmp/fattips-backup.log
```

---

## Backup Storage

### Local Backups

- **Location:** `backups/` directory
- **Retention:** 30 days (auto-cleanup)
- **Format:** gzip-compressed SQL dumps

### External Backups (Recommended)

For production, also back up to external storage:

```bash
# Example: Sync to remote server
rsync -avz backups/ user@backup-server:/backups/fattips/

# Example: Upload to cloud storage
# (Add your preferred cloud backup solution)
```

---

## Troubleshooting

### Backup fails with "container not running"

```bash
# Start the database
docker compose up -d postgres

# Retry backup
./scripts/backup-database.sh
```

### Restore fails with permission errors

```bash
# Ensure you have docker permissions
docker ps

# If needed, add user to docker group
sudo usermod -aG docker $USER
# Log out and back in
```

### Cron job not running

```bash
# Check cron logs
grep CRON /var/log/syslog

# Verify crontab
crontab -l

# Check backup logs
cat /tmp/fattips-backup.log
```

### Backup file is huge

The database includes transaction history. To reduce size:

- Clean old transactions periodically
- Use `pg_dump` with `--exclude-table` for history tables
- Compress with higher levels: `gzip -9`

---

## Database Size Monitoring

Check current database size:

```bash
docker exec fattips-db psql -U fattips -d fattips -c "
  SELECT
    pg_size_pretty(pg_database_size('fattips')) AS database_size;
"
```

Check table sizes:

```bash
docker exec fattips-db psql -U fattips -d fattips -c "
  SELECT
    tablename,
    pg_size_pretty(pg_total_relation_size('public.'||tablename)) AS size
  FROM pg_tables
  WHERE schemaname = 'public'
  ORDER BY pg_total_relation_size('public.'||tablename) DESC;
"
```

---

## Security Notes

- Backup files contain **encrypted private keys**
- Master encryption key (`.env`) is NOT backed up by these scripts
- **Never commit backups to git**
- Store backups in secure location
- Use encrypted storage for remote backups
- Test restore process regularly

---

## Additional Resources

- [PostgreSQL Backup Documentation](https://www.postgresql.org/docs/current/backup.html)
- [Docker PostgreSQL Backups](https://docs.docker.com/samples/postgres/)
- [Cron Syntax Guide](https://crontab.guru/)
