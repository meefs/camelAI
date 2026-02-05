#!/bin/bash
# Container entrypoint - mounts JuiceFS (R2 + SQLite) and starts services.
# Supports migration from old R2 tar backups to JuiceFS.
# Environment variables are passed at container start time via @cloudflare/containers.
#
# Ports:
#   8080 - ws-server (Claude SDK) - runs as claude user
#   9000 - control-plane (exec/fs) - runs as claude user
#
# Version: 2026-02-05-v78-fix-warmup-flag
set -eu

# Trap errors and show what failed
trap 'echo "[entrypoint] ERROR at line $LINENO: $BASH_COMMAND (exit code $?)" >&2' ERR

echo "[entrypoint] Starting container initialization..." >&2
START_TS="$(date +%s%3N 2>/dev/null || date +%s)"
echo "[entrypoint] ORG_ID=${ORG_ID:-unset}" >&2
echo "[entrypoint] WORKSPACE_ID=${WORKSPACE_ID:-unset}" >&2
echo "[entrypoint] R2_BUCKET_NAME=${R2_BUCKET_NAME:-unset}" >&2

TARGET_DIR="${R2_MOUNT_DIR:-/home/claude}"
JUICEFS_META_DIR="${JUICEFS_META_DIR:-/var/lib/juicefs}"
JUICEFS_CACHE_DIR="${JUICEFS_CACHE_DIR:-/tmp/juicefs-cache}"
JUICEFS_UPLOAD_DELAY="${JUICEFS_UPLOAD_DELAY:-5s}"
JUICEFS_BUFFER_SIZE="${JUICEFS_BUFFER_SIZE:-2048}"
JUICEFS_CACHE_SIZE="${JUICEFS_CACHE_SIZE:-4096}"  # 4GB max cache

# Track PIDs for cleanup
WS_PID=""
CONTROL_PID=""
BACKUP_PID=""
INDEXER_PID=""
MOUNT_SUCCEEDED=""

# Check if R2 is configured
has_r2_config() {
  [ -n "${R2_BUCKET_NAME:-}" ] && [ -n "${R2_ACCOUNT_ID:-}" ] && \
  [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ]
}

sanitize_name() {
  local sanitized
  sanitized="$(echo "$1" | tr -c 'a-zA-Z0-9-' '-' | tr -s '-' | cut -c1-20)"
  if [ -z "$sanitized" ]; then
    sanitized="x"
  fi
  echo "$sanitized"
}

ensure_trailing_slash() {
  case "$1" in
    */) echo "$1" ;;
    *) echo "$1/" ;;
  esac
}

# Backup SQLite metadata to R2
# Uses sqlite3's .backup command for a consistent snapshot
backup_metadata_to_r2() {
  if ! has_r2_config; then
    return 1
  fi

  ORG_SAFE="$(sanitize_name "${ORG_ID:-org}")"
  WS_SAFE="$(sanitize_name "${WORKSPACE_ID:-ws}")"
  JFS_META_FILE="${JUICEFS_META_DIR}/${ORG_SAFE}-${WS_SAFE}.db"
  R2_BASE="$(ensure_trailing_slash "${R2_PREFIX:-${ORG_ID}/${WORKSPACE_ID}/}")"
  BACKUP_KEY="${R2_BASE}juicefs-metadata.db"
  BACKUP_TMP="/tmp/metadata-backup.db"

  if [ ! -f "$JFS_META_FILE" ]; then
    echo "[backup] No metadata file to backup" >&2
    return 1
  fi

  # Create consistent backup using SQLite's backup API
  if ! sqlite3 "$JFS_META_FILE" ".backup '$BACKUP_TMP'" 2>/dev/null; then
    echo "[backup] SQLite backup failed" >&2
    return 1
  fi

  BACKUP_SIZE="$(stat -c%s "$BACKUP_TMP" 2>/dev/null || stat -f%z "$BACKUP_TMP")"
  echo "[backup] Uploading metadata backup (${BACKUP_SIZE} bytes) to R2..." >&2

  # Upload to R2 using AWS SDK (run from /app where @aws-sdk is installed)
  if cd /app && node -e "
    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    const fs = require('fs');
    const client = new S3Client({
      endpoint: 'https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
      region: 'auto',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        ...(process.env.AWS_SESSION_TOKEN && { sessionToken: process.env.AWS_SESSION_TOKEN }),
      },
    });
    async function upload() {
      const body = fs.readFileSync('$BACKUP_TMP');
      await client.send(new PutObjectCommand({
        Bucket: '${R2_BUCKET_NAME}',
        Key: '${BACKUP_KEY}',
        Body: body,
        ContentType: 'application/x-sqlite3',
      }));
      console.error('[backup] Uploaded to R2: ${BACKUP_KEY}');
    }
    upload().catch(e => { console.error('[backup] Upload failed:', e.message); process.exit(1); });
  " 2>&1; then
    rm -f "$BACKUP_TMP"
    return 0
  else
    rm -f "$BACKUP_TMP"
    return 1
  fi
}

