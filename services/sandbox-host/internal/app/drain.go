package app

import (
	"log"
	"net/http"
	"strings"
)

func (s *Server) BeginDrain(reason string) {
	if s.draining.CompareAndSwap(false, true) {
		log.Printf("[SandboxHost] drain started reason=%s", strings.TrimSpace(reason))
	}
}

func (s *Server) EndDrain(reason string) {
	if s.draining.CompareAndSwap(true, false) {
		log.Printf("[SandboxHost] drain ended reason=%s", strings.TrimSpace(reason))
	}
}

func (s *Server) IsDraining() bool {
	return s.draining.Load()
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
		"activePiTurns": 0,
	})
}
