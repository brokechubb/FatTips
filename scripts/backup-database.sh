#!/bin/bash
#
# FatTips Database Backup Script
# 
# This script creates encrypted backups of the PostgreSQL database.
# The database contains encrypted wallet private keys - CRITICAL DATA!
#
# Usage: ./backup-database.sh [--no-encrypt] [--keep-days 30]
#

set -e

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups/database}"
KEEP_DAYS="${KEEP_DAYS:-30}"
ENCRYPT_BACKUPS=true
CONTAINER_NAME="fattips-db"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --no-encrypt)
      ENCRYPT_BACKUPS=false
      shift
      ;;
    --keep-days)
      KEEP_DAYS="$2"
      shift 2
      ;;
    --help)
      echo "Usage: $0 [--no-encrypt] [--keep-days DAYS]"
      echo ""
      echo "Options:"
      echo "  --no-encrypt     Skip GPG encryption (NOT RECOMMENDED)"
      echo "  --keep-days N    Keep backups for N days (default: 30)"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
  echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

# Check if container is running
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  log_error "Database container '${CONTAINER_NAME}' is not running!"
  exit 1
fi

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Generate backup filename with timestamp
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/fattips_backup_${TIMESTAMP}.sql"
BACKUP_FILE_GZ="${BACKUP_FILE}.gz"
BACKUP_FILE_ENC="${BACKUP_FILE_GZ}.gpg"

log_info "Starting database backup..."
log_info "Backup location: $BACKUP_DIR"

# Create the backup using pg_dump
log_info "Running pg_dump..."
docker exec -t "$CONTAINER_NAME" pg_dump \
  -U fattips_user \
  -d fattips \
  --no-owner \
  --no-acl \
  --clean \
  --if-exists \
  > "$BACKUP_FILE"

if [ $? -ne 0 ]; then
  log_error "pg_dump failed!"
  rm -f "$BACKUP_FILE"
  exit 1
fi

# Get backup size
BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
log_info "Backup created: $BACKUP_SIZE"

# Compress the backup
log_info "Compressing backup..."
gzip -9 "$BACKUP_FILE"

if [ $? -ne 0 ]; then
  log_error "Compression failed!"
  rm -f "$BACKUP_FILE" "$BACKUP_FILE_GZ"
  exit 1
fi

COMPRESSED_SIZE=$(du -h "$BACKUP_FILE_GZ" | cut -f1)
log_info "Compressed to: $COMPRESSED_SIZE"

# Encrypt the backup if enabled
if [ "$ENCRYPT_BACKUPS" = true ]; then
  log_info "Encrypting backup with GPG..."
  
  # Check if GPG key exists
  if ! gpg --list-keys "fattips-backup" &>/dev/null; then
    log_warn "GPG key 'fattips-backup' not found!"
    log_warn "Creating a symmetric encryption instead..."
    log_warn "You will be prompted for a password. SAVE THIS PASSWORD!"
    
    gpg --symmetric --cipher-algo AES256 "$BACKUP_FILE_GZ"
    
    if [ $? -eq 0 ]; then
      rm -f "$BACKUP_FILE_GZ"
      log_info "Backup encrypted: $(du -h "$BACKUP_FILE_ENC" | cut -f1)"
    else
      log_error "Encryption failed!"
      exit 1
    fi
  else
    # Use public key encryption
    gpg --encrypt --recipient "fattips-backup" "$BACKUP_FILE_GZ"
    
    if [ $? -eq 0 ]; then
      rm -f "$BACKUP_FILE_GZ"
      log_info "Backup encrypted: $(du -h "$BACKUP_FILE_ENC" | cut -f1)"
    else
      log_error "Encryption failed!"
      exit 1
    fi
  fi
  
  FINAL_BACKUP="$BACKUP_FILE_ENC"
else
  log_warn "Encryption disabled - backup is NOT encrypted!"
  FINAL_BACKUP="$BACKUP_FILE_GZ"
fi

# Create a checksum
log_info "Creating checksum..."
sha256sum "$FINAL_BACKUP" > "${FINAL_BACKUP}.sha256"

log_info "✓ Backup complete: $(basename "$FINAL_BACKUP")"

# Cleanup old backups
log_info "Cleaning up backups older than $KEEP_DAYS days..."
find "$BACKUP_DIR" -name "fattips_backup_*.sql.gz*" -type f -mtime +$KEEP_DAYS -delete
OLD_CHECKSUMS=$(find "$BACKUP_DIR" -name "*.sha256" -type f -mtime +$KEEP_DAYS | wc -l)
find "$BACKUP_DIR" -name "*.sha256" -type f -mtime +$KEEP_DAYS -delete

if [ "$OLD_CHECKSUMS" -gt 0 ]; then
  log_info "Removed $OLD_CHECKSUMS old backup(s)"
fi

# Show backup directory status
TOTAL_BACKUPS=$(find "$BACKUP_DIR" -name "fattips_backup_*.sql.gz*" -type f | wc -l)
TOTAL_SIZE=$(du -sh "$BACKUP_DIR" | cut -f1)
log_info "Total backups: $TOTAL_BACKUPS ($TOTAL_SIZE)"

# Backup metadata
cat > "$BACKUP_DIR/latest_backup_info.txt" <<EOF
Backup Date: $(date)
Backup File: $(basename "$FINAL_BACKUP")
Database Size: $BACKUP_SIZE
Compressed Size: $COMPRESSED_SIZE
Encrypted: $ENCRYPT_BACKUPS
Checksum: $(cat "${FINAL_BACKUP}.sha256" | cut -d' ' -f1)
EOF

log_info "Backup info saved to latest_backup_info.txt"

# Success
echo ""
log_info "========================================="
log_info "BACKUP SUCCESSFUL"
log_info "========================================="
echo ""
echo "Backup file: $FINAL_BACKUP"
echo "Checksum: ${FINAL_BACKUP}.sha256"
echo ""
if [ "$ENCRYPT_BACKUPS" = true ]; then
  echo "⚠️  IMPORTANT: Store your GPG password/key securely!"
  echo "⚠️  Without it, backups cannot be restored!"
fi
echo ""