# Migrate from old Litestream backup (one-time migration)
# Returns 0 if migration succeeded, 1 if no Litestream backup exists
migrate_from_litestream() {
  if ! has_r2_config; then
    return 1
  fi

  ORG_SAFE="$(sanitize_name "${ORG_ID:-org}")"
  WS_SAFE="$(sanitize_name "${WORKSPACE_ID:-ws}")"
  JFS_META_FILE="${JUICEFS_META_DIR}/${ORG_SAFE}-${WS_SAFE}.db"
  R2_BASE="$(ensure_trailing_slash "${R2_PREFIX:-${ORG_ID}/${WORKSPACE_ID}/}")"

  # Create temporary Litestream config for restore
  cat > /tmp/litestream-migrate.yml << LSEOF
dbs:
  - path: ${JFS_META_FILE}
    replica:
      type: s3
      bucket: ${R2_BUCKET_NAME}
      path: ${R2_BASE}litestream
      endpoint: https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com
      region: auto
      force-path-style: true
LSEOF

  echo "[entrypoint] Checking for Litestream backup to migrate..." >&2
  RESTORE_LOG="/tmp/litestream-restore.log"
  if litestream restore -config /tmp/litestream-migrate.yml -if-replica-exists "$JFS_META_FILE" >"$RESTORE_LOG" 2>&1; then
    if [ -s "$JFS_META_FILE" ]; then
      # Verify the database is valid
      if sqlite3 "$JFS_META_FILE" "SELECT count(*) FROM sqlite_master;" >/dev/null 2>&1; then
        FILE_SIZE="$(stat -c%s "$JFS_META_FILE" 2>/dev/null || stat -f%z "$JFS_META_FILE")"
        echo "[entrypoint] Migrated from Litestream backup ($FILE_SIZE bytes)" >&2
        chown claude:claude "$JFS_META_FILE" 2>/dev/null || true
        chmod u+rw "$JFS_META_FILE" 2>/dev/null || true
        sync

        # Backup to new format immediately
        echo "[entrypoint] Converting to new backup format..." >&2
        backup_metadata_to_r2 || echo "[entrypoint] WARNING: Failed to create new format backup" >&2

        # Delete old Litestream data from R2
        echo "[entrypoint] Cleaning up old Litestream data..." >&2
        delete_litestream_data || true

        rm -f /tmp/litestream-migrate.yml
        return 0
      else
        echo "[entrypoint] WARNING: Litestream restore produced invalid database" >&2
        rm -f "$JFS_META_FILE"
      fi
    fi
  fi

  # Check restore log for useful info
  if [ -s "$RESTORE_LOG" ] && grep -q "no matching" "$RESTORE_LOG"; then
    echo "[entrypoint] No Litestream backup found" >&2
  elif [ -s "$RESTORE_LOG" ]; then
    cat "$RESTORE_LOG" >&2
  fi

  rm -f /tmp/litestream-migrate.yml
  return 1
}

# Delete old Litestream data from R2 after migration
delete_litestream_data() {
  if ! has_r2_config; then
    return 0
  fi

  R2_BASE="$(ensure_trailing_slash "${R2_PREFIX:-${ORG_ID}/${WORKSPACE_ID}/}")"
  LITESTREAM_PREFIX="${R2_BASE}litestream/"

  echo "[entrypoint] Deleting Litestream data at ${LITESTREAM_PREFIX}..." >&2
  cd /app && node -e "
    const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
    const client = new S3Client({
      endpoint: 'https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
      region: 'auto',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        ...(process.env.AWS_SESSION_TOKEN && { sessionToken: process.env.AWS_SESSION_TOKEN }),
      },
    });
    async function cleanup() {
      let cont = true, token;
      let deleted = 0;
      while (cont) {
        const list = await client.send(new ListObjectsV2Command({
          Bucket: '${R2_BUCKET_NAME}',
          Prefix: '${LITESTREAM_PREFIX}',
          ContinuationToken: token,
        }));
        if (list.Contents && list.Contents.length > 0) {
          await client.send(new DeleteObjectsCommand({
            Bucket: '${R2_BUCKET_NAME}',
            Delete: { Objects: list.Contents.map(o => ({ Key: o.Key })) },
          }));
          deleted += list.Contents.length;
        }
        token = list.NextContinuationToken;
        cont = list.IsTruncated;
      }
      if (deleted > 0) {
        console.error('[entrypoint] Deleted', deleted, 'Litestream objects from R2');
      }
    }
    cleanup().catch(e => { console.error('[entrypoint] Cleanup error:', e.message); process.exit(1); });
  " 2>&1
}

# Restore SQLite metadata from R2 backup
# Tries new format first, then falls back to Litestream migration
restore_metadata_from_r2() {
  if ! has_r2_config; then
    return 1
  fi

  ORG_SAFE="$(sanitize_name "${ORG_ID:-org}")"
  WS_SAFE="$(sanitize_name "${WORKSPACE_ID:-ws}")"
  JFS_META_FILE="${JUICEFS_META_DIR}/${ORG_SAFE}-${WS_SAFE}.db"
  R2_BASE="$(ensure_trailing_slash "${R2_PREFIX:-${ORG_ID}/${WORKSPACE_ID}/}")"
  BACKUP_KEY="${R2_BASE}juicefs-metadata.db"

  echo "[entrypoint] Restoring JuiceFS metadata..." >&2

  # Try new backup format first (run from /app where @aws-sdk is installed)
  if cd /app && node -e "
    const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
    const fs = require('fs');
    const { pipeline } = require('stream/promises');
    const client = new S3Client({
      endpoint: 'https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
      region: 'auto',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        ...(process.env.AWS_SESSION_TOKEN && { sessionToken: process.env.AWS_SESSION_TOKEN }),
      },
    });
    async function download() {
      const response = await client.send(new GetObjectCommand({
        Bucket: '${R2_BUCKET_NAME}',
        Key: '${BACKUP_KEY}',
      }));
      await pipeline(response.Body, fs.createWriteStream('${JFS_META_FILE}'));
      console.error('[entrypoint] Downloaded metadata from new backup format');
    }
    download().catch(e => {
      if (e.name === 'NoSuchKey') process.exit(1);
      console.error('[entrypoint] Download failed:', e.message);
      process.exit(1);
    });
  " 2>&1; then
    # Verify the database is valid
    if sqlite3 "$JFS_META_FILE" "SELECT count(*) FROM sqlite_master;" >/dev/null 2>&1; then
      FILE_SIZE="$(stat -c%s "$JFS_META_FILE" 2>/dev/null || stat -f%z "$JFS_META_FILE")"
      echo "[entrypoint] Restored SQLite metadata ($FILE_SIZE bytes)" >&2
      chown claude:claude "$JFS_META_FILE" 2>/dev/null || true
      chmod u+rw "$JFS_META_FILE" 2>/dev/null || true
      sync
      return 0
    else
      echo "[entrypoint] WARNING: Downloaded file failed SQLite validation" >&2
      rm -f "$JFS_META_FILE"
    fi
  fi

  # Fall back to Litestream migration (for existing workspaces)
  echo "[entrypoint] No new-format backup found, checking for Litestream backup..." >&2
  if migrate_from_litestream; then
    return 0
  fi

  echo "[entrypoint] No backup found (new workspace)" >&2
  return 1
}

