package state

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// SpendLimit defines a rolling time window with a USD cap.
type SpendLimit struct {
	Window   time.Duration `json:"window"`
	LimitUSD float64       `json:"limit_usd"`
	Label    string        `json:"label"` // human-readable, e.g. "5h", "7d"
}

// DefaultSpendLimits are enforced for all orgs unless overridden.
var DefaultSpendLimits = []SpendLimit{
	{Window: 5 * time.Hour, LimitUSD: 50, Label: "5h"},
	{Window: 7 * 24 * time.Hour, LimitUSD: 200, Label: "7d"},
}

// WindowSpend holds the spend for a single rolling window.
type WindowSpend struct {
	Label    string  `json:"label"`
	WindowMs int64   `json:"window_ms"`
	LimitUSD float64 `json:"limit_usd"`
	SpentUSD float64 `json:"spent_usd"`
	Exceeded bool    `json:"exceeded"`
}

// UsageStore manages per-org SQLite databases for usage tracking.
// Each org gets its own database file at {baseDir}/{orgId}/usage.db.
type UsageStore struct {
	baseDir string

	mu    sync.Mutex
	conns map[string]*sql.DB // orgId -> *sql.DB
}

// NewUsageStore creates a new per-org usage store rooted at baseDir.
func NewUsageStore(baseDir string) (*UsageStore, error) {
	if baseDir == "" {
		return nil, errors.New("usage store base dir is required")
	}
	if err := os.MkdirAll(baseDir, 0o755); err != nil {
		return nil, fmt.Errorf("create usage store base dir: %w", err)
	}
	return &UsageStore{
		baseDir: baseDir,
		conns:   make(map[string]*sql.DB),
	}, nil
}

// Close closes all open per-org database connections.
func (u *UsageStore) Close() error {
	if u == nil {
		return nil
	}
	u.mu.Lock()
	defer u.mu.Unlock()

	var firstErr error
	for orgID, db := range u.conns {
		if err := db.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
		delete(u.conns, orgID)
	}
	return firstErr
}

// getDB returns or creates the SQLite connection for an org.
func (u *UsageStore) getDB(orgID string) (*sql.DB, error) {
	u.mu.Lock()
	defer u.mu.Unlock()

	if db, ok := u.conns[orgID]; ok {
		return db, nil
	}

	orgDir := filepath.Join(u.baseDir, orgID)
	if err := os.MkdirAll(orgDir, 0o755); err != nil {
		return nil, fmt.Errorf("create org usage dir: %w", err)
	}

	dbPath := filepath.Join(orgDir, "usage.db")
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)", dbPath)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open org usage db: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetConnMaxIdleTime(2 * time.Minute)
	db.SetConnMaxLifetime(30 * time.Minute)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping org usage db: %w", err)
	}

	if err := u.initOrgSchema(ctx, db); err != nil {
		_ = db.Close()
		return nil, err
	}

	u.conns[orgID] = db
	return db, nil
}

func (u *UsageStore) initOrgSchema(ctx context.Context, db *sql.DB) error {
	statements := []string{
		// Per-request usage log.
		`CREATE TABLE IF NOT EXISTS usage_log (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			workspace_id TEXT NOT NULL DEFAULT '',
			user_id TEXT NOT NULL DEFAULT '',
			thread_id TEXT NOT NULL DEFAULT '',
			model TEXT NOT NULL,
			provider TEXT NOT NULL DEFAULT '',
			input_tokens INTEGER NOT NULL DEFAULT 0,
			output_tokens INTEGER NOT NULL DEFAULT 0,
			cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
			cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
			cost_usd REAL NOT NULL DEFAULT 0,
			duration_ms INTEGER NOT NULL DEFAULT 0,
			created_at_ms INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_usage_log_created_at ON usage_log(created_at_ms)`,
		`CREATE INDEX IF NOT EXISTS idx_usage_log_workspace_id ON usage_log(workspace_id)`,

		// Org-level totals + optional per-org limit overrides.
		`CREATE TABLE IF NOT EXISTS spend (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			total_cost_usd REAL NOT NULL DEFAULT 0,
			total_input_tokens INTEGER NOT NULL DEFAULT 0,
			total_output_tokens INTEGER NOT NULL DEFAULT 0,
			total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
			total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
			total_requests INTEGER NOT NULL DEFAULT 0,
			limits_json TEXT NOT NULL DEFAULT '',
			updated_at_ms INTEGER NOT NULL DEFAULT 0
		)`,
	}

	for _, stmt := range statements {
		if _, err := db.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("init org usage schema: %w", err)
		}
	}

	// Ensure the single spend row exists.
	_, err := db.ExecContext(ctx, `INSERT OR IGNORE INTO spend (id) VALUES (1)`)
	return err
}

