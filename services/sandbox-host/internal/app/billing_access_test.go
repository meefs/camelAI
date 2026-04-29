package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestCheckOrgBillingAccessAllowsFreeBYOKOnly(t *testing.T) {
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/api/internal/billing/access" {
			t.Fatalf("unexpected path %s", req.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(BillingAccessSnapshot{
			OrgID:         "org-free",
			BillingStatus: "inactive",
		})
	}))
	defer worker.Close()

	server := NewServer(Config{
		WorkerBaseURL:              worker.URL,
		SandboxProxySecret:         "secret",
		ProxyThreadCleanupInterval: time.Hour,
	}, nil, nil, nil, nil, nil)
	threadContext := &ProxyThreadContext{
		OrgID:       "org-free",
		WorkspaceID: "ws-free",
		ThreadID:    "thread-free",
	}

	byokDecision := server.checkOrgBillingAccess(threadContext, billingSourceBYOK, "")
	if byokDecision.Denied {
		t.Fatalf("expected BYOK to be allowed on free plan: %+v", byokDecision)
	}
	if byokDecision.CreditChargeable {
		t.Fatal("BYOK usage should not be credit-chargeable")
	}

	hostedDecision := server.checkOrgBillingAccess(threadContext, billingSourceHosted, "claude-sonnet-4-6")
	if !hostedDecision.Denied {
		t.Fatal("expected hosted usage to be denied on free plan")
	}
	if hostedDecision.StatusCode != http.StatusPaymentRequired {
		t.Fatalf("expected payment required, got %d", hostedDecision.StatusCode)
	}
}