# Start periodic metadata backup loop (runs in background)
# Backs up every 1 minute to R2, skipping if no changes detected
start_periodic_backup() {
  if ! has_r2_config; then
    return 0
  fi

  ORG_SAFE="$(sanitize_name "${ORG_ID:-org}")"
  WS_SAFE="$(sanitize_name "${WORKSPACE_ID:-ws}")"
  JFS_META_FILE="${JUICEFS_META_DIR}/${ORG_SAFE}-${WS_SAFE}.db"

  echo "[entrypoint] Starting periodic metadata backup (every 1 min)..." >&2
  (
    LAST_MTIME=""
    while true; do
      sleep 60  # 1 minute

      # Get current modification time of the metadata file
      if [ -f "$JFS_META_FILE" ]; then
        CURRENT_MTIME="$(stat -c%Y "$JFS_META_FILE" 2>/dev/null || stat -f%m "$JFS_META_FILE" 2>/dev/null)"

        # Skip backup if file hasn't changed since last backup
        if [ "$CURRENT_MTIME" = "$LAST_MTIME" ]; then
          continue
        fi

        if backup_metadata_to_r2; then
          LAST_MTIME="$CURRENT_MTIME"
        fi
      fi
    done
  ) &
  BACKUP_PID=$!
  echo "[entrypoint] Backup loop PID: $BACKUP_PID" >&2
}

# Check if a tar backup exists in R2 (for migration)
check_tar_backup_exists() {
  if ! has_r2_config; then
    return 1
  fi

  R2_BASE="$(ensure_trailing_slash "${R2_PREFIX:-${ORG_ID}/${WORKSPACE_ID}/}")"
  TAR_KEY="${R2_BASE}workspace.tar.zst"

  # Check if tar backup exists by attempting to get its size
  if cd /app && node -e "
    import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
    const client = new S3Client({
      endpoint: 'https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
      region: 'auto',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        ...(process.env.AWS_SESSION_TOKEN && { sessionToken: process.env.AWS_SESSION_TOKEN }),
      },
    });
    try {
      await client.send(new HeadObjectCommand({ Bucket: '${R2_BUCKET_NAME}', Key: '${TAR_KEY}' }));
      process.exit(0);
    } catch (e) {
      process.exit(1);
    }
  " 2>/dev/null; then
    return 0
  else
    return 1
  fi
}

# Delete tar backup from R2 after successful migration
delete_tar_backup() {
  if ! has_r2_config; then
    return 0
  fi

  R2_BASE="$(ensure_trailing_slash "${R2_PREFIX:-${ORG_ID}/${WORKSPACE_ID}/}")"
  TAR_KEY="${R2_BASE}workspace.tar.zst"

  echo "[entrypoint] Deleting old tar backup after migration..." >&2
  cd /app && node -e "
    import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
    const client = new S3Client({
      endpoint: 'https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
      region: 'auto',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        ...(process.env.AWS_SESSION_TOKEN && { sessionToken: process.env.AWS_SESSION_TOKEN }),
      },
    });
    await client.send(new DeleteObjectCommand({ Bucket: '${R2_BUCKET_NAME}', Key: '${TAR_KEY}' }));
    console.error('[entrypoint] Tar backup deleted.');
  " 2>&1 || echo "[entrypoint] WARNING: Failed to delete tar backup" >&2
}

# Migrate data from tar backup to JuiceFS
migrate_from_tar() {
  echo "[entrypoint] Migrating from R2 tar backup to JuiceFS..." >&2
  MIGRATE_START_TS="$(date +%s%3N 2>/dev/null || date +%s)"

  TEMP_EXTRACT_DIR="/tmp/tar-migration"
  mkdir -p "$TEMP_EXTRACT_DIR"

  # Download and extract tar backup
  echo "[entrypoint] Downloading tar backup for migration..." >&2
  if node /app/sync.mjs download "$TEMP_EXTRACT_DIR"; then
    echo "[entrypoint] Tar backup downloaded and extracted." >&2
  else
    echo "[entrypoint] WARNING: No tar backup found or download failed, starting fresh." >&2
    rm -rf "$TEMP_EXTRACT_DIR"
    return 1
  fi

  # Copy extracted data to JuiceFS mount (already mounted at TARGET_DIR)
  echo "[entrypoint] Copying migrated data to JuiceFS..." >&2
  if [ -d "$TEMP_EXTRACT_DIR" ] && [ "$(ls -A "$TEMP_EXTRACT_DIR" 2>/dev/null)" ]; then
    # Use cp with archive mode to preserve permissions and timestamps
    cp -a "$TEMP_EXTRACT_DIR"/. "$TARGET_DIR"/ 2>/dev/null || true
    # Fix ownership - cp -a runs as root so files may have wrong ownership
    # This ensures claude user can write to all migrated files/directories
    chown -R claude:claude "$TARGET_DIR" 2>/dev/null || true
    echo "[entrypoint] Data migration complete." >&2
  fi

  # Clean up temp directory
  rm -rf "$TEMP_EXTRACT_DIR"

  # Delete the old tar backup from R2
  delete_tar_backup

  MIGRATE_END_TS="$(date +%s%3N 2>/dev/null || date +%s)"
  echo "[entrypoint] Migration completed (ms: $((MIGRATE_END_TS - MIGRATE_START_TS)))" >&2
  return 0
}

