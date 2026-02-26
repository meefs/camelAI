package app

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func defaultDataProxyCfg() DataProxyHandlerConfig {
	return DefaultDataProxyHandlerConfig()
}

func TestHandleDataProxyMssqlQueryRejectsInvalidJSON(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/data-proxy/mssql/query", strings.NewReader("{"))
	rec := httptest.NewRecorder()

	if err := handleDataProxyMssqlQueryWithConfig(rec, req, defaultDataProxyCfg()); err != nil {
		t.Fatalf("handleDataProxyMssqlQueryWithConfig returned error: %v", err)
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unexpected status: got=%d want=%d", rec.Code, http.StatusBadRequest)
	}
}

func TestHandleDataProxyMssqlQueryRejectsMissingFields(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/data-proxy/mssql/query", strings.NewReader(`{"server":"db.example.com"}`))
	rec := httptest.NewRecorder()

	if err := handleDataProxyMssqlQueryWithConfig(rec, req, defaultDataProxyCfg()); err != nil {
		t.Fatalf("handleDataProxyMssqlQueryWithConfig returned error: %v", err)
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unexpected status: got=%d want=%d", rec.Code, http.StatusBadRequest)
	}
}

func TestHandleDataProxyMssqlQueryRejectsMissingMode(t *testing.T) {
	body := `{"server":"db.example.com","user":"u","password":"p","query":"select 1"}`
	req := httptest.NewRequest(http.MethodPost, "/data-proxy/mssql/query", strings.NewReader(body))
	rec := httptest.NewRecorder()

	if err := handleDataProxyMssqlQueryWithConfig(rec, req, defaultDataProxyCfg()); err != nil {
		t.Fatalf("handleDataProxyMssqlQueryWithConfig returned error: %v", err)
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unexpected status: got=%d want=%d", rec.Code, http.StatusBadRequest)
	}
}

func TestHandleDataProxyPostgresQueryRejectsInvalidJSON(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/data-proxy/postgres/query", strings.NewReader("{"))
	rec := httptest.NewRecorder()

	if err := handleDataProxyPostgresQueryWithConfig(rec, req, defaultDataProxyCfg()); err != nil {
		t.Fatalf("handleDataProxyPostgresQueryWithConfig returned error: %v", err)
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unexpected status: got=%d want=%d", rec.Code, http.StatusBadRequest)
	}
}

func TestHandleDataProxyPostgresQueryRejectsMissingFields(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/data-proxy/postgres/query", strings.NewReader(`{"host":"db.example.com"}`))
	rec := httptest.NewRecorder()

	if err := handleDataProxyPostgresQueryWithConfig(rec, req, defaultDataProxyCfg()); err != nil {
		t.Fatalf("handleDataProxyPostgresQueryWithConfig returned error: %v", err)
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unexpected status: got=%d want=%d", rec.Code, http.StatusBadRequest)
	}
}

func TestHandleDataProxyPostgresQueryRejectsServerAliasWithoutHost(t *testing.T) {
	body := `{"mode":"read","server":"db.example.com","user":"u","password":"p","query":"select 1","params":[]}`
	req := httptest.NewRequest(http.MethodPost, "/data-proxy/postgres/query", strings.NewReader(body))
	rec := httptest.NewRecorder()

	if err := handleDataProxyPostgresQueryWithConfig(rec, req, defaultDataProxyCfg()); err != nil {
		t.Fatalf("handleDataProxyPostgresQueryWithConfig returned error: %v", err)
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unexpected status: got=%d want=%d", rec.Code, http.StatusBadRequest)
	}
}

func TestHandleDataProxyPostgresQueryRejectsNonArrayParams(t *testing.T) {
	body := `{"mode":"read","host":"db.example.com","user":"u","password":"p","query":"select 1","params":{"id":1}}`
	req := httptest.NewRequest(http.MethodPost, "/data-proxy/postgres/query", strings.NewReader(body))
	rec := httptest.NewRecorder()

	if err := handleDataProxyPostgresQueryWithConfig(rec, req, defaultDataProxyCfg()); err != nil {
		t.Fatalf("handleDataProxyPostgresQueryWithConfig returned error: %v", err)
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unexpected status: got=%d want=%d", rec.Code, http.StatusBadRequest)
	}
}

func TestHandleDataProxyPostgresQueryRejectsInvalidMode(t *testing.T) {
	body := `{"mode":"auto","host":"db.example.com","user":"u","password":"p","query":"select 1","params":[]}`
	req := httptest.NewRequest(http.MethodPost, "/data-proxy/postgres/query", strings.NewReader(body))
	rec := httptest.NewRecorder()

	if err := handleDataProxyPostgresQueryWithConfig(rec, req, defaultDataProxyCfg()); err != nil {
		t.Fatalf("handleDataProxyPostgresQueryWithConfig returned error: %v", err)
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unexpected status: got=%d want=%d", rec.Code, http.StatusBadRequest)
	}
}

func TestHandleDataProxyMySQLQueryRejectsInvalidJSON(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/data-proxy/mysql/query", strings.NewReader("{"))
	rec := httptest.NewRecorder()

	if err := handleDataProxyMySQLQueryWithConfig(rec, req, defaultDataProxyCfg()); err != nil {
		t.Fatalf("handleDataProxyMySQLQueryWithConfig returned error: %v", err)
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unexpected status: got=%d want=%d", rec.Code, http.StatusBadRequest)
	}
}

func TestHandleDataProxyMySQLQueryRejectsMissingFields(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/data-proxy/mysql/query", strings.NewReader(`{"host":"db.example.com"}`))
	rec := httptest.NewRecorder()

	if err := handleDataProxyMySQLQueryWithConfig(rec, req, defaultDataProxyCfg()); err != nil {
		t.Fatalf("handleDataProxyMySQLQueryWithConfig returned error: %v", err)
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unexpected status: got=%d want=%d", rec.Code, http.StatusBadRequest)
	}
}

func TestHandleDataProxyMySQLQueryRejectsServerAliasWithoutHost(t *testing.T) {
	body := `{"mode":"read","server":"db.example.com","user":"u","password":"p","query":"select 1","params":[]}`
	req := httptest.NewRequest(http.MethodPost, "/data-proxy/mysql/query", strings.NewReader(body))
	rec := httptest.NewRecorder()

	if err := handleDataProxyMySQLQueryWithConfig(rec, req, defaultDataProxyCfg()); err != nil {
		t.Fatalf("handleDataProxyMySQLQueryWithConfig returned error: %v", err)
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unexpected status: got=%d want=%d", rec.Code, http.StatusBadRequest)
	}
}

func TestHandleDataProxyMySQLQueryRejectsNonArrayParams(t *testing.T) {
	body := `{"mode":"read","host":"db.example.com","user":"u","password":"p","query":"select 1","params":{"id":1}}`
	req := httptest.NewRequest(http.MethodPost, "/data-proxy/mysql/query", strings.NewReader(body))
	rec := httptest.NewRecorder()

	if err := handleDataProxyMySQLQueryWithConfig(rec, req, defaultDataProxyCfg()); err != nil {
		t.Fatalf("handleDataProxyMySQLQueryWithConfig returned error: %v", err)
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unexpected status: got=%d want=%d", rec.Code, http.StatusBadRequest)
	}
}