// UsageRecord represents a single AI Gateway request's token usage and cost.
type UsageRecord struct {
	OrgID                    string
	WorkspaceID              string
	UserID                   string
	ThreadID                 string
	Model                    string
	Provider                 string
	InputTokens              int64
	OutputTokens             int64
	CacheCreationInputTokens int64
	CacheReadInputTokens     int64
	CostUSD                  float64
	DurationMs               int64
}

// RecordUsage inserts a usage log entry and atomically increments the spend totals.
func (u *UsageStore) RecordUsage(record UsageRecord) error {
	if u == nil {
		return nil
	}
	db, err := u.getDB(record.OrgID)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	now := time.Now().UTC().UnixMilli()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin usage tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO usage_log (
			workspace_id, user_id, thread_id, model, provider,
			input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
			cost_usd, duration_ms, created_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		record.WorkspaceID, record.UserID, record.ThreadID,
		record.Model, record.Provider,
		record.InputTokens, record.OutputTokens,
		record.CacheCreationInputTokens, record.CacheReadInputTokens,
		record.CostUSD, record.DurationMs, now,
	); err != nil {
		return fmt.Errorf("insert usage_log: %w", err)
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE spend SET
			total_cost_usd = total_cost_usd + ?,
			total_input_tokens = total_input_tokens + ?,
			total_output_tokens = total_output_tokens + ?,
			total_cache_creation_tokens = total_cache_creation_tokens + ?,
			total_cache_read_tokens = total_cache_read_tokens + ?,
			total_requests = total_requests + 1,
			updated_at_ms = ?
		WHERE id = 1`,
		record.CostUSD,
		record.InputTokens, record.OutputTokens,
		record.CacheCreationInputTokens, record.CacheReadInputTokens,
		now,
	); err != nil {
		return fmt.Errorf("update spend: %w", err)
	}

	return tx.Commit()
}

// OrgSpend holds lifetime totals for an org.
type OrgSpend struct {
	TotalCostUSD  float64
	TotalRequests int64
}

// GetOrgSpend returns lifetime spend totals for an org.
func (u *UsageStore) GetOrgSpend(orgID string) (OrgSpend, error) {
	if u == nil {
		return OrgSpend{}, nil
	}
	db, err := u.getDB(orgID)
	if err != nil {
		return OrgSpend{}, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	var spend OrgSpend
	err = db.QueryRowContext(ctx, `
		SELECT total_cost_usd, total_requests
		FROM spend WHERE id = 1`,
	).Scan(&spend.TotalCostUSD, &spend.TotalRequests)

	if errors.Is(err, sql.ErrNoRows) {
		return OrgSpend{}, nil
	}
	return spend, err
}

// GetSpendLimits returns the effective spend limits for an org.
// Returns per-org overrides if set, otherwise DefaultSpendLimits.
func (u *UsageStore) GetSpendLimits(orgID string) ([]SpendLimit, error) {
	if u == nil {
		return DefaultSpendLimits, nil
	}
	db, err := u.getDB(orgID)
	if err != nil {
		return DefaultSpendLimits, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	var limitsJSON string
	err = db.QueryRowContext(ctx, `SELECT limits_json FROM spend WHERE id = 1`).Scan(&limitsJSON)
	if err != nil || limitsJSON == "" {
		return DefaultSpendLimits, nil
	}

	var limits []SpendLimit
	if json.Unmarshal([]byte(limitsJSON), &limits) != nil || len(limits) == 0 {
		return DefaultSpendLimits, nil
	}
	return limits, nil
}

// SetSpendLimits sets per-org spend limit overrides. Pass nil to revert to defaults.
func (u *UsageStore) SetSpendLimits(orgID string, limits []SpendLimit) error {
	if u == nil {
		return nil
	}
	db, err := u.getDB(orgID)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	now := time.Now().UTC().UnixMilli()

	limitsJSON := ""
	if len(limits) > 0 {
		data, err := json.Marshal(limits)
		if err != nil {
			return fmt.Errorf("marshal limits: %w", err)
		}
		limitsJSON = string(data)
	}

	_, err = db.ExecContext(ctx, `
		UPDATE spend SET limits_json = ?, updated_at_ms = ? WHERE id = 1`,
		limitsJSON, now,
	)
	return err
}

// CheckSpendLimits checks all rolling time windows for an org.
// Returns the first exceeded window (if any) and the full window status.
func (u *UsageStore) CheckSpendLimits(orgID string) (exceeded *WindowSpend, windows []WindowSpend, err error) {
	if u == nil {
		return nil, nil, nil
	}

	limits, err := u.GetSpendLimits(orgID)
	if err != nil {
		return nil, nil, err
	}

	db, err := u.getDB(orgID)
	if err != nil {
		return nil, nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	now := time.Now().UTC().UnixMilli()
	windows = make([]WindowSpend, 0, len(limits))

	for _, limit := range limits {
		cutoff := now - limit.Window.Milliseconds()
		var spent float64
		err := db.QueryRowContext(ctx, `
			SELECT COALESCE(SUM(cost_usd), 0) FROM usage_log WHERE created_at_ms > ?`,
			cutoff,
		).Scan(&spent)
		if err != nil {
			return nil, nil, fmt.Errorf("query window spend (%s): %w", limit.Label, err)
		}

		ws := WindowSpend{
			Label:    limit.Label,
			WindowMs: limit.Window.Milliseconds(),
			LimitUSD: limit.LimitUSD,
			SpentUSD: spent,
			Exceeded: spent >= limit.LimitUSD,
		}
		windows = append(windows, ws)

		if ws.Exceeded && exceeded == nil {
			exceeded = &ws
		}
	}

	return exceeded, windows, nil
}

// UsageLogEntry represents a single row from the usage_log table.
type UsageLogEntry struct {
	ID                       int64   `json:"id"`
	WorkspaceID              string  `json:"workspace_id"`
	UserID                   string  `json:"user_id"`
	ThreadID                 string  `json:"thread_id"`
	Model                    string  `json:"model"`
	Provider                 string  `json:"provider"`
	InputTokens              int64   `json:"input_tokens"`
	OutputTokens             int64   `json:"output_tokens"`
	CacheCreationInputTokens int64   `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     int64   `json:"cache_read_input_tokens"`
	CostUSD                  float64 `json:"cost_usd"`
	DurationMs               int64   `json:"duration_ms"`
	CreatedAtMs              int64   `json:"created_at_ms"`
}

// GetUsageLog returns the most recent usage log entries for an org.
func (u *UsageStore) GetUsageLog(orgID string, limit int) ([]UsageLogEntry, error) {
	if u == nil {
		return nil, nil
	}
	db, err := u.getDB(orgID)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	rows, err := db.QueryContext(ctx, `
		SELECT id, workspace_id, user_id, thread_id, model, provider,
		       input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
		       cost_usd, duration_ms, created_at_ms
		FROM usage_log
		ORDER BY created_at_ms DESC
		LIMIT ?`, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("query usage_log: %w", err)
	}
	defer rows.Close()

	var entries []UsageLogEntry
	for rows.Next() {
		var e UsageLogEntry
		if err := rows.Scan(
			&e.ID, &e.WorkspaceID, &e.UserID, &e.ThreadID,
			&e.Model, &e.Provider,
			&e.InputTokens, &e.OutputTokens,
			&e.CacheCreationInputTokens, &e.CacheReadInputTokens,
			&e.CostUSD, &e.DurationMs, &e.CreatedAtMs,
		); err != nil {
			return nil, fmt.Errorf("scan usage_log row: %w", err)
		}
		entries = append(entries, e)
	}
	return entries, rows.Err()
}

// UsageLogQuery defines filters for paginated usage log queries.
type UsageLogQuery struct {
	Limit  int
	Cursor int64 // cursor is the id to paginate from (exclusive, descending)
	FromMs int64 // inclusive lower bound on created_at_ms (0 = no filter)
	ToMs   int64 // exclusive upper bound on created_at_ms (0 = no filter)
}

// UsageLogPage holds a page of usage log entries plus pagination metadata.
type UsageLogPage struct {
	Entries    []UsageLogEntry `json:"entries"`
	Count      int             `json:"count"`
	HasMore    bool            `json:"has_more"`
	NextCursor string          `json:"next_cursor"`
}

// GetUsageLogPaginated returns a paginated, optionally date-filtered page of usage log entries.
func (u *UsageStore) GetUsageLogPaginated(orgID string, q UsageLogQuery) (UsageLogPage, error) {
	if u == nil {
		return UsageLogPage{Entries: []UsageLogEntry{}}, nil
	}
	db, err := u.getDB(orgID)
	if err != nil {
		return UsageLogPage{}, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	// Build query dynamically based on filters.
	query := `SELECT id, workspace_id, user_id, thread_id, model, provider,
	       input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
	       cost_usd, duration_ms, created_at_ms
		FROM usage_log WHERE 1=1`
	var args []any

	if q.Cursor > 0 {
		query += ` AND id < ?`
		args = append(args, q.Cursor)
	}
	if q.FromMs > 0 {
		query += ` AND created_at_ms >= ?`
		args = append(args, q.FromMs)
	}
	if q.ToMs > 0 {
		query += ` AND created_at_ms < ?`
		args = append(args, q.ToMs)
	}

	// Fetch limit+1 to detect has_more.
	fetchLimit := q.Limit + 1
	query += ` ORDER BY id DESC LIMIT ?`
	args = append(args, fetchLimit)

	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return UsageLogPage{}, fmt.Errorf("query usage_log paginated: %w", err)
	}
	defer rows.Close()

	entries := make([]UsageLogEntry, 0, q.Limit)
	for rows.Next() {
		var e UsageLogEntry
		if err := rows.Scan(
			&e.ID, &e.WorkspaceID, &e.UserID, &e.ThreadID,
			&e.Model, &e.Provider,
			&e.InputTokens, &e.OutputTokens,
			&e.CacheCreationInputTokens, &e.CacheReadInputTokens,
			&e.CostUSD, &e.DurationMs, &e.CreatedAtMs,
		); err != nil {
			return UsageLogPage{}, fmt.Errorf("scan usage_log row: %w", err)
		}
		entries = append(entries, e)
	}
	if err := rows.Err(); err != nil {
		return UsageLogPage{}, err
	}

	hasMore := len(entries) > q.Limit
	if hasMore {
		entries = entries[:q.Limit]
	}

	var nextCursor string
	if hasMore && len(entries) > 0 {
		nextCursor = strconv.FormatInt(entries[len(entries)-1].ID, 10)
	}

	return UsageLogPage{
		Entries:    entries,
		Count:      len(entries),
		HasMore:    hasMore,
		NextCursor: nextCursor,
	}, nil
}

// UsageLogSum holds aggregated usage totals for a date range.
type UsageLogSum struct {
	TotalCostUSD                 float64 `json:"total_cost_usd"`
	TotalRequests                int64   `json:"total_requests"`
	TotalInputTokens             int64   `json:"total_input_tokens"`
	TotalOutputTokens            int64   `json:"total_output_tokens"`
	TotalCacheCreationInputTokens int64  `json:"total_cache_creation_input_tokens"`
	TotalCacheReadInputTokens    int64   `json:"total_cache_read_input_tokens"`
}

// GetUsageLogSum returns aggregated totals for usage log entries in a date range.
func (u *UsageStore) GetUsageLogSum(orgID string, fromMs, toMs int64) (UsageLogSum, error) {
	if u == nil {
		return UsageLogSum{}, nil
	}
	db, err := u.getDB(orgID)
	if err != nil {
		return UsageLogSum{}, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	var s UsageLogSum
	err = db.QueryRowContext(ctx, `
		SELECT COALESCE(SUM(cost_usd), 0),
		       COUNT(*),
		       COALESCE(SUM(input_tokens), 0),
		       COALESCE(SUM(output_tokens), 0),
		       COALESCE(SUM(cache_creation_input_tokens), 0),
		       COALESCE(SUM(cache_read_input_tokens), 0)
		FROM usage_log
		WHERE created_at_ms >= ? AND created_at_ms < ?`,
		fromMs, toMs,
	).Scan(
		&s.TotalCostUSD, &s.TotalRequests,
		&s.TotalInputTokens, &s.TotalOutputTokens,
		&s.TotalCacheCreationInputTokens, &s.TotalCacheReadInputTokens,
	)
	if err != nil {
		return UsageLogSum{}, fmt.Errorf("query usage_log sum: %w", err)
	}
	return s, nil
}