mount_juicefs() {
  if ! has_r2_config; then
    echo "[entrypoint] ERROR: Missing R2 credentials. Required: R2_BUCKET_NAME, R2_ACCOUNT_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY" >&2
    echo "[entrypoint]   R2_BUCKET_NAME=${R2_BUCKET_NAME:-MISSING}" >&2
    echo "[entrypoint]   R2_ACCOUNT_ID=${R2_ACCOUNT_ID:-MISSING}" >&2
    echo "[entrypoint]   AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:+set}${AWS_ACCESS_KEY_ID:-MISSING}" >&2
    echo "[entrypoint]   AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY:+set}${AWS_SECRET_ACCESS_KEY:-MISSING}" >&2
    return 1
  fi

  ORG_SAFE="$(sanitize_name "${ORG_ID:-org}")"
  WS_SAFE="$(sanitize_name "${WORKSPACE_ID:-ws}")"
  VOLUME_NAME="chiridion-${ORG_SAFE}-${WS_SAFE}"
  R2_BASE="$(ensure_trailing_slash "${R2_PREFIX:-${ORG_ID}/${WORKSPACE_ID}/}")"
  # JuiceFS stores data at {bucket}/{volume-name}/ regardless of any prefix in bucket URL
  # Use virtual-hosted style URL for R2: https://bucket.account.r2.cloudflarestorage.com
  JFS_BUCKET_URL="https://${R2_BUCKET_NAME}.${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  JFS_META_FILE="${JUICEFS_META_DIR}/${ORG_SAFE}-${WS_SAFE}.db"

  JFS_META_URL="sqlite3://${JFS_META_FILE}"

  echo "[entrypoint] JuiceFS config:" >&2
  echo "[entrypoint]   volume: ${VOLUME_NAME}" >&2
  echo "[entrypoint]   bucket: ${JFS_BUCKET_URL}" >&2
  echo "[entrypoint]   storage: ${JFS_BUCKET_URL}/${VOLUME_NAME}/" >&2
  echo "[entrypoint]   meta: ${JFS_META_FILE}" >&2
  echo "[entrypoint]   target: ${TARGET_DIR}" >&2

  mkdir -p "$TARGET_DIR" "$JUICEFS_META_DIR" "$JUICEFS_CACHE_DIR"
  # Ensure claude user owns these directories and any files in them
  chown -R claude:claude "$JUICEFS_CACHE_DIR" 2>/dev/null || true
  chown -R claude:claude "$JUICEFS_META_DIR" 2>/dev/null || true
  chmod -R u+rw "$JUICEFS_META_DIR" 2>/dev/null || true

  NEEDS_MIGRATION=""

  # Export R2_PREFIX for backup config (defaults to org/workspace path)
  export R2_PREFIX="${R2_PREFIX:-${ORG_ID}/${WORKSPACE_ID}/}"
  echo "[entrypoint] R2_PREFIX=$R2_PREFIX" >&2

  # Unset AWS_SESSION_TOKEN if empty (AWS SDK sends invalid header if set to empty string)
  if [ -z "${AWS_SESSION_TOKEN:-}" ]; then
    unset AWS_SESSION_TOKEN
  fi

  echo "[entrypoint] Restoring JuiceFS metadata (if present)..." >&2
  META_START_TS="$(date +%s%3N 2>/dev/null || date +%s)"

  # Restore SQLite metadata from R2 backup
  restore_metadata_from_r2 || true

  # If no JuiceFS metadata exists, check for tar backup to migrate
  if [ ! -f "$JFS_META_FILE" ] || [ ! -s "$JFS_META_FILE" ]; then
    echo "[entrypoint] No existing JuiceFS metadata in R2" >&2

    # Check if there's an old tar backup to migrate
    if check_tar_backup_exists; then
      echo "[entrypoint] Found old tar backup - will migrate after mount" >&2
      NEEDS_MIGRATION="1"
    fi
  fi

  META_END_TS="$(date +%s%3N 2>/dev/null || date +%s)"
  echo "[entrypoint] Metadata restore done (ms: $((META_END_TS - META_START_TS)))" >&2

  if [ -f "$JFS_META_FILE" ] && [ ! -s "$JFS_META_FILE" ]; then
    echo "[entrypoint] Metadata file is empty; discarding." >&2
    rm -f "$JFS_META_FILE"
  fi

  # Format new volume if no metadata file exists
  if [ ! -f "$JFS_META_FILE" ]; then
    echo "[entrypoint] Formatting new JuiceFS volume..." >&2
    FORMAT_LOG="/tmp/juicefs-format.log"
    if su -s /bin/sh claude -c "juicefs format \
      --storage s3 \
      --bucket \"$JFS_BUCKET_URL\" \
      --access-key \"$AWS_ACCESS_KEY_ID\" \
      --secret-key \"$AWS_SECRET_ACCESS_KEY\" \
      ${AWS_SESSION_TOKEN:+--session-token \"$AWS_SESSION_TOKEN\"} \
      \"$JFS_META_URL\" \
      \"$VOLUME_NAME\"" >"$FORMAT_LOG" 2>&1; then
      echo "[entrypoint] Format succeeded" >&2
    else
      # Check if format failed due to non-empty storage (orphaned data without metadata)
      if grep -q "is not empty" "$FORMAT_LOG"; then
        echo "[entrypoint] Storage has orphaned data (no metadata). Cleaning up..." >&2
        # Use AWS SDK via node to delete all objects at the JuiceFS prefix
        cd /app && node -e "
          const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
          const client = new S3Client({
            endpoint: 'https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
            region: 'auto',
            credentials: {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID,
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
              ...(process.env.AWS_SESSION_TOKEN && { sessionToken: process.env.AWS_SESSION_TOKEN }),
            },
          });
          async function cleanup() {
            const prefix = '${VOLUME_NAME}/';
            console.error('[cleanup] Listing objects at prefix:', prefix);
            let cont = true, token;
            let deleted = 0;
            while (cont) {
              const list = await client.send(new ListObjectsV2Command({
                Bucket: '${R2_BUCKET_NAME}',
                Prefix: prefix,
                ContinuationToken: token,
              }));
              if (list.Contents && list.Contents.length > 0) {
                await client.send(new DeleteObjectsCommand({
                  Bucket: '${R2_BUCKET_NAME}',
                  Delete: { Objects: list.Contents.map(o => ({ Key: o.Key })) },
                }));
                deleted += list.Contents.length;
              }
              token = list.NextContinuationToken;
              cont = list.IsTruncated;
            }
            console.error('[cleanup] Deleted', deleted, 'orphaned objects');
          }
          cleanup().catch(e => { console.error('[cleanup] Error:', e.message); process.exit(1); });
        "
        # Retry format after cleanup
        echo "[entrypoint] Retrying format..." >&2
        if su -s /bin/sh claude -c "juicefs format \
          --storage s3 \
          --bucket \"$JFS_BUCKET_URL\" \
          --access-key \"$AWS_ACCESS_KEY_ID\" \
          --secret-key \"$AWS_SECRET_ACCESS_KEY\" \
          ${AWS_SESSION_TOKEN:+--session-token \"$AWS_SESSION_TOKEN\"} \
          \"$JFS_META_URL\" \
          \"$VOLUME_NAME\"" >"$FORMAT_LOG" 2>&1; then
          echo "[entrypoint] Format succeeded after cleanup" >&2
        else
          echo "[entrypoint] ERROR: JuiceFS format still failed:" >&2
          cat "$FORMAT_LOG" >&2
          return 1
        fi
      else
        echo "[entrypoint] ERROR: JuiceFS format failed:" >&2
        cat "$FORMAT_LOG" >&2
        return 1
      fi
    fi
  else
    echo "[entrypoint] Using existing metadata: $(ls -la "$JFS_META_FILE" | awk '{print $5}') bytes" >&2
  fi

  # Update JuiceFS credentials before mounting.
  # Temp session tokens expire, so we must refresh credentials on every startup.
  # This ensures old data remains readable even after token rotation.
  echo "[entrypoint] Updating JuiceFS credentials..." >&2
  CONFIG_LOG="/tmp/juicefs-config.log"
  if su -s /bin/sh claude -c "juicefs config \
    --access-key \"$AWS_ACCESS_KEY_ID\" \
    --secret-key \"$AWS_SECRET_ACCESS_KEY\" \
    ${AWS_SESSION_TOKEN:+--session-token \"$AWS_SESSION_TOKEN\"} \
    --yes \
    \"$JFS_META_URL\"" >"$CONFIG_LOG" 2>&1; then
    echo "[entrypoint] Credentials updated" >&2
  else
    echo "[entrypoint] WARNING: Failed to update credentials (may be first-time format):" >&2
    cat "$CONFIG_LOG" >&2 || true
  fi

  echo "[entrypoint] Mounting JuiceFS at ${TARGET_DIR}..." >&2
  MOUNT_START_TS="$(date +%s%3N 2>/dev/null || date +%s)"
  CLAUDE_UID="$(id -u claude)"
  CLAUDE_GID="$(id -g claude)"
  echo "[entrypoint] Mount user: claude (uid=$CLAUDE_UID, gid=$CLAUDE_GID)" >&2

  # Check FUSE device availability
  if [ ! -c /dev/fuse ]; then
    echo "[entrypoint] ERROR: /dev/fuse device not found" >&2
    return 1
  fi
  echo "[entrypoint] /dev/fuse: $(ls -la /dev/fuse)" >&2

  JUICEFS_MOUNT_LOG="/tmp/juicefs-mount.log"
  JUICEFS_STDERR_LOG="/tmp/juicefs-mount-stderr.log"

  # Run mount in daemon mode
  echo "[entrypoint] Starting JuiceFS mount (daemon mode)..." >&2
  MOUNT_CMD="juicefs mount \"$JFS_META_URL\" \"$TARGET_DIR\" \
    --backup-meta 0 \
    --cache-dir \"$JUICEFS_CACHE_DIR\" \
    --cache-size \"$JUICEFS_CACHE_SIZE\" \
    --upload-delay \"$JUICEFS_UPLOAD_DELAY\" \
    --buffer-size \"$JUICEFS_BUFFER_SIZE\" \
    --prefix-internal \
    -o user_id=$CLAUDE_UID,group_id=$CLAUDE_GID \
    --no-syslog \
    -v \
    -d"
  echo "[entrypoint] Mount command: $MOUNT_CMD" >&2
  su -s /bin/sh claude -c "$MOUNT_CMD" >"$JUICEFS_MOUNT_LOG" 2>"$JUICEFS_STDERR_LOG"
  MOUNT_EXIT=$?
  echo "[entrypoint] JuiceFS mount exit code: $MOUNT_EXIT" >&2

  MOUNT_END_TS="$(date +%s%3N 2>/dev/null || date +%s)"

  # Check if mount succeeded (daemon mode returns after mount is ready)
  if [ "$MOUNT_EXIT" -ne 0 ]; then
    echo "[entrypoint] ERROR: JuiceFS mount failed" >&2
    echo "[entrypoint] === stdout ===" >&2
    cat "$JUICEFS_MOUNT_LOG" >&2 || true
    echo "[entrypoint] === stderr ===" >&2
    cat "$JUICEFS_STDERR_LOG" >&2 || true
    return 1
  fi

  # Verify mount point is actually mounted
  if ! grep -q " $TARGET_DIR " /proc/mounts 2>/dev/null; then
    echo "[entrypoint] ERROR: JuiceFS mount command succeeded but mount point not found" >&2
    echo "[entrypoint] === stdout ===" >&2
    cat "$JUICEFS_MOUNT_LOG" >&2 || true
    echo "[entrypoint] === stderr ===" >&2
    cat "$JUICEFS_STDERR_LOG" >&2 || true
    return 1
  fi

  echo "[entrypoint] JuiceFS mounted successfully (ms: $((MOUNT_END_TS - MOUNT_START_TS)))" >&2
  MOUNT_SUCCEEDED="1"

  # Migrate from tar backup if needed (now that JuiceFS is mounted)
  if [ "$NEEDS_MIGRATION" = "1" ]; then
    migrate_from_tar
  fi

  # Fix ownership of key directories that may have stale root ownership
  # This is needed because:
  # 1. Old migrations may have created files as root
  # 2. Previous container runs may have created directories as root
  # 3. JuiceFS metadata may have stored incorrect ownership
  echo "[entrypoint] Fixing ownership of key directories..." >&2
  OWNERSHIP_START_TS="$(date +%s%3N 2>/dev/null || date +%s)"

  # Fix .claude directory (Claude SDK config and session files)
  if [ -d "$TARGET_DIR/.claude" ]; then
    chown -R claude:claude "$TARGET_DIR/.claude" 2>/dev/null || true
  fi

  # Fix .chiridion directory (trace files, task results)
  if [ -d "$TARGET_DIR/.chiridion" ]; then
    chown -R claude:claude "$TARGET_DIR/.chiridion" 2>/dev/null || true
  fi

  # Fix .npm directory (npm cache)
  if [ -d "$TARGET_DIR/.npm" ]; then
    chown -R claude:claude "$TARGET_DIR/.npm" 2>/dev/null || true
  fi

  # Fix .config directory (various tool configs)
  if [ -d "$TARGET_DIR/.config" ]; then
    chown -R claude:claude "$TARGET_DIR/.config" 2>/dev/null || true
  fi

  # Fix .local directory (local binaries and data)
  if [ -d "$TARGET_DIR/.local" ]; then
    chown -R claude:claude "$TARGET_DIR/.local" 2>/dev/null || true
  fi

  # Fix .cache directory (various caches)
  if [ -d "$TARGET_DIR/.cache" ]; then
    chown -R claude:claude "$TARGET_DIR/.cache" 2>/dev/null || true
  fi

  OWNERSHIP_END_TS="$(date +%s%3N 2>/dev/null || date +%s)"
  echo "[entrypoint] Ownership fix done (ms: $((OWNERSHIP_END_TS - OWNERSHIP_START_TS)))" >&2

  return 0
}

