package state

import (
	"context"
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

func TestGetUsageLogPaginated(t *testing.T) {
	store, err := NewUsageStore(t.TempDir())
	if err != nil {
		t.Fatalf("open usage store: %v", err)
	}
	defer func() { _ = store.Close() }()

	// Insert 5 entries.
	for i := 0; i < 5; i++ {
		_ = store.RecordUsage(UsageRecord{
			OrgID: "org-1", Model: "claude-sonnet-4-5-20250929",
			InputTokens: 100, OutputTokens: 50, CostUSD: 0.001,
		})
	}

	// First page of 2.
	page1, err := store.GetUsageLogPaginated("org-1", UsageLogQuery{Limit: 2})
	if err != nil {
		t.Fatalf("get paginated log page 1: %v", err)
	}
	if page1.Count != 2 {
		t.Fatalf("expected 2 entries, got %d", page1.Count)
	}
	if !page1.HasMore {
		t.Fatal("expected has_more=true")
	}
	if page1.NextCursor == "" {
		t.Fatal("expected non-empty next_cursor")
	}

	// Second page using cursor.
	var cursor int64
	for _, e := range page1.Entries {
		cursor = e.ID
	}
	page2, err := store.GetUsageLogPaginated("org-1", UsageLogQuery{Limit: 2, Cursor: cursor})
	if err != nil {
		t.Fatalf("get paginated log page 2: %v", err)
	}
	if page2.Count != 2 {
		t.Fatalf("expected 2 entries on page 2, got %d", page2.Count)
	}
	if !page2.HasMore {
		t.Fatal("expected has_more=true on page 2")
	}

	// Entries on page 2 should have lower IDs than page 1's last entry.
	if page2.Entries[0].ID >= cursor {
		t.Errorf("page 2 first entry id %d should be < cursor %d", page2.Entries[0].ID, cursor)
	}

	// Third page — only 1 left.
	var cursor2 int64
	for _, e := range page2.Entries {
		cursor2 = e.ID
	}
	page3, err := store.GetUsageLogPaginated("org-1", UsageLogQuery{Limit: 2, Cursor: cursor2})
	if err != nil {
		t.Fatalf("get paginated log page 3: %v", err)
	}
	if page3.Count != 1 {
		t.Fatalf("expected 1 entry on page 3, got %d", page3.Count)
	}
	if page3.HasMore {
		t.Fatal("expected has_more=false on last page")
	}
	if page3.NextCursor != "" {
		t.Fatalf("expected empty next_cursor on last page, got %s", page3.NextCursor)
	}
}

func TestGetUsageLogPaginatedDateFilter(t *testing.T) {
	store, err := NewUsageStore(t.TempDir())
	if err != nil {
		t.Fatalf("open usage store: %v", err)
	}
	defer func() { _ = store.Close() }()

	// Insert entries — they all get now() timestamps, so we use a wide range.
	for i := 0; i < 3; i++ {
		_ = store.RecordUsage(UsageRecord{
			OrgID: "org-1", Model: "claude-sonnet-4-5-20250929",
			InputTokens: 100, OutputTokens: 50, CostUSD: 0.01,
		})
	}

	now := time.Now().UTC().UnixMilli()

	// from=0 to=now+1000 should include all entries.
	page, err := store.GetUsageLogPaginated("org-1", UsageLogQuery{
		Limit:  100,
		FromMs: 0,
		ToMs:   now + 1000,
	})
	if err != nil {
		t.Fatalf("get filtered log: %v", err)
	}
	if page.Count != 3 {
		t.Fatalf("expected 3 entries in wide range, got %d", page.Count)
	}

	// from=now+1000 to=now+2000 should be empty (future range).
	page, err = store.GetUsageLogPaginated("org-1", UsageLogQuery{
		Limit:  100,
		FromMs: now + 1000,
		ToMs:   now + 2000,
	})
	if err != nil {
		t.Fatalf("get filtered log (future): %v", err)
	}
	if page.Count != 0 {
		t.Fatalf("expected 0 entries in future range, got %d", page.Count)
	}
}

func TestGetUsageLogSum(t *testing.T) {
	store, err := NewUsageStore(t.TempDir())
	if err != nil {
		t.Fatalf("open usage store: %v", err)
	}
	defer func() { _ = store.Close() }()

	_ = store.RecordUsage(UsageRecord{
		OrgID: "org-1", Model: "claude-sonnet-4-5-20250929",
		InputTokens: 1000, OutputTokens: 500,
		CacheCreationInputTokens: 200, CacheReadInputTokens: 100,
		CostUSD: 0.012,
	})
	_ = store.RecordUsage(UsageRecord{
		OrgID: "org-1", Model: "claude-opus-4-6",
		InputTokens: 2000, OutputTokens: 1000,
		CacheCreationInputTokens: 300, CacheReadInputTokens: 150,
		CostUSD: 0.025,
	})

	now := time.Now().UTC().UnixMilli()

	// Wide range — both entries.
	sum, err := store.GetUsageLogSum("org-1", 0, now+1000)
	if err != nil {
		t.Fatalf("get usage sum: %v", err)
	}
	if sum.TotalRequests != 2 {
		t.Fatalf("expected 2 requests, got %d", sum.TotalRequests)
	}
	expectedCost := 0.037
	if diff := sum.TotalCostUSD - expectedCost; diff > 0.0001 || diff < -0.0001 {
		t.Fatalf("expected ~%.3f cost, got %f", expectedCost, sum.TotalCostUSD)
	}
	if sum.TotalInputTokens != 3000 {
		t.Fatalf("expected 3000 input tokens, got %d", sum.TotalInputTokens)
	}
	if sum.TotalOutputTokens != 1500 {
		t.Fatalf("expected 1500 output tokens, got %d", sum.TotalOutputTokens)
	}
	if sum.TotalCacheCreationInputTokens != 500 {
		t.Fatalf("expected 500 cache creation tokens, got %d", sum.TotalCacheCreationInputTokens)
	}
	if sum.TotalCacheReadInputTokens != 250 {
		t.Fatalf("expected 250 cache read tokens, got %d", sum.TotalCacheReadInputTokens)
	}

	// Future range — empty.
	sum, err = store.GetUsageLogSum("org-1", now+1000, now+2000)
	if err != nil {
		t.Fatalf("get usage sum (future): %v", err)
	}
	if sum.TotalRequests != 0 || sum.TotalCostUSD != 0 {
		t.Fatalf("expected zero sum in future range, got %+v", sum)
	}
}

func TestGetUsageLogSumNilStore(t *testing.T) {
	var store *UsageStore
	sum, err := store.GetUsageLogSum("org-1", 0, 9999999999999)
	if err != nil {
		t.Fatalf("nil store should not error: %v", err)
	}
	if sum.TotalRequests != 0 {
		t.Fatalf("expected zero sum from nil store")
	}
}

func TestGetOrgUsageAnalytics(t *testing.T) {
	store, err := NewUsageStore(t.TempDir())
	if err != nil {
		t.Fatalf("open usage store: %v", err)
	}
	defer func() { _ = store.Close() }()

	if err := store.RecordUsage(UsageRecord{
		OrgID: "org-a", Model: "claude-sonnet-4-5-20250929",
		InputTokens: 100, OutputTokens: 50, CostUSD: 3,
	}); err != nil {
		t.Fatalf("record usage org-a #1: %v", err)
	}
	if err := store.RecordUsage(UsageRecord{
		OrgID: "org-a", Model: "claude-sonnet-4-5-20250929",
		InputTokens: 200, OutputTokens: 100, CostUSD: 7,
	}); err != nil {
		t.Fatalf("record usage org-a #2: %v", err)
	}
	if err := store.RecordUsage(UsageRecord{
		OrgID: "org-b", Model: "claude-opus-4-6",
		InputTokens: 300, OutputTokens: 150, CostUSD: 2,
	}); err != nil {
		t.Fatalf("record usage org-b: %v", err)
	}

	rows, err := store.GetOrgUsageAnalytics([]string{"org-a", "org-c"}, true)
	if err != nil {
		t.Fatalf("get org usage analytics: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("expected 2 analytics rows, got %d", len(rows))
	}

	if rows[0].OrgID != "org-a" {
		t.Fatalf("expected first row for org-a, got %s", rows[0].OrgID)
	}
	if rows[0].TotalRequests != 2 {
		t.Fatalf("expected org-a total_requests=2, got %d", rows[0].TotalRequests)
	}
	if rows[0].TotalCostUSD != 10 {
		t.Fatalf("expected org-a total_cost_usd=10, got %f", rows[0].TotalCostUSD)
	}
	if rows[0].Spend7d != 10 || rows[0].Spend30d != 10 {
		t.Fatalf("expected org-a rolling spend totals of 10, got %+v", rows[0])
	}
	if len(rows[0].Windows) != len(DefaultSpendLimits) {
		t.Fatalf("expected default windows for org-a, got %d", len(rows[0].Windows))
	}

	if rows[1].OrgID != "org-c" {
		t.Fatalf("expected second row for org-c, got %s", rows[1].OrgID)
	}
	if rows[1].TotalRequests != 0 || rows[1].TotalCostUSD != 0 || rows[1].Spend7d != 0 || rows[1].Spend30d != 0 {
		t.Fatalf("expected zero analytics row for org-c, got %+v", rows[1])
	}
	if len(rows[1].Windows) != len(DefaultSpendLimits) {
		t.Fatalf("expected default windows for org-c, got %d", len(rows[1].Windows))
	}
}

func TestListSpamOrgIDs(t *testing.T) {
	store, err := NewUsageStore(t.TempDir())
	if err != nil {
		t.Fatalf("open usage store: %v", err)
	}
	defer func() { _ = store.Close() }()

	spamLimits := []SpendLimit{
		{Window: 5 * time.Hour, LimitUSD: 0.01, Label: "5h"},
		{Window: 7 * 24 * time.Hour, LimitUSD: 0.01, Label: "7d"},
	}
	notSpamLimits := []SpendLimit{
		{Window: 5 * time.Hour, LimitUSD: 0.01, Label: "5h"},
		{Window: 7 * 24 * time.Hour, LimitUSD: 1, Label: "7d"},
	}

	if err := store.SetSpendLimits("org-spam", spamLimits); err != nil {
		t.Fatalf("set spam limits: %v", err)
	}
	if err := store.SetSpendLimits("org-not-spam", notSpamLimits); err != nil {
		t.Fatalf("set non-spam limits: %v", err)
	}

	orgIDs, err := store.ListSpamOrgIDs()
	if err != nil {
		t.Fatalf("list spam org ids: %v", err)
	}
	if len(orgIDs) != 1 || orgIDs[0] != "org-spam" {
		t.Fatalf("expected only org-spam, got %v", orgIDs)
	}
}

func TestRecordUsageIgnoresAnalyticsWriteFailure(t *testing.T) {
	store, err := NewUsageStore(t.TempDir())
	if err != nil {
		t.Fatalf("open usage store: %v", err)
	}
	defer func() { _ = store.Close() }()

	if err := store.analytics.Close(); err != nil {
		t.Fatalf("close analytics db: %v", err)
	}

	if err := store.RecordUsage(UsageRecord{
		OrgID: "org-primary", Model: "claude-sonnet-4-5-20250929",
		InputTokens: 100, OutputTokens: 50, CostUSD: 1.25,
	}); err != nil {
		t.Fatalf("record usage should ignore analytics failure, got: %v", err)
	}

	spend, err := store.GetOrgSpend("org-primary")
	if err != nil {
		t.Fatalf("get org spend: %v", err)
	}
	if spend.TotalRequests != 1 || spend.TotalCostUSD != 1.25 {
		t.Fatalf("expected primary spend write to succeed, got %+v", spend)
	}
}

func TestSetSpendLimitsIgnoresAnalyticsWriteFailure(t *testing.T) {
	store, err := NewUsageStore(t.TempDir())
	if err != nil {
		t.Fatalf("open usage store: %v", err)
	}
	defer func() { _ = store.Close() }()

	if err := store.analytics.Close(); err != nil {
		t.Fatalf("close analytics db: %v", err)
	}

	custom := []SpendLimit{{Window: time.Hour, LimitUSD: 10, Label: "1h"}}
	if err := store.SetSpendLimits("org-primary", custom); err != nil {
		t.Fatalf("set spend limits should ignore analytics failure, got: %v", err)
	}

	limits, err := store.GetSpendLimits("org-primary")
	if err != nil {
		t.Fatalf("get spend limits: %v", err)
	}
	if len(limits) != 1 || limits[0].Label != "1h" || limits[0].LimitUSD != 10 {
		t.Fatalf("expected primary limit write to succeed, got %+v", limits)
	}
}

func TestNewUsageStoreSkipsAnalyticsRebuildWhenSchemaIsCurrent(t *testing.T) {
	baseDir := t.TempDir()
	store, err := NewUsageStore(baseDir)
	if err != nil {
		t.Fatalf("open usage store: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := store.analytics.ExecContext(
		ctx,
		`INSERT INTO org_usage_rollups (org_id, total_cost_usd, total_requests, updated_at_ms)
		 VALUES ('sentinel-org', 99, 7, ?)`,
		time.Now().UTC().UnixMilli(),
	); err != nil {
		t.Fatalf("insert sentinel analytics row: %v", err)
	}

	if err := store.Close(); err != nil {
		t.Fatalf("close usage store: %v", err)
	}

	reopened, err := NewUsageStore(baseDir)
	if err != nil {
		t.Fatalf("reopen usage store: %v", err)
	}
	defer func() { _ = reopened.Close() }()

	rows, err := reopened.GetOrgUsageAnalytics([]string{"sentinel-org"}, false)
	if err != nil {
		t.Fatalf("get org usage analytics after reopen: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("expected one sentinel analytics row, got %d", len(rows))
	}
	if rows[0].OrgID != "sentinel-org" || rows[0].TotalCostUSD != 99 || rows[0].TotalRequests != 7 {
		t.Fatalf("expected sentinel analytics row to persist without rebuild, got %+v", rows[0])
	}
}
