package state

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	db *sql.DB
}

type ContainerRecord struct {
	Name              string
	ContainerID       string
	HostPort          int
	ContainerIP       string
	Status            string
	CreatedAt         time.Time
	LastAccessedAt    time.Time
	ActiveWebSockets  int
	InFlightProxyReqs int
	OrgID             string
	WorkspaceID       string
}

type ProxyThreadRecord struct {
	Key           string
	ContainerName string
	OrgID         string
	WorkspaceID   string
	ThreadID      string
	WorkerBaseURL string
	CreatedAt     time.Time
	LastSeenAt    time.Time
	ExpiresAt     time.Time
	ClosedAt      *time.Time
}

func Open(path string) (*Store, error) {
	if path == "" {
		return nil, errors.New("state DB path is required")
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("create state DB dir: %w", err)
	}

	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetConnMaxIdleTime(2 * time.Minute)
	db.SetConnMaxLifetime(30 * time.Minute)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}

	store := &Store{db: db}
	if err := store.initSchema(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}

	return store, nil
}

func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *Store) initSchema(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS containers (
			name TEXT PRIMARY KEY,
			container_id TEXT NOT NULL,
			host_port INTEGER NOT NULL,
			container_ip TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL,
			created_at_ms INTEGER NOT NULL,
			last_accessed_at_ms INTEGER NOT NULL,
			active_websockets INTEGER NOT NULL,
			in_flight_proxy_reqs INTEGER NOT NULL,
			org_id TEXT NOT NULL DEFAULT '',
			workspace_id TEXT NOT NULL DEFAULT '',
			updated_at_ms INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS proxy_threads (
			key TEXT PRIMARY KEY,
			container_name TEXT NOT NULL,
			org_id TEXT NOT NULL,
			workspace_id TEXT NOT NULL,
			thread_id TEXT NOT NULL,
			worker_base_url TEXT NOT NULL,
			created_at_ms INTEGER NOT NULL,
			last_seen_at_ms INTEGER NOT NULL,
			expires_at_ms INTEGER NOT NULL,
			closed_at_ms INTEGER,
			updated_at_ms INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_proxy_threads_expires_at ON proxy_threads(expires_at_ms)`,
	}

	for _, statement := range statements {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("init schema: %w", err)
		}
	}
	return nil
}

func (s *Store) UpsertContainer(record ContainerRecord) error {
	if s == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	_, err := s.db.ExecContext(ctx, `
		INSERT INTO containers (
			name, container_id, host_port, container_ip, status,
			created_at_ms, last_accessed_at_ms, active_websockets,
			in_flight_proxy_reqs, org_id, workspace_id, updated_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(name) DO UPDATE SET
			container_id=excluded.container_id,
			host_port=excluded.host_port,
			container_ip=excluded.container_ip,
			status=excluded.status,
			created_at_ms=excluded.created_at_ms,
			last_accessed_at_ms=excluded.last_accessed_at_ms,
			active_websockets=excluded.active_websockets,
			in_flight_proxy_reqs=excluded.in_flight_proxy_reqs,
			org_id=excluded.org_id,
			workspace_id=excluded.workspace_id,
			updated_at_ms=excluded.updated_at_ms
	`,
		record.Name,
		record.ContainerID,
		record.HostPort,
		record.ContainerIP,
		record.Status,
		record.CreatedAt.UnixMilli(),
		record.LastAccessedAt.UnixMilli(),
		record.ActiveWebSockets,
		record.InFlightProxyReqs,
		record.OrgID,
		record.WorkspaceID,
		time.Now().UTC().UnixMilli(),
	)
	return err
}

func (s *Store) DeleteContainer(name string) error {
	if s == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err := s.db.ExecContext(ctx, `DELETE FROM containers WHERE name = ?`, name)
	return err
}

func (s *Store) LoadContainers() ([]ContainerRecord, error) {
	if s == nil {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	rows, err := s.db.QueryContext(ctx, `
		SELECT
			name, container_id, host_port, container_ip, status,
			created_at_ms, last_accessed_at_ms, active_websockets,
			in_flight_proxy_reqs, org_id, workspace_id
		FROM containers
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]ContainerRecord, 0)
	for rows.Next() {
		var r ContainerRecord
		var createdAtMs, lastAccessedAtMs int64
		if err := rows.Scan(
			&r.Name,
			&r.ContainerID,
			&r.HostPort,
			&r.ContainerIP,
			&r.Status,
			&createdAtMs,
			&lastAccessedAtMs,
			&r.ActiveWebSockets,
			&r.InFlightProxyReqs,
			&r.OrgID,
			&r.WorkspaceID,
		); err != nil {
			return nil, err
		}
		r.CreatedAt = time.UnixMilli(createdAtMs).UTC()
		r.LastAccessedAt = time.UnixMilli(lastAccessedAtMs).UTC()
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Store) UpsertProxyThread(record ProxyThreadRecord) error {
	if s == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	var closedAtMs any
	if record.ClosedAt != nil {
		closedAtMs = record.ClosedAt.UnixMilli()
	}

	_, err := s.db.ExecContext(ctx, `
		INSERT INTO proxy_threads (
			key, container_name, org_id, workspace_id, thread_id, worker_base_url,
			created_at_ms, last_seen_at_ms, expires_at_ms, closed_at_ms, updated_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET
			container_name=excluded.container_name,
			org_id=excluded.org_id,
			workspace_id=excluded.workspace_id,
			thread_id=excluded.thread_id,
			worker_base_url=excluded.worker_base_url,
			created_at_ms=excluded.created_at_ms,
			last_seen_at_ms=excluded.last_seen_at_ms,
			expires_at_ms=excluded.expires_at_ms,
			closed_at_ms=excluded.closed_at_ms,
			updated_at_ms=excluded.updated_at_ms
	`,
		record.Key,
		record.ContainerName,
		record.OrgID,
		record.WorkspaceID,
		record.ThreadID,
		record.WorkerBaseURL,
		record.CreatedAt.UnixMilli(),
		record.LastSeenAt.UnixMilli(),
		record.ExpiresAt.UnixMilli(),
		closedAtMs,
		time.Now().UTC().UnixMilli(),
	)
	return err
}

func (s *Store) DeleteProxyThread(key string) error {
	if s == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err := s.db.ExecContext(ctx, `DELETE FROM proxy_threads WHERE key = ?`, key)
	return err
}

func (s *Store) LoadProxyThreads() ([]ProxyThreadRecord, error) {
	if s == nil {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	rows, err := s.db.QueryContext(ctx, `
		SELECT key, container_name, org_id, workspace_id, thread_id, worker_base_url,
		       created_at_ms, last_seen_at_ms, expires_at_ms, closed_at_ms
		FROM proxy_threads
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]ProxyThreadRecord, 0)
	for rows.Next() {
		var r ProxyThreadRecord
		var createdAtMs, lastSeenAtMs, expiresAtMs int64
		var closedAtMs sql.NullInt64
		if err := rows.Scan(
			&r.Key,
			&r.ContainerName,
			&r.OrgID,
			&r.WorkspaceID,
			&r.ThreadID,
			&r.WorkerBaseURL,
			&createdAtMs,
			&lastSeenAtMs,
			&expiresAtMs,
			&closedAtMs,
		); err != nil {
			return nil, err
		}
		r.CreatedAt = time.UnixMilli(createdAtMs).UTC()
		r.LastSeenAt = time.UnixMilli(lastSeenAtMs).UTC()
		r.ExpiresAt = time.UnixMilli(expiresAtMs).UTC()
		if closedAtMs.Valid {
			closed := time.UnixMilli(closedAtMs.Int64).UTC()
			r.ClosedAt = &closed
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