# Cleanup function for shutdown (runs on EXIT, which fires for all termination paths)
# Cloudflare gives containers ~15 minutes for graceful shutdown, so we can take our time
# to ensure data is properly flushed and backed up.
#
# Shutdown order:
# 1. Stop application processes (ws-server, control-plane)
# 2. Stop periodic backup loop
# 3. Unmount JuiceFS (flushes writeback cache to R2, updates SQLite metadata)
# 4. Final backup of metadata to R2
cleanup() {
  echo "[entrypoint] Shutting down... (reason: ${SHUTDOWN_REASON:-unknown})" >&2
  CLEANUP_START_TS="$(date +%s)"

  # Step 1: Stop application processes
  # Kill ws-server if running
  if [ -n "${WS_PID:-}" ] && kill -0 "$WS_PID" 2>/dev/null; then
    echo "[entrypoint] Stopping ws-server (PID: $WS_PID)..." >&2
    kill "$WS_PID" 2>/dev/null || true
    wait "$WS_PID" 2>/dev/null || true
  fi

  # Kill periodic backup loop if running
  if [ -n "${BACKUP_PID:-}" ] && kill -0 "$BACKUP_PID" 2>/dev/null; then
    kill "$BACKUP_PID" 2>/dev/null || true
  fi

  # Kill session indexer loop if running
  if [ -n "${INDEXER_PID:-}" ] && kill -0 "$INDEXER_PID" 2>/dev/null; then
    kill "$INDEXER_PID" 2>/dev/null || true
  fi

  # Kill control-plane if running
  if [ -n "${CONTROL_PID:-}" ] && kill -0 "$CONTROL_PID" 2>/dev/null; then
    echo "[entrypoint] Stopping control-plane (PID: $CONTROL_PID)..." >&2
    kill "$CONTROL_PID" 2>/dev/null || true
    wait "$CONTROL_PID" 2>/dev/null || true
  fi

  # Step 2: Unmount JuiceFS (flushes writeback cache to R2, updates SQLite metadata)
  if grep -q " $TARGET_DIR " /proc/mounts 2>/dev/null; then
    echo "[entrypoint] Unmounting JuiceFS (flushing writeback cache)..." >&2
    # juicefs umount flushes all dirty data before unmounting
    if ! juicefs umount "$TARGET_DIR" 2>&1; then
      echo "[entrypoint] juicefs umount failed, trying fusermount..." >&2
      fusermount -u "$TARGET_DIR" 2>/dev/null || true
    fi
    echo "[entrypoint] JuiceFS unmounted" >&2
    sync
  fi

  # Step 3: Final backup of metadata to R2
  echo "[entrypoint] Performing final metadata backup..." >&2
  backup_metadata_to_r2 || echo "[entrypoint] WARNING: Final backup failed" >&2

  # Unmount R2 goofys mounts
  fusermount -u /mnt/user-uploads 2>/dev/null || true
  fusermount -u /mnt/user-outputs 2>/dev/null || true

  CLEANUP_END_TS="$(date +%s)"
  echo "[entrypoint] Shutdown complete (took $((CLEANUP_END_TS - CLEANUP_START_TS))s)" >&2
}

