package state

import (
	"testing"
	"time"
)

func TestRecordUsageAndGetOrgSpend(t *testing.T) {
	store, err := NewUsageStore(t.TempDir())
	if err != nil {
		t.Fatalf("open usage store: %v", err)
	}
	defer func() { _ = store.Close() }()

	// No spend yet.
	spend, err := store.GetOrgSpend("org-1")
	if err != nil {
		t.Fatalf("get org spend: %v", err)
	}
	if spend.TotalCostUSD != 0 || spend.TotalRequests != 0 {
		t.Fatalf("expected zero spend, got %+v", spend)
	}

	// Record first usage.
	if err := store.RecordUsage(UsageRecord{
		OrgID: "org-1", WorkspaceID: "ws-1", UserID: "user-1",
		Model: "claude-sonnet-4-5-20250929", Provider: "custom-bedrock-provider",
		InputTokens: 1000, OutputTokens: 500,
		CacheCreationInputTokens: 200, CacheReadInputTokens: 100,
		CostUSD: 0.012, DurationMs: 1500,
	}); err != nil {
		t.Fatalf("record usage: %v", err)
	}

	spend, _ = store.GetOrgSpend("org-1")
	if spend.TotalRequests != 1 {
		t.Fatalf("expected 1 request, got %d", spend.TotalRequests)
	}
	if spend.TotalCostUSD != 0.012 {
		t.Fatalf("expected 0.012, got %f", spend.TotalCostUSD)
	}

	// Second usage accumulates.
	if err := store.RecordUsage(UsageRecord{
		OrgID: "org-1", WorkspaceID: "ws-1", UserID: "user-2",
		Model: "claude-sonnet-4-5-20250929", Provider: "anthropic",
		InputTokens: 2000, OutputTokens: 1000,
		CostUSD: 0.025, DurationMs: 2000,
	}); err != nil {
		t.Fatalf("record second usage: %v", err)
	}

	spend, _ = store.GetOrgSpend("org-1")
	if spend.TotalRequests != 2 {
		t.Fatalf("expected 2 requests, got %d", spend.TotalRequests)
	}
	if diff := spend.TotalCostUSD - 0.037; diff > 0.0001 || diff < -0.0001 {
		t.Fatalf("expected ~0.037, got %f", spend.TotalCostUSD)
	}
}

func TestOrgIsolation(t *testing.T) {
	store, err := NewUsageStore(t.TempDir())
	if err != nil {
		t.Fatalf("open usage store: %v", err)
	}
	defer func() { _ = store.Close() }()

	_ = store.RecordUsage(UsageRecord{
		OrgID: "org-a", Model: "claude-sonnet-4-5-20250929",
		InputTokens: 1000, OutputTokens: 500, CostUSD: 0.01,
	})
	_ = store.RecordUsage(UsageRecord{
		OrgID: "org-b", Model: "claude-opus-4-6",
		InputTokens: 5000, OutputTokens: 2000, CostUSD: 0.50,
	})

	spendA, _ := store.GetOrgSpend("org-a")
	spendB, _ := store.GetOrgSpend("org-b")

	if spendA.TotalCostUSD != 0.01 {
		t.Errorf("org-a expected 0.01, got %f", spendA.TotalCostUSD)
	}
	if spendB.TotalCostUSD != 0.50 {
		t.Errorf("org-b expected 0.50, got %f", spendB.TotalCostUSD)
	}
}

