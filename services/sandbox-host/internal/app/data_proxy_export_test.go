package app

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

func openExportTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "export.db"))
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Exec(`CREATE TABLE t (id INTEGER, name TEXT, amount REAL)`); err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO t (id, name, amount) VALUES (1,'a',1.5),(2,'b',2.5),(3,'c',3.5)`); err != nil {
		t.Fatalf("insert: %v", err)
	}
	return db
}

func TestStreamSQLExportNDJSON(t *testing.T) {
	db := openExportTestDB(t)
	rec := httptest.NewRecorder()

	started, err := streamSQLExportNDJSON(
		context.Background(), db, rec,
		`SELECT id, name FROM t ORDER BY id`, nil, 10*time.Second,
	)
	if err != nil {
		t.Fatalf("export err: %v", err)
	}
	if !started {
		t.Fatalf("expected started=true for a successful non-empty export")
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/x-ndjson" {
		t.Fatalf("content-type = %q, want application/x-ndjson", ct)
	}

	var names []string
	sc := bufio.NewScanner(strings.NewReader(rec.Body.String()))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var row map[string]any
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			t.Fatalf("row is not valid JSON: %q: %v", line, err)
		}
		name, ok := row["name"].(string)
		if !ok {
			t.Fatalf("row missing string 'name': %v", row)
		}
		names = append(names, name)
	}
	if got := strings.Join(names, ","); got != "a,b,c" {
		t.Fatalf("streamed rows = %q, want a,b,c", got)
	}
}

func TestStreamSQLExportNDJSONEmptyResult(t *testing.T) {
	db := openExportTestDB(t)
	rec := httptest.NewRecorder()

	started, err := streamSQLExportNDJSON(
		context.Background(), db, rec,
		`SELECT id FROM t WHERE id < 0`, nil, 10*time.Second,
	)
	if err != nil {
		t.Fatalf("export err: %v", err)
	}
	if started {
		t.Fatalf("expected started=false for an empty result (nothing written)")
	}
	if body := strings.TrimSpace(rec.Body.String()); body != "" {
		t.Fatalf("expected empty body, got %q", body)
	}
}

func TestDataProxyExportRouting(t *testing.T) {
	handler := NewDataProxyHandler(DefaultDataProxyHandlerConfig())

	// Each /export path must dispatch to its export handler. Invalid JSON proves
	// we reached the handler (400) rather than the router rejecting the path
	// (404) or the method (405).
	for _, path := range []string{
		"/data-proxy/mysql/export",
		"/data-proxy/postgres/export",
		"/data-proxy/mssql/export",
	} {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader("{"))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("POST %s: got %d, want 400 (route should reach the export handler)", path, rec.Code)
		}
	}

	// A GET to an export path is not allowed.
	req := httptest.NewRequest(http.MethodGet, "/data-proxy/mysql/export", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET export path: got %d, want 405", rec.Code)
	}
}

func TestStreamSQLExportNDJSONBadQueryNotStarted(t *testing.T) {
	db := openExportTestDB(t)
	rec := httptest.NewRecorder()

	started, err := streamSQLExportNDJSON(
		context.Background(), db, rec,
		`SELECT * FROM does_not_exist`, nil, 10*time.Second,
	)
	if err == nil {
		t.Fatalf("expected an error for a bad query")
	}
	// started must be false so the caller can still emit a structured error
	// response (headers not yet sent).
	if started {
		t.Fatalf("expected started=false on a pre-stream failure")
	}
}