# Track shutdown reason for debugging
SHUTDOWN_REASON="unknown"

# Trap EXIT for cleanup, and TERM/INT to convert signals into normal exits.
# In dash (Debian's /bin/sh), EXIT trap doesn't fire on untrapped signals,
# so we must trap TERM/INT to ensure cleanup runs on container shutdown.
trap cleanup EXIT
trap 'SHUTDOWN_REASON="SIGTERM"; echo "[entrypoint] Received SIGTERM (from CF runtime)" >&2; exit 0' TERM
trap 'SHUTDOWN_REASON="SIGINT"; echo "[entrypoint] Received SIGINT" >&2; exit 0' INT

# Mount JuiceFS (includes migration from tar if needed) - skip if DISABLE_JUICEFS=1
if [ "${DISABLE_JUICEFS:-}" = "1" ]; then
  echo "[entrypoint] DISABLE_JUICEFS=1 - skipping JuiceFS mount, using local filesystem" >&2
  mkdir -p "$TARGET_DIR"
  chown claude:claude "$TARGET_DIR"
else
  if ! mount_juicefs; then
    echo "[entrypoint] Fatal: JuiceFS mount failed." >&2
    exit 1
  fi

  # Sync metadata to disk
  sync

  # Start periodic metadata backup to R2 (every 1 minute, skips if no changes)
  start_periodic_backup

  fi

