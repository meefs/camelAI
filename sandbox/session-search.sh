#!/bin/bash
# session-search - Search Claude session history
# Uses jq for streaming JSONL parsing, sqlite3 for FTS5 search
# Fully streaming - never loads entire files into memory
set -euo pipefail

CLAUDE_DIR="${HOME}/.claude/projects"
DB_DIR="${HOME}/.chiridion"
DB_PATH="${DB_DIR}/sessions.db"

# Initialize database with schema
init_db() {
  mkdir -p "$DB_DIR"
  sqlite3 "$DB_PATH" <<'SQL'
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  project_path TEXT,
  file_path TEXT,
  file_size INTEGER DEFAULT 0,
  last_indexed_pos INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  uuid TEXT UNIQUE,
  type TEXT,
  role TEXT,
  content TEXT,
  timestamp TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  session_id UNINDEXED,
  uuid UNINDEXED,
  type UNINDEXED,
  role UNINDEXED,
  timestamp UNINDEXED,
  content='messages',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content, session_id, uuid, type, role, timestamp)
  VALUES (new.id, new.content, new.session_id, new.uuid, new.type, new.role, new.timestamp);
END;
SQL
}

# Get last indexed position for a session file
get_last_pos() {
  local session_id="$1"
  local escaped="${session_id//\'/\'\'}"
  sqlite3 "$DB_PATH" "SELECT COALESCE(last_indexed_pos, 0) FROM sessions WHERE session_id = '$escaped';" 2>/dev/null || echo "0"
}

# Index a single JSONL file - streams line by line using jq
index_file() {
  local file_path="$1"
  local session_id project_path file_size last_pos

  session_id=$(basename "$file_path" .jsonl)
  project_path=$(basename "$(dirname "$file_path")")

  [[ -f "$file_path" ]] || return 0

  file_size=$(stat -c%s "$file_path" 2>/dev/null || stat -f%z "$file_path")
  last_pos=$(get_last_pos "$session_id")
  last_pos=${last_pos:-0}

  # Skip if no new content
  [[ "$last_pos" -ge "$file_size" ]] && return 0

  # Stream JSONL through jq, generate SQL, pipe to sqlite3
  # Using @json for proper escaping of all values
  local sql
  sql=$(tail -c +$((last_pos + 1)) "$file_path" 2>/dev/null | jq -r --arg sid "$session_id" --arg proj "$project_path" '
    select((.type == "user" or .type == "assistant" or .type == "system") and .uuid) |

    # Extract content
    (.message.content | if type == "string" then .
      elif type == "array" then [.[] | if .type == "text" then .text elif .type == "thinking" then .thinking else empty end] | join("\n")
      else "" end) as $content |

    # Get session_id from message or use filename
    ((.sessionId // "") | if . == "" then $sid else . end) as $msg_sid |

    # Generate SQL with @json escaping (handles quotes, newlines, etc)
    "INSERT OR IGNORE INTO sessions (session_id, project_path) VALUES (\($msg_sid | @json), \($proj | @json));",
    "INSERT OR IGNORE INTO messages (session_id, uuid, type, role, content, timestamp) VALUES (\($msg_sid | @json), \(.uuid | @json), \(.type | @json), \(.message.role // "" | @json), \($content | @json), \(.timestamp // "" | @json));"
  ' 2>/dev/null) || true

  if [[ -n "$sql" ]]; then
    {
      echo "BEGIN TRANSACTION;"
      echo "$sql"
      echo "COMMIT;"
    } | sqlite3 "$DB_PATH" 2>/dev/null || true

    # Count messages indexed
    local count
    count=$(echo "$sql" | grep -c "INSERT OR IGNORE INTO messages" || echo 0)
    [[ "$count" -gt 0 ]] && echo "$session_id: $count" >&2
  fi

  # Update position
  local esc_sid="${session_id//\'/\'\'}"
  sqlite3 "$DB_PATH" "INSERT OR REPLACE INTO sessions (session_id, project_path, file_path, file_size, last_indexed_pos) VALUES ('$esc_sid', '$project_path', '$file_path', $file_size, $file_size);" 2>/dev/null || true
}

# Index all session files
cmd_index() {
  local quiet="${1:-}"

  [[ -d "$CLAUDE_DIR" ]] || { echo "No Claude projects directory found" >&2; return 1; }

  init_db

  local start_time
  start_time=$(date +%s)

  # Find and index all JSONL files
  while IFS= read -r file; do
    index_file "$file"
  done < <(find "$CLAUDE_DIR" -name "*.jsonl" -type f 2>/dev/null)

  if [[ -z "$quiet" ]]; then
    local elapsed=$(($(date +%s) - start_time))
    echo "Done (${elapsed}s)" >&2
    cmd_stats
  fi
}

# Full-text search
cmd_search() {
  local query="$1"
  local limit="${2:-20}"

  init_db

  sqlite3 -separator $'\t' "$DB_PATH" "
    SELECT m.timestamp, COALESCE(m.role, m.type), m.session_id,
           snippet(messages_fts, 0, '>>>', '<<<', '...', 64)
    FROM messages_fts
    JOIN messages m ON messages_fts.rowid = m.id
    WHERE messages_fts MATCH '\"${query//\"/\"\"}\"'
    ORDER BY rank
    LIMIT $limit;
  " | while IFS=$'\t' read -r timestamp role session_id snippet; do
    printf '\n\033[36m[%s]\033[0m \033[33m%s\033[0m (session: %s...)\n' "$timestamp" "$role" "${session_id:0:8}"
    printf '  %s\n' "$snippet"
  done
}

# List sessions
cmd_list() {
  local limit="${1:-20}"

  init_db

  printf '\n%-40s %8s  %s\n' "SESSION ID" "MESSAGES" "PROJECT"
  printf '%s\n' "--------------------------------------------------------------------------------"

  sqlite3 -separator $'\t' "$DB_PATH" "
    SELECT s.session_id,
           (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.session_id),
           COALESCE(s.project_path, '')
    FROM sessions s
    ORDER BY s.session_id DESC
    LIMIT $limit;
  " | while IFS=$'\t' read -r sid count proj; do
    printf '%-40s %8s  %s\n' "${sid:0:40}" "$count" "$proj"
  done
}

# Show stats
cmd_stats() {
  init_db

  local sessions messages
  sessions=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM sessions;")
  messages=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM messages;")

  printf '\n=== Session Search Stats ===\n'
  printf 'Sessions: %s\n' "$sessions"
  printf 'Messages: %s\n' "$messages"

  printf '\nBy type:\n'
  sqlite3 "$DB_PATH" "SELECT '  ' || type || ': ' || COUNT(*) FROM messages GROUP BY type;"

  printf '\nBy role:\n'
  sqlite3 "$DB_PATH" "SELECT '  ' || COALESCE(role, '(none)') || ': ' || COUNT(*) FROM messages GROUP BY role;"
}

# Main
case "${1:-help}" in
  index)
    cmd_index "${2:-}"
    ;;
  search|s)
    [[ -z "${2:-}" ]] && { echo "Usage: session-search search <query> [limit]" >&2; exit 1; }
    cmd_search "$2" "${3:-20}"
    ;;
  list|ls)
    cmd_list "${2:-20}"
    ;;
  stats)
    cmd_stats
    ;;
  *)
    echo "session-search - Search Claude session history"
    echo ""
    echo "Commands:"
    echo "  index [--quiet]     Index all session files"
    echo "  search <query>      Full-text search"
    echo "  list [limit]        List sessions"
    echo "  stats               Show statistics"
    ;;
esac
