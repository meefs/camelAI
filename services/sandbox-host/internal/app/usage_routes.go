package app

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/chiridion/sandbox-host/internal/state"
)

// Usage API routes (control port only):
//
//   GET  /v1/usage/orgs/{orgId}/spend   — lifetime totals + rolling window status
//   GET  /v1/usage/orgs/{orgId}/limits  — effective spend limits
//   PUT  /v1/usage/orgs/{orgId}/limits  — set per-org limit overrides (or clear)
//   GET  /v1/usage/orgs/{orgId}/log     — recent usage log entries

var usageOrgRouteRegex = regexp.MustCompile(`^/v1/usage/orgs/([^/]+)(/[^/]*)?$`)

func (s *Server) handleUsageRoute(w http.ResponseWriter, req *http.Request) {
	match := usageOrgRouteRegex.FindStringSubmatch(req.URL.Path)
	if match == nil {
		errorJSON(w, "Not found", http.StatusNotFound)
		return
	}

	orgID := match[1]
	action := strings.TrimPrefix(match[2], "/")

	switch {
	case action == "spend" && req.Method == http.MethodGet:
		s.handleGetOrgSpend(w, orgID)
	case action == "limits" && req.Method == http.MethodGet:
		s.handleGetOrgLimits(w, orgID)
	case action == "limits" && req.Method == http.MethodPut:
		s.handleSetOrgLimits(w, req, orgID)
	case action == "log" && req.Method == http.MethodGet:
		s.handleGetOrgUsageLog(w, req, orgID)
	default:
		errorJSON(w, "Not found", http.StatusNotFound)
	}
}

func (s *Server) handleGetOrgSpend(w http.ResponseWriter, orgID string) {
	spend, err := s.usage.GetOrgSpend(orgID)
	if err != nil {
		errorJSON(w, "Failed to read org spend", http.StatusInternalServerError)
		return
	}

	_, windows, err := s.usage.CheckSpendLimits(orgID)
	if err != nil {
		errorJSON(w, "Failed to check spend limits", http.StatusInternalServerError)
		return
	}

	if windows == nil {
		windows = []state.WindowSpend{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"org_id":         orgID,
		"total_cost_usd": spend.TotalCostUSD,
		"total_requests": spend.TotalRequests,
		"windows":        windows,
	})
}

func (s *Server) handleGetOrgLimits(w http.ResponseWriter, orgID string) {
	limits, err := s.usage.GetSpendLimits(orgID)
	if err != nil {
		errorJSON(w, "Failed to read org limits", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"org_id": orgID,
		"limits": limits,
	})
}

type setLimitsRequest struct {
	Limits []struct {
		WindowHours float64 `json:"window_hours"`
		LimitUSD    float64 `json:"limit_usd"`
		Label       string  `json:"label"`
	} `json:"limits"`
}

func (s *Server) handleSetOrgLimits(w http.ResponseWriter, req *http.Request, orgID string) {
	var body setLimitsRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		errorJSON(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}

	// Empty limits array = revert to defaults.
	var limits []state.SpendLimit
	for _, l := range body.Limits {
		if l.WindowHours <= 0 || l.LimitUSD <= 0 {
			errorJSON(w, "Each limit must have window_hours > 0 and limit_usd > 0", http.StatusBadRequest)
			return
		}
		label := l.Label
		if label == "" {
			label = formatWindowLabel(l.WindowHours)
		}
		limits = append(limits, state.SpendLimit{
			Window:   time.Duration(l.WindowHours * float64(time.Hour)),
			LimitUSD: l.LimitUSD,
			Label:    label,
		})
	}

	if err := s.usage.SetSpendLimits(orgID, limits); err != nil {
		errorJSON(w, "Failed to set org limits", http.StatusInternalServerError)
		return
	}

	// Return the effective limits (may be defaults if cleared).
	effective, _ := s.usage.GetSpendLimits(orgID)
	writeJSON(w, http.StatusOK, map[string]any{
		"org_id": orgID,
		"limits": effective,
	})
}

func (s *Server) handleGetOrgUsageLog(w http.ResponseWriter, req *http.Request, orgID string) {
	limit := 50
	if l := req.URL.Query().Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 && parsed <= 500 {
			limit = parsed
		}
	}

	entries, err := s.usage.GetUsageLog(orgID, limit)
	if err != nil {
		errorJSON(w, "Failed to read usage log", http.StatusInternalServerError)
		return
	}
	if entries == nil {
		entries = []state.UsageLogEntry{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"org_id":  orgID,
		"entries": entries,
		"count":   len(entries),
	})
}

func formatWindowLabel(hours float64) string {
	if hours >= 24 && int(hours)%24 == 0 {
		return strconv.Itoa(int(hours/24)) + "d"
	}
	if hours == float64(int(hours)) {
		return strconv.Itoa(int(hours)) + "h"
	}
	return strconv.FormatFloat(hours, 'f', 1, 64) + "h"
}