# Skills: symlink each system skill individually so user can add their own
# Must complete before ws-server since Claude agent reads skills at startup
echo "[entrypoint] Setting up skill symlinks..." >&2
su -s /bin/sh claude -c "mkdir -p '$TARGET_DIR/.claude/skills'" 2>/dev/null || true
for skill_dir in /etc/claude-code/skills/*/; do
  skill_name="$(basename "$skill_dir")"
  # Remove existing (file, dir, or symlink) and create fresh symlink
  su -s /bin/sh claude -c "rm -rf '$TARGET_DIR/.claude/skills/$skill_name'" 2>/dev/null || true
  su -s /bin/sh claude -c "ln -sf '/etc/claude-code/skills/$skill_name' '$TARGET_DIR/.claude/skills/$skill_name'"
done
echo "[entrypoint] System skills symlinked to $TARGET_DIR/.claude/skills/" >&2

# Write env vars to a file that claude user can source (needed before ws-server)
cat > /tmp/ws-env.sh << ENVEOF
export HOME='${TARGET_DIR}'
export ANTHROPIC_API_KEY='${ANTHROPIC_API_KEY:-}'
export ANTHROPIC_BASE_URL='${ANTHROPIC_BASE_URL:-}'
export ORG_ID='${ORG_ID:-}'
export WORKSPACE_ID='${WORKSPACE_ID:-}'
export R2_BUCKET_NAME='${R2_BUCKET_NAME:-}'
export R2_ACCOUNT_ID='${R2_ACCOUNT_ID:-}'
export R2_MOUNT_DIR='${R2_MOUNT_DIR:-}'
export R2_PREFIX='${R2_PREFIX:-}'
export JUICEFS_META_DIR='${JUICEFS_META_DIR:-}'
export JUICEFS_CACHE_DIR='${JUICEFS_CACHE_DIR:-}'
export AWS_ACCESS_KEY_ID='${AWS_ACCESS_KEY_ID:-}'
export AWS_SECRET_ACCESS_KEY='${AWS_SECRET_ACCESS_KEY:-}'
export AWS_SESSION_TOKEN='${AWS_SESSION_TOKEN:-}'
export CLOUDFLARE_ACCOUNT_ID='${CLOUDFLARE_ACCOUNT_ID:-}'
export CLOUDFLARE_API_TOKEN='${CLOUDFLARE_API_TOKEN:-}'
export CLOUDFLARE_API_BASE_URL='${CLOUDFLARE_API_BASE_URL:-}'
export CF_DISPATCH_NAMESPACE='${CF_DISPATCH_NAMESPACE:-}'
export WORKER_BASE_URL='${WORKER_BASE_URL:-}'
export MCP_SERVER_URL='${MCP_SERVER_URL:-}'
ENVEOF
chmod 644 /tmp/ws-env.sh

# Start ws-server EARLY - this is the critical path for WebSocket availability
# Uses Claude Agent SDK for streaming conversations
# Run in foreground (no exec) so the shell stays alive for the trap
echo "[entrypoint] Starting ws-server (SDK) as claude user on port 8080..." >&2
su -s /bin/sh claude -c ". /tmp/ws-env.sh && cd '$TARGET_DIR' && node /app/ws-server.mjs" &
WS_PID=$!
echo "[entrypoint] ws-server PID: $WS_PID" >&2

# Everything below runs in parallel while ws-server is starting
# These are non-blocking for WebSocket availability

# Start control-plane server as claude user (runs on port 9000)
echo "[entrypoint] Starting control-plane server on port 9000..." >&2
su -s /bin/sh claude -c ". /tmp/ws-env.sh && cd '$TARGET_DIR' && node /app/control-plane.mjs" &
CONTROL_PID=$!
echo "[entrypoint] Control-plane PID: $CONTROL_PID" >&2

# Mount R2 paths via goofys for file sharing with user (background)
if has_r2_config; then
  (
    echo "[entrypoint] Mounting R2 file sharing directories..." >&2
    R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
    R2_BASE="$(ensure_trailing_slash "${R2_PREFIX:-${ORG_ID}/${WORKSPACE_ID}/}")"

    # Create mount directories
    mkdir -p /mnt/user-uploads /mnt/user-outputs

    # Mount user-uploads (files uploaded by user via web UI)
    if goofys --endpoint "$R2_ENDPOINT" -o allow_other --uid "$(id -u claude)" --gid "$(id -g claude)" \
        "${R2_BUCKET_NAME}:${R2_BASE}user-uploads" /mnt/user-uploads 2>&1; then
      echo "[entrypoint] Mounted /mnt/user-uploads" >&2
    else
      echo "[entrypoint] WARNING: Failed to mount /mnt/user-uploads" >&2
    fi

    # Mount user-outputs (files created for user to download)
    if goofys --endpoint "$R2_ENDPOINT" -o allow_other --uid "$(id -u claude)" --gid "$(id -g claude)" \
        "${R2_BUCKET_NAME}:${R2_BASE}user-outputs" /mnt/user-outputs 2>&1; then
      echo "[entrypoint] Mounted /mnt/user-outputs" >&2
    else
      echo "[entrypoint] WARNING: Failed to mount /mnt/user-outputs" >&2
    fi
  ) &
fi

# Create golden template in background (for instant project creation via juicefs clone)
# Golden template has yarn install done, so clone gets everything ready-to-use
# NOTE: All file operations must run as claude user since JuiceFS mount is user_id=1001
echo "[entrypoint] Setting up golden template..." >&2
(
  TEMPLATE_NAME="chiridion-starter"
  SOURCE_TEMPLATE="/app/skills/developing-software/templates/${TEMPLATE_NAME}"
  GOLDEN_DIR="${TARGET_DIR}/.chiridion/templates"
  GOLDEN_TEMPLATE="${GOLDEN_DIR}/${TEMPLATE_NAME}"
  LOCK_FILE="${GOLDEN_DIR}/.${TEMPLATE_NAME}.lock"
  READY_FILE="${GOLDEN_TEMPLATE}/.chiridion-ready"

  # Check source exists (can do as root since it's local fs)
  if [ ! -d "$SOURCE_TEMPLATE" ]; then
    echo "[golden-template] ERROR: Source template missing: ${SOURCE_TEMPLATE}" >&2
    exit 1
  fi

  echo "[golden-template] Source: ${SOURCE_TEMPLATE} ($(find "${SOURCE_TEMPLATE}" -type f | wc -l) files)" >&2
  echo "[golden-template] Dest: ${GOLDEN_TEMPLATE}" >&2

  # Create lock and clear stale readiness marker before mutating template.
  if ! su -s /bin/sh claude -c "
    set -e
    mkdir -p '$GOLDEN_DIR'
    touch '$LOCK_FILE'
    rm -f '$READY_FILE'
  " 2>&1; then
    echo "[golden-template] Failed to set lock file (non-critical)" >&2
    exit 1
  fi

  # Sync, warm cache, and install as claude user
  echo "[golden-template] Starting sync, warmup, and install..." >&2
  SYNC_START="$(date +%s)"
  if su -s /bin/sh claude -c "
    set -e
    juicefs sync '${SOURCE_TEMPLATE}/' '$GOLDEN_TEMPLATE/' --update
    # Warmup is best-effort; install/readiness should proceed even if warmup has partial failures.
    juicefs warmup '$GOLDEN_TEMPLATE' -p 100 || echo '[golden-template] WARNING: warmup failed, continuing with install' >&2
    cd '$GOLDEN_TEMPLATE'
    yarn install
    touch '$READY_FILE'
  " 2>&1; then
    SYNC_END="$(date +%s)"
    echo "[golden-template] Ready (took $((SYNC_END - SYNC_START))s)" >&2
  else
    SYNC_END="$(date +%s)"
    echo "[golden-template] Failed after $((SYNC_END - SYNC_START))s (non-critical)" >&2
  fi

  # Always remove lock so create-worker can proceed or fail-fast on readiness.
  su -s /bin/sh claude -c "rm -f '$LOCK_FILE'" 2>/dev/null || true
) &

# Start session indexer loop (indexes Claude session files every 60s for memory search)
echo "[entrypoint] Starting session indexer loop..." >&2
(
  # Wait a bit for initial sessions to be created
  sleep 30
  while true; do
    # Run index as claude user so os.homedir() resolves to /home/claude (not /root)
    su -s /bin/sh claude -c ". /tmp/ws-env.sh && cd '$TARGET_DIR' && node /app/session-search/src/cli.mjs index --quiet" 2>/dev/null || true
    sleep 60
  done
) &
INDEXER_PID=$!
echo "[entrypoint] Session indexer PID: $INDEXER_PID" >&2

END_TS="$(date +%s%3N 2>/dev/null || date +%s)"
echo "[entrypoint] Initialization complete (ms: $((END_TS - START_TS)))" >&2

# Wait for ws-server - when it exits, the cleanup trap will run
wait "$WS_PID"
WS_EXIT=$?
SHUTDOWN_REASON="ws-server-exit-$WS_EXIT"
echo "[entrypoint] ws-server exited with code: $WS_EXIT" >&2

# Exit with ws-server's exit code (cleanup runs via EXIT trap)
exit $WS_EXIT
