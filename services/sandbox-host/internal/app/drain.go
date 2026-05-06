package app

import (
	"context"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const defaultDrainWaitTimeout = 30 * time.Minute

func (s *Server) BeginDrain(reason string) {
	if s.draining.CompareAndSwap(false, true) {
		log.Printf("[SandboxHost] drain started reason=%s activePiTurns=%d", strings.TrimSpace(reason), s.ActiveHostPiTurnCount())
	}
}

func (s *Server) EndDrain(reason string) {
	if s.draining.CompareAndSwap(true, false) {
		log.Printf("[SandboxHost] drain ended reason=%s activePiTurns=%d", strings.TrimSpace(reason), s.ActiveHostPiTurnCount())
	}
}

func (s *Server) IsDraining() bool {
	return s.draining.Load()
}

func (s *Server) ActiveHostPiTurnCount() int {
	s.hostPiMu.Lock()
	bridges := make([]*hostPiBridge, 0, len(s.hostPiChats))
	for _, bridge := range s.hostPiChats {
		if bridge != nil {
			bridges = append(bridges, bridge)
		}
	}
	s.hostPiMu.Unlock()

	active := 0
	for _, bridge := range bridges {
		if bridge.isActive() {
			active++
		}
	}
	return active
}

func (s *Server) WaitForHostPiIdle(ctx context.Context, interval time.Duration) error {
	if interval <= 0 {
		interval = 500 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		if s.ActiveHostPiTurnCount() == 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (s *Server) StopHostPiBridges() {
	s.hostPiMu.Lock()
	bridges := make([]*hostPiBridge, 0, len(s.hostPiChats))
	for _, bridge := range s.hostPiChats {
		if bridge != nil {
			bridges = append(bridges, bridge)
		}
	}
	s.hostPiChats = make(map[string]*hostPiBridge)
	s.hostPiMu.Unlock()

	for _, bridge := range bridges {
		if bridge.cancel != nil {
			bridge.cancel()
		}
		bridge.stopProcess()
	}
}

func (s *Server) handleDrainRoute(w http.ResponseWriter, req *http.Request, sourceIP string) {
	if !isLoopbackSourceIP(sourceIP) {
		errorJSON(w, "Drain endpoint is loopback only", http.StatusForbidden)
		return
	}

	switch req.Method {
	case http.MethodGet:
		s.writeDrainStatus(w, http.StatusOK)
	case http.MethodPost:
		s.BeginDrain("admin_endpoint")
		if shouldWaitForDrain(req) {
			timeout := drainWaitTimeout(req)
			ctx, cancel := context.WithTimeout(req.Context(), timeout)
			err := s.WaitForHostPiIdle(ctx, 500*time.Millisecond)
			cancel()
			if err != nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]any{
					"draining":      s.IsDraining(),
					"activePiTurns": s.ActiveHostPiTurnCount(),
					"error":         err.Error(),
				})
				return
			}
		}
		s.writeDrainStatus(w, http.StatusOK)
	case http.MethodDelete:
		s.EndDrain("admin_endpoint")
		s.writeDrainStatus(w, http.StatusOK)
	default:
		errorJSON(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) writeDrainStatus(w http.ResponseWriter, status int) {
	writeJSON(w, status, map[string]any{
		"draining":      s.IsDraining(),
		"activePiTurns": s.ActiveHostPiTurnCount(),
	})
}

func shouldWaitForDrain(req *http.Request) bool {
	value := strings.TrimSpace(strings.ToLower(req.URL.Query().Get("wait")))
	return value == "1" || value == "true" || value == "yes"
}

func drainWaitTimeout(req *http.Request) time.Duration {
	raw := strings.TrimSpace(req.URL.Query().Get("timeout"))
	if raw == "" {
		return defaultDrainWaitTimeout
	}
	seconds, err := strconv.Atoi(raw)
	if err != nil || seconds <= 0 {
		return defaultDrainWaitTimeout
	}
	return time.Duration(seconds) * time.Second
}
