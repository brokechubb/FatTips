#!/bin/bash

# FatTips Database Restore Script
# Restores PostgreSQL database from a backup file
# Usage: ./scripts/restore-database.sh [backup-file.sql.gz]

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${PROJECT_ROOT}/backups/database"
DOCKER_CONTAINER="fattips-db"
DB_NAME="fattips"
DB_USER="fattips_user"

# Function to print colored output
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to list available backups
list_backups() {
    log_info "Available backups in ${BACKUP_DIR}:"
    if [ -d "$BACKUP_DIR" ] && [ "$(ls -A "$BACKUP_DIR"/*.sql.gz 2>/dev/null)" ]; then
        ls -lh "$BACKUP_DIR"/*.sql.gz | awk '{print $9, "(" $5 ")"}'
    else
        log_warn "No backups found in ${BACKUP_DIR}"
        exit 1
    fi
}

# Check if docker container is running
check_container() {
    if ! docker ps | grep -q "$DOCKER_CONTAINER"; then
        log_error "Database container '${DOCKER_CONTAINER}' is not running!"
        log_info "Start it with: docker compose up -d postgres"
        exit 1
    fi
    log_info "Database container is running"
}

# Restore database from backup
restore_database() {
    local BACKUP_FILE=$1
    
    if [ ! -f "$BACKUP_FILE" ]; then
        log_error "Backup file not found: ${BACKUP_FILE}"
        exit 1
    fi
    
    log_warn "⚠️  WARNING: This will REPLACE the current database!"
    log_warn "Current database will be PERMANENTLY DELETED and replaced with backup:"
    log_warn "  ${BACKUP_FILE}"
    echo ""
    read -p "Are you sure you want to continue? (type 'yes' to confirm): " confirm
    
    if [ "$confirm" != "yes" ]; then
        log_info "Restore cancelled"
        exit 0
    fi
    
    log_info "Starting database restore..."
    
    # Step 1: Drop existing connections
    log_info "Terminating active connections to database..."
    docker exec -i "$DOCKER_CONTAINER" psql -U "$DB_USER" -d postgres <<-EOSQL
        SELECT pg_terminate_backend(pg_stat_activity.pid)
        FROM pg_stat_activity
        WHERE pg_stat_activity.datname = '${DB_NAME}'
          AND pid <> pg_backend_pid();
EOSQL
    
    # Step 2: Drop and recreate database
    log_info "Dropping existing database..."
    docker exec -i "$DOCKER_CONTAINER" psql -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS ${DB_NAME};"
    
    log_info "Creating fresh database..."
    docker exec -i "$DOCKER_CONTAINER" psql -U "$DB_USER" -d postgres -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"
    
    # Step 3: Restore from backup
    log_info "Restoring database from backup..."
    gunzip -c "$BACKUP_FILE" | docker exec -i "$DOCKER_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME"
    
    if [ $? -eq 0 ]; then
        log_info "✅ Database restored successfully from ${BACKUP_FILE}"
        
        # Show database info
        log_info "Database statistics:"
        docker exec -i "$DOCKER_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" <<-EOSQL
            SELECT 
                schemaname,
                tablename,
                pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
            FROM pg_tables
            WHERE schemaname = 'public'
            ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
EOSQL
    else
        log_error "Failed to restore database"
        exit 1
    fi
}

# Main script
main() {
    log_info "FatTips Database Restore Script"
    echo ""
    
    check_container
    
    if [ $# -eq 0 ]; then
        # No arguments - show available backups
        list_backups
        echo ""
        read -p "Enter the full path to the backup file to restore: " BACKUP_FILE
    else
        BACKUP_FILE=$1
    fi
    
    # If relative path, make it absolute from backup dir
    if [[ "$BACKUP_FILE" != /* ]]; then
        BACKUP_FILE="${BACKUP_DIR}/${BACKUP_FILE}"
    fi
    
    restore_database "$BACKUP_FILE"
    
    log_warn ""
    log_warn "⚠️  IMPORTANT: After restoring, you may need to:"
    log_warn "  1. Restart the bot: docker compose restart bot"
    log_warn "  2. Run migrations: pnpm db:migrate"
    log_warn "  3. Verify data integrity"
}

main "$@"