func TestCheckSpendLimitsDefault(t *testing.T) {
	store, err := NewUsageStore(t.TempDir())
	if err != nil {
		t.Fatalf("open usage store: %v", err)
	}
	defer func() { _ = store.Close() }()

	// No usage — nothing exceeded.
	exc, windows, err := store.CheckSpendLimits("org-1")
	if err != nil {
		t.Fatalf("check spend limits: %v", err)
	}
	if exc != nil {
		t.Fatalf("expected no exceeded window, got %+v", exc)
	}
	if len(windows) != len(DefaultSpendLimits) {
		t.Fatalf("expected %d windows, got %d", len(DefaultSpendLimits), len(windows))
	}
	for _, w := range windows {
		if w.SpentUSD != 0 {
			t.Errorf("expected 0 spent in window %s, got %f", w.Label, w.SpentUSD)
		}
	}

	// Add $51 of usage — should exceed the 5h/$50 window.
	if err := store.RecordUsage(UsageRecord{
		OrgID: "org-1", Model: "claude-opus-4-6",
		InputTokens: 100000, OutputTokens: 50000, CostUSD: 51.0,
	}); err != nil {
		t.Fatalf("record usage: %v", err)
	}

	exc, windows, err = store.CheckSpendLimits("org-1")
	if err != nil {
		t.Fatalf("check spend limits: %v", err)
	}
	if exc == nil {
		t.Fatal("expected exceeded window")
	}
	if exc.Label != "5h" {
		t.Errorf("expected 5h window exceeded, got %s", exc.Label)
	}
	if exc.SpentUSD != 51.0 {
		t.Errorf("expected $51 spent, got %f", exc.SpentUSD)
	}

	// The 7d window should also show $51 spent but not be exceeded (limit $200).
	var weeklyWindow *WindowSpend
	for i := range windows {
		if windows[i].Label == "7d" {
			weeklyWindow = &windows[i]
		}
	}
	if weeklyWindow == nil {
		t.Fatal("expected 7d window in results")
	}
	if weeklyWindow.Exceeded {
		t.Error("7d window should not be exceeded at $51")
	}
	if weeklyWindow.SpentUSD != 51.0 {
		t.Errorf("expected $51 in 7d window, got %f", weeklyWindow.SpentUSD)
	}
}

func TestCustomSpendLimits(t *testing.T) {
	store, err := NewUsageStore(t.TempDir())
	if err != nil {
		t.Fatalf("open usage store: %v", err)
	}
	defer func() { _ = store.Close() }()

	// Set custom limits: $10/1h, $500/30d.
	custom := []SpendLimit{
		{Window: 1 * time.Hour, LimitUSD: 10, Label: "1h"},
		{Window: 30 * 24 * time.Hour, LimitUSD: 500, Label: "30d"},
	}
	if err := store.SetSpendLimits("org-1", custom); err != nil {
		t.Fatalf("set spend limits: %v", err)
	}

	// Verify custom limits are returned.
	limits, err := store.GetSpendLimits("org-1")
	if err != nil {
		t.Fatalf("get spend limits: %v", err)
	}
	if len(limits) != 2 {
		t.Fatalf("expected 2 custom limits, got %d", len(limits))
	}
	if limits[0].LimitUSD != 10 || limits[0].Label != "1h" {
		t.Errorf("unexpected first limit: %+v", limits[0])
	}
	if limits[1].LimitUSD != 500 || limits[1].Label != "30d" {
		t.Errorf("unexpected second limit: %+v", limits[1])
	}

	// Add $11 — should exceed the 1h/$10 custom window.
	_ = store.RecordUsage(UsageRecord{
		OrgID: "org-1", Model: "claude-opus-4-6",
		InputTokens: 50000, OutputTokens: 25000, CostUSD: 11.0,
	})

	exc, _, _ := store.CheckSpendLimits("org-1")
	if exc == nil || exc.Label != "1h" {
		t.Fatalf("expected 1h window exceeded, got %+v", exc)
	}

	// Clear custom limits — should revert to defaults.
	if err := store.SetSpendLimits("org-1", nil); err != nil {
		t.Fatalf("clear spend limits: %v", err)
	}
	limits, _ = store.GetSpendLimits("org-1")
	if len(limits) != len(DefaultSpendLimits) {
		t.Fatalf("expected defaults after clear, got %d limits", len(limits))
	}

	// $11 is under the default 5h/$50 limit.
	exc, _, _ = store.CheckSpendLimits("org-1")
	if exc != nil {
		t.Fatalf("expected no exceeded window with default limits, got %+v", exc)
	}
}

func TestGetUsageLog(t *testing.T) {
	store, err := NewUsageStore(t.TempDir())
	if err != nil {
		t.Fatalf("open usage store: %v", err)
	}
	defer func() { _ = store.Close() }()

	for i := 0; i < 5; i++ {
		_ = store.RecordUsage(UsageRecord{
			OrgID: "org-1", Model: "claude-sonnet-4-5-20250929",
			InputTokens: 100, OutputTokens: 50, CostUSD: 0.001,
		})
	}

	entries, err := store.GetUsageLog("org-1", 3)
	if err != nil {
		t.Fatalf("get usage log: %v", err)
	}
	if len(entries) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(entries))
	}
	// Should be newest first.
	if entries[0].ID < entries[1].ID {
		t.Error("expected newest first ordering")
	}
}
