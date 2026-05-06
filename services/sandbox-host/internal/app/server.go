package app

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/chiridion/sandbox-host/internal/container"
	"github.com/chiridion/sandbox-host/internal/fsops"
	"github.com/chiridion/sandbox-host/internal/state"
	"github.com/chiridion/sandbox-host/internal/workspace"
	"github.com/gorilla/websocket"
)

type ProxyThreadContext struct {
	Key           string
	ContainerName string
	OrgID         string
	WorkspaceID   string
	UserID        string
	ThreadID      string
	WorkerBaseURL string
	CreatedAt     time.Time
	LastSeenAt    time.Time
	ExpiresAt     time.Time
	ClosedAt      *time.Time

	// BYOK: when set, Claude API requests are forwarded directly to the
	// provider using these credentials instead of going through AI Gateway.
	ByokAnthropicKey  string
	ByokBedrockToken  string
	ByokBedrockRegion string
	ByokOpenAIKey     string
	ByokOpenRouterKey string
}

type WorkspaceRoute struct {
	Name        string
	OrgID       string
	WorkspaceID string
	Subpath     string
}

type ProxyRoute struct {
	ThreadID     string
	UpstreamPath string
}

type Server struct {
	cfg        Config
	containers *container.Manager
	workspaces *workspace.Manager
	fs         *fsops.Manager
	state      *state.Store
	usage      *state.UsageStore

	proxyMu      sync.Mutex
	proxyThreads map[string]*ProxyThreadContext
	hostPiMu     sync.Mutex
	hostPiChats  map[string]*hostPiBridge
	draining     atomic.Bool
	webToolMu    sync.Mutex
	webToolIndex int

	httpClient *http.Client
	wsUpgrader websocket.Upgrader
}

const (
	openRouterAttributionReferer    = "https://camelai.dev"
	openRouterAttributionTitle      = "camelAI"
	openRouterAttributionCategories = "cloud-agent,programming-app"
)

func NewServer(cfg Config, containers *container.Manager, workspaces *workspace.Manager, fsManager *fsops.Manager, stateStore *state.Store, usageStore *state.UsageStore) *Server {
	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          128,
		MaxIdleConnsPerHost:   32,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		DisableCompression:    true,
	}

	s := &Server{
		cfg:          cfg,
		containers:   containers,
		workspaces:   workspaces,
		fs:           fsManager,
		state:        stateStore,
		usage:        usageStore,
		proxyThreads: make(map[string]*ProxyThreadContext),
		hostPiChats:  make(map[string]*hostPiBridge),
		httpClient:   &http.Client{Transport: transport},
		wsUpgrader: websocket.Upgrader{
			CheckOrigin: func(_ *http.Request) bool { return true },
		},
	}

	s.loadProxyThreadsFromState()

	go s.runProxyThreadCleanup()
	return s
}

func (s *Server) Handler() http.Handler {
	return s
}

func (s *Server) ProxyHandler() http.Handler {
	return proxyOnlyHandler{server: s}
}

type proxyOnlyHandler struct {
	server *Server
}

func (h proxyOnlyHandler) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	sourceIP := requestSourceIP(req)
	h.server.trace("proxy_listener_request_start", map[string]any{
		"method":   req.Method,
		"pathname": req.URL.Path,
		"search":   req.URL.RawQuery,
		"sourceIp": sourceIP,
	})

	if req.URL.Path == "/health" {
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "service": "sandbox-host-proxy"})
		return
	}

	proxy, ok := parseProxyRoute(req.URL.Path)
	if !ok {
		errorJSON(w, "Not found", http.StatusNotFound)
		return
	}

	if strings.TrimSpace(sourceIP) == "" {
		errorJSON(w, "Missing proxy source IP", http.StatusForbidden)
		return
	}
	h.server.handleProxyRoute(w, req, proxy, sourceIP)
}

func (s *Server) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	sourceIP := requestSourceIP(req)
	s.trace("request_start", map[string]any{
		"method":   req.Method,
		"pathname": req.URL.Path,
		"search":   req.URL.RawQuery,
		"sourceIp": sourceIP,
	})

	if req.URL.Path == "/health" {
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "service": "sandbox-host"})
		return
	}
	if req.URL.Path == "/internal/admin/drain" {
		s.handleDrainRoute(w, req, sourceIP)
		return
	}

	if req.URL.Path == "/internal/host-pi/ask-user-question" {
		s.handleHostPiAskUserQuestionRoute(w, req, sourceIP)
		return
	}
	if req.URL.Path == "/internal/host-pi/todo-state" {
		s.handleHostPiTodoStateRoute(w, req, sourceIP)
		return
	}
	if req.URL.Path == "/internal/host-pi/web-search" {
		s.handleHostPiWebToolRoute(w, req, sourceIP, "search")
		return
	}
	if req.URL.Path == "/internal/host-pi/web-fetch" {
		s.handleHostPiWebToolRoute(w, req, sourceIP, "fetch")
		return
	}
	if strings.HasPrefix(req.URL.Path, "/internal/host-pi/inference/") {
		s.handleHostPiInferenceRoute(w, req, sourceIP)
		return
	}

	// Usage/spend endpoints (org-scoped, control port only).
	if strings.HasPrefix(req.URL.Path, "/v1/usage/") {
		s.handleUsageRoute(w, req)
		return
	}

	if strings.HasPrefix(req.URL.Path, "/v1/virtual-ai/") {
		s.handleVirtualAIRoute(w, req)
		return
	}

	route, ok := parseWorkspaceRoute(req.URL.Path)
	if !ok {
		errorJSON(w, "Not found", http.StatusNotFound)
		return
	}

	if s.rejectControlRouteFromSandboxCaller(w, req, route, sourceIP) {
		return
	}

	s.containers.TouchContainer(route.Name, fmt.Sprintf("workspace_request:%s:%s", req.Method, route.Subpath))

	if err := s.handleWorkspaceRoute(w, req, route); err != nil {
		log.Printf("[SandboxHost] request error: %v", err)
		s.trace("request_error", map[string]any{
			"method":   req.Method,
			"pathname": req.URL.Path,
			"sourceIp": sourceIP,
			"error":    err.Error(),
		})
		errorJSON(w, fmt.Sprintf("Internal error: %v", err), http.StatusInternalServerError)
	}
}

func (s *Server) rejectControlRouteFromSandboxCaller(
	w http.ResponseWriter,
	req *http.Request,
	route WorkspaceRoute,
	sourceIP string,
) bool {
	if strings.TrimSpace(sourceIP) == "" || isLoopbackSourceIP(sourceIP) {
		return false
	}

	caller, err := s.containers.ResolveContainerBySourceIP(sourceIP)
	if err != nil {
		s.trace("control_request_caller_resolution_error", map[string]any{
			"method":        req.Method,
			"pathname":      req.URL.Path,
			"sourceIp":      sourceIP,
			"targetSandbox": route.Name,
			"error":         err.Error(),
		})
		errorJSON(w, "Caller resolution failed", http.StatusInternalServerError)
		return true
	}
	if caller == nil {
		return false
	}

	s.trace("control_request_rejected_container_source", map[string]any{
		"method":          req.Method,
		"pathname":        req.URL.Path,
		"sourceIp":        sourceIP,
		"targetSandbox":   route.Name,
		"callerSandbox":   caller.Name,
		"callerWorkspace": caller.WorkspaceID,
		"targetWorkspace": route.WorkspaceID,
	})
	errorJSON(w, "Sandbox containers may only access /proxy", http.StatusForbidden)
	return true
}

func (s *Server) handleWorkspaceRoute(w http.ResponseWriter, req *http.Request, route WorkspaceRoute) error {
	name := route.Name
	opts := container.EnsureContainerOptions{OrgID: route.OrgID, WorkspaceID: route.WorkspaceID}

	if route.Subpath == "" && req.Method == http.MethodDelete {
		success, err := s.containers.TerminateContainer(name, "workspace_purge")
		if err != nil {
			return err
		}
		if err := s.workspaces.Delete(name); err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "terminated": success})
		return nil
	}

	if route.Subpath == "/terminate" && req.Method == http.MethodPost {
		success, err := s.containers.TerminateContainer(name, "explicit_terminate_route")
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": success})
		return nil
	}

	if strings.HasPrefix(route.Subpath, "/fs/") || route.Subpath == "/chat/messages" || route.Subpath == "/chat/fork" {
		if _, err := s.workspaces.Ensure(name); err != nil {
			return err
		}
	}

	switch {
	case route.Subpath == "/fs/read" && req.Method == http.MethodGet:
		return s.handleFSRead(w, req, route)
	case route.Subpath == "/fs/write" && req.Method == http.MethodPut:
		return s.handleFSWrite(w, req, name)
	case route.Subpath == "/fs/list" && req.Method == http.MethodGet:
		return s.handleFSList(w, req, name)
	case route.Subpath == "/fs/delete" && req.Method == http.MethodDelete:
		return s.handleFSDelete(w, req, name)
	case route.Subpath == "/fs/move" && req.Method == http.MethodPost:
		return s.handleFSMove(w, req, name)
	case route.Subpath == "/fs/mkdir" && req.Method == http.MethodPost:
		return s.handleFSMkdir(w, req, name)
	case route.Subpath == "/fs/exists" && req.Method == http.MethodGet:
		return s.handleFSExists(w, req, name)
	case route.Subpath == "/exec" && req.Method == http.MethodPost:
		return s.handleExec(w, req, name, opts)
	case route.Subpath == "/chat/messages" && req.Method == http.MethodGet:
		return s.handleChatMessages(w, req, name)
	case route.Subpath == "/chat/fork" && req.Method == http.MethodPost:
		return s.handleChatFork(w, req)
	case strings.HasPrefix(route.Subpath, "/data-proxy/"):
		return s.forwardDataProxyRequest(w, req, route)
	case route.Subpath == "/health" && req.Method == http.MethodGet:
		if _, err := s.containers.EnsureContainer(name, opts); err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "status": "ok"})
		return nil
	case route.Subpath == "/chat":
		return s.handleChatProxy(w, req, name, route, opts)
	default:
		errorJSON(w, "Not found", http.StatusNotFound)
		return nil
	}
}

func (s *Server) handleChatFork(w http.ResponseWriter, req *http.Request) error {
	var payload piForkSessionRequest
	if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
		errorJSON(w, "Invalid JSON", http.StatusBadRequest)
		return nil
	}
	result, err := forkHostPiSession(s.cfg.HostPiSessionRoot, payload)
	if err != nil {
		errorJSON(w, err.Error(), http.StatusBadRequest)
		return nil
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"fork":    result,
	})
	return nil
}

func (s *Server) handleChatMessages(w http.ResponseWriter, req *http.Request, name string) error {
	threadID := strings.TrimSpace(req.URL.Query().Get("threadId"))
	if threadID == "" {
		errorJSON(w, "threadId query param required", http.StatusBadRequest)
		return nil
	}
	if strings.ContainsAny(threadID, `/\`) {
		errorJSON(w, "invalid threadId", http.StatusBadRequest)
		return nil
	}

	claudeSessionID := strings.TrimSpace(req.URL.Query().Get("claudeSessionId"))
	if strings.ContainsAny(claudeSessionID, `/\`) {
		errorJSON(w, "invalid claudeSessionId", http.StatusBadRequest)
		return nil
	}

	codexSessionID := strings.TrimSpace(req.URL.Query().Get("codexSessionId"))
	if strings.ContainsAny(codexSessionID, `/\`) {
		errorJSON(w, "invalid codexSessionId", http.StatusBadRequest)
		return nil
	}

	started := time.Now()
	s.containers.AddProxyRequest(name, "chat_messages")
	defer func() {
		s.containers.RemoveProxyRequest(name, "chat_messages", http.StatusOK, time.Since(started).Milliseconds())
	}()

	if messages, err := readHostPiSessionMessages(s.cfg.HostPiSessionRoot, threadID); err != nil {
		log.Printf("[SandboxHost] host Pi message history unavailable thread=%s sessionRoot=%s: %v", threadID, s.cfg.HostPiSessionRoot, err)
	} else if len(messages) > 0 {
		log.Printf("[SandboxHost] chat messages loaded from host Pi thread=%s messages=%d", threadID, len(messages))
		writeJSON(w, http.StatusOK, map[string]any{
			"success":  true,
			"messages": messages,
		})
		return nil
	} else {
		log.Printf("[SandboxHost] host Pi message history empty thread=%s sessionRoot=%s; checking legacy history", threadID, s.cfg.HostPiSessionRoot)
	}

	sessionIDs := []string{threadID}
	if claudeSessionID != "" && claudeSessionID != threadID {
		sessionIDs = append(sessionIDs, claudeSessionID)
	}

	log.Printf("[SandboxHost] chat messages scanning Claude legacy history thread=%s container=%s claudeSession=%s candidateSessions=%d", threadID, name, claudeSessionID, len(sessionIDs))
	for _, sessionID := range sessionIDs {
		jsonlPath := fmt.Sprintf("/home/claude/.claude/projects/-home-claude/%s.jsonl", sessionID)
		info, err := s.fs.ReadInfo(name, jsonlPath)
		if err != nil {
			lower := strings.ToLower(err.Error())
			if strings.Contains(lower, "no such file") || strings.Contains(lower, "not exist") {
				log.Printf("[SandboxHost] chat messages Claude candidate missing thread=%s session=%s path=%s", threadID, sessionID, jsonlPath)
				continue
			}
			log.Printf("[SandboxHost] chat messages Claude candidate stat failed thread=%s session=%s path=%s: %v", threadID, sessionID, jsonlPath, err)
			return s.handleFSError(w, err, "Chat messages unavailable")
		}

		file, err := os.Open(info.HostPath)
		if err != nil {
			if os.IsNotExist(err) {
				log.Printf("[SandboxHost] chat messages Claude candidate host file missing thread=%s session=%s containerPath=%s hostPath=%s", threadID, sessionID, jsonlPath, info.HostPath)
				continue
			}
			log.Printf("[SandboxHost] chat messages Claude candidate open failed thread=%s session=%s containerPath=%s hostPath=%s: %v", threadID, sessionID, jsonlPath, info.HostPath, err)
			return err
		}
		defer file.Close()

		content, err := io.ReadAll(file)
		if err != nil {
			log.Printf("[SandboxHost] chat messages Claude candidate read failed thread=%s session=%s containerPath=%s hostPath=%s: %v", threadID, sessionID, jsonlPath, info.HostPath, err)
			return err
		}
		messages := parseClaudeJSONLMessages(string(content), threadID)
		if len(messages) == 0 {
			log.Printf("[SandboxHost] chat messages Claude candidate parsed empty thread=%s session=%s path=%s bytes=%d", threadID, sessionID, jsonlPath, len(content))
			continue
		}

		log.Printf("[SandboxHost] chat messages loaded from Claude legacy thread=%s session=%s path=%s bytes=%d messages=%d", threadID, sessionID, jsonlPath, len(content), len(messages))
		writeJSON(w, http.StatusOK, map[string]any{
			"success":  true,
			"messages": messages,
		})
		return nil
	}

	codexThreadPaths, err := legacyCodexStatePathCandidates(threadID, codexSessionID)
	if err != nil {
		errorJSON(w, err.Error(), http.StatusBadRequest)
		return nil
	}
	log.Printf("[SandboxHost] chat messages scanning Codex legacy history thread=%s container=%s codexSession=%s candidatePaths=%d", threadID, name, codexSessionID, len(codexThreadPaths))
	for _, codexThreadPath := range codexThreadPaths {
		info, err := s.fs.ReadInfo(name, codexThreadPath)
		if err != nil {
			lower := strings.ToLower(err.Error())
			if strings.Contains(lower, "no such file") || strings.Contains(lower, "not exist") {
				log.Printf("[SandboxHost] chat messages Codex candidate missing thread=%s path=%s", threadID, codexThreadPath)
				continue
			}
			log.Printf("[SandboxHost] chat messages Codex candidate stat failed thread=%s path=%s: %v", threadID, codexThreadPath, err)
			return s.handleFSError(w, err, "Chat messages unavailable")
		}
		if messages, err := readCodexStateMessages(req.Context(), info.HostPath, threadID, codexSessionID); err != nil {
			log.Printf("[SandboxHost] chat messages Codex candidate read failed thread=%s path=%s hostPath=%s codexSession=%s: %v", threadID, codexThreadPath, info.HostPath, codexSessionID, err)
		} else if len(messages) > 0 {
			log.Printf("[SandboxHost] chat messages loaded from Codex legacy thread=%s path=%s hostPath=%s codexSession=%s messages=%d", threadID, codexThreadPath, info.HostPath, codexSessionID, len(messages))
			writeJSON(w, http.StatusOK, map[string]any{
				"success":  true,
				"messages": messages,
			})
			return nil
		} else {
			log.Printf("[SandboxHost] chat messages Codex candidate parsed empty thread=%s path=%s hostPath=%s codexSession=%s", threadID, codexThreadPath, info.HostPath, codexSessionID)
		}
	}

	log.Printf("[SandboxHost] chat messages found no history thread=%s container=%s claudeSession=%s codexSession=%s", threadID, name, claudeSessionID, codexSessionID)
	writeJSON(w, http.StatusOK, map[string]any{
		"success":  true,
		"messages": []parsedChatMessage{},
	})
	return nil
}

func (s *Server) forwardDataProxyRequest(w http.ResponseWriter, req *http.Request, route WorkspaceRoute) error {
	base := strings.TrimRight(strings.TrimSpace(s.cfg.DataProxyUpstreamURL), "/")
	if base == "" {
		errorJSON(w, "Data proxy upstream not configured", http.StatusServiceUnavailable)
		return nil
	}

	targetURL := base + route.Subpath
	if req.URL.RawQuery != "" {
		targetURL += "?" + req.URL.RawQuery
	}

	forwardReq, err := http.NewRequestWithContext(req.Context(), req.Method, targetURL, req.Body)
	if err != nil {
		return err
	}
	copyHeaders(forwardReq.Header, req.Header)
	forwardReq.Header.Set("X-Chiridion-Org-Id", route.OrgID)
	forwardReq.Header.Set("X-Chiridion-Workspace-Id", route.WorkspaceID)

	resp, err := s.httpClient.Do(forwardReq)
	if err != nil {
		errorJSON(w, "Data proxy upstream unavailable", http.StatusServiceUnavailable)
		return nil
	}
	defer resp.Body.Close()

	copyHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)

	if err := copyResponseBody(w, resp.Body); err != nil {
		if errors.Is(err, context.Canceled) {
			return nil
		}
		return err
	}
	return nil
}

func normalizeOpenAIProxyUpstreamPath(path string) (string, bool) {
	if !strings.HasPrefix(path, "/v1/") && path != "/v1" {
		return "", false
	}
	normalized := strings.TrimPrefix(path, "/v1")
	if normalized == "" || normalized == "/" {
		return "", false
	}
	return normalized, true
}

func openAICompatibleProxyPath(upstreamPath string) (string, string, bool) {
	for _, prefix := range []string{"/api/openai", "/api/openrouter"} {
		if upstreamPath != prefix && !strings.HasPrefix(upstreamPath, prefix+"/") {
			continue
		}
		path := strings.TrimPrefix(upstreamPath, prefix)
		normalized, ok := normalizeOpenAIProxyUpstreamPath(path)
		return path, normalized, ok
	}
	return "", "", false
}

func (s *Server) handleFSRead(w http.ResponseWriter, req *http.Request, route WorkspaceRoute) error {
	path := req.URL.Query().Get("path")
	if strings.TrimSpace(path) == "" {
		errorJSON(w, "path query param required", http.StatusBadRequest)
		return nil
	}

	// Resolve /mnt/user-outputs/ and /mnt/user-uploads/ to host R2 FUSE paths.
	if hostPath, ok := s.containers.ResolveR2HostPath(route.Name, path); ok {
		return s.serveHostFile(w, hostPath)
	}
	if hostPath, ok := s.resolveLegacyR2MountPath(path, route.OrgID, route.WorkspaceID); ok {
		return s.serveHostFile(w, hostPath)
	}

	info, err := s.fs.ReadInfo(route.Name, path)
	if err != nil {
		return s.handleFSError(w, err, "File not found")
	}

	return s.serveHostFile(w, info.HostPath)
}

// resolveLegacyR2MountPath checks if a sandbox path targets /mnt/user-outputs/ or
// /mnt/user-uploads/ and returns the legacy global host R2 FUSE path.
// Returns ("", false) if the path doesn't match or is invalid.
func (s *Server) resolveLegacyR2MountPath(sandboxPath, orgID, workspaceID string) (string, bool) {
	for _, mountDir := range []string{"user-outputs", "user-uploads"} {
		prefix := "/mnt/" + mountDir + "/"
		if !strings.HasPrefix(sandboxPath, prefix) {
			continue
		}
		subpath := strings.TrimPrefix(sandboxPath, prefix)
		cleaned := filepath.Clean(subpath)
		// Reject traversal: cleaned must stay within the mount subtree
		if cleaned == ".." || strings.HasPrefix(cleaned, "../") || filepath.IsAbs(cleaned) {
			return "", false
		}
		hostPath := filepath.Join("/mnt/r2", orgID, workspaceID, mountDir, cleaned)
		return hostPath, true
	}
	return "", false
}

func (s *Server) serveHostFile(w http.ResponseWriter, hostPath string) error {
	stat, err := os.Stat(hostPath)
	if err != nil {
		if os.IsNotExist(err) {
			errorJSON(w, "File not found", http.StatusNotFound)
			return nil
		}
		return err
	}

	ext := filepath.Ext(hostPath)
	contentType := mime.TypeByExtension(ext)
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.FormatInt(stat.Size(), 10))
	file, err := os.Open(hostPath)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = io.Copy(w, file)
	return err
}

func (s *Server) handleFSWrite(w http.ResponseWriter, req *http.Request, name string) error {
	path := req.URL.Query().Get("path")
	if strings.TrimSpace(path) == "" {
		errorJSON(w, "path query param required", http.StatusBadRequest)
		return nil
	}
	data, err := io.ReadAll(req.Body)
	if err != nil {
		return err
	}
	if err := s.fs.Write(name, path, data); err != nil {
		return s.handleFSError(w, err, "Write failed")
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
	return nil
}

func (s *Server) handleFSList(w http.ResponseWriter, req *http.Request, name string) error {
	path := req.URL.Query().Get("path")
	if strings.TrimSpace(path) == "" {
		path = "/"
	}
	recursive := parseBoolQuery(req.URL.Query().Get("recursive"), false)
	includeHidden := parseBoolQuery(req.URL.Query().Get("includeHidden"), true)

	files, err := s.fs.List(name, path, fsops.ListOptions{
		Recursive:     recursive,
		IncludeHidden: includeHidden,
	})
	if err != nil {
		return s.handleFSError(w, err, "Path not found")
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"files":     files,
		"count":     len(files),
		"path":      path,
		"recursive": recursive,
		"timestamp": time.Now().UTC().Format(time.RFC3339Nano),
	})
	return nil
}

func parseBoolQuery(raw string, defaultValue bool) bool {
	value := strings.TrimSpace(raw)
	if value == "" {
		return defaultValue
	}
	switch strings.ToLower(value) {
	case "1", "true":
		return true
	case "0", "false":
		return false
	default:
		return defaultValue
	}
}

func (s *Server) handleFSDelete(w http.ResponseWriter, req *http.Request, name string) error {
	var payload struct {
		Path      string `json:"path"`
		Recursive bool   `json:"recursive"`
	}
	if err := decodeJSON(req, &payload); err != nil {
		errorJSON(w, "invalid JSON body", http.StatusBadRequest)
		return nil
	}
	if strings.TrimSpace(payload.Path) == "" {
		errorJSON(w, "path required", http.StatusBadRequest)
		return nil
	}
	if err := s.fs.Delete(name, payload.Path, payload.Recursive); err != nil {
		return s.handleFSError(w, err, "Delete failed")
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
	return nil
}

func (s *Server) handleFSMove(w http.ResponseWriter, req *http.Request, name string) error {
	var payload struct {
		Source string `json:"source"`
		Dest   string `json:"dest"`
	}
	if err := decodeJSON(req, &payload); err != nil {
		errorJSON(w, "invalid JSON body", http.StatusBadRequest)
		return nil
	}
	if strings.TrimSpace(payload.Source) == "" || strings.TrimSpace(payload.Dest) == "" {
		errorJSON(w, "source and dest required", http.StatusBadRequest)
		return nil
	}
	if err := s.fs.Move(name, payload.Source, payload.Dest); err != nil {
		return s.handleFSError(w, err, "Move failed")
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "timestamp": time.Now().UTC().Format(time.RFC3339Nano)})
	return nil
}

func (s *Server) handleFSMkdir(w http.ResponseWriter, req *http.Request, name string) error {
	path := req.URL.Query().Get("path")
	if strings.TrimSpace(path) == "" {
		errorJSON(w, "path query param required", http.StatusBadRequest)
		return nil
	}
	if err := s.fs.Mkdir(name, path); err != nil {
		return s.handleFSError(w, err, "mkdir failed")
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "timestamp": time.Now().UTC().Format(time.RFC3339Nano)})
	return nil
}

func (s *Server) handleFSExists(w http.ResponseWriter, req *http.Request, name string) error {
	path := req.URL.Query().Get("path")
	if strings.TrimSpace(path) == "" {
		errorJSON(w, "path query param required", http.StatusBadRequest)
		return nil
	}
	result, err := s.fs.Exists(name, path)
	if err != nil {
		return s.handleFSError(w, err, "exists failed")
	}
	writeJSON(w, http.StatusOK, result)
	return nil
}

func (s *Server) handleExec(w http.ResponseWriter, req *http.Request, name string, opts container.EnsureContainerOptions) error {
	var body container.ExecRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		errorJSON(w, "Invalid JSON body", http.StatusBadRequest)
		return nil
	}
	if _, err := s.containers.EnsureContainer(name, opts); err != nil {
		return err
	}
	started := time.Now()
	s.containers.AddProxyRequest(name, "container_exec")
	defer func() {
		s.containers.RemoveProxyRequest(name, "container_exec", http.StatusOK, time.Since(started).Milliseconds())
	}()
	result, err := s.containers.Exec(req.Context(), name, opts, body)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, result)
	return nil
}

func (s *Server) handleChatProxy(
	w http.ResponseWriter,
	req *http.Request,
	name string,
	route WorkspaceRoute,
	opts container.EnsureContainerOptions,
) error {
	if !websocket.IsWebSocketUpgrade(req) {
		errorJSON(w, "WebSocket upgrade required", http.StatusUpgradeRequired)
		return nil
	}

	threadID := strings.TrimSpace(req.Header.Get(s.cfg.HeaderThreadID))
	if threadID == "" {
		errorJSON(w, "Missing thread ID", http.StatusBadRequest)
		return nil
	}
	if strings.ContainsAny(threadID, `/\`) {
		errorJSON(w, "invalid thread ID", http.StatusBadRequest)
		return nil
	}
	userID := strings.TrimSpace(req.Header.Get(s.cfg.HeaderUserID))
	byokAnthropicKey := strings.TrimSpace(req.Header.Get("X-Chiridion-Byok-Anthropic-Key"))
	byokBedrockToken := strings.TrimSpace(req.Header.Get("X-Chiridion-Byok-Bedrock-Token"))
	byokBedrockRegion := strings.TrimSpace(req.Header.Get("X-Chiridion-Byok-Bedrock-Region"))
	byokOpenAIKey := strings.TrimSpace(req.Header.Get("X-Chiridion-Byok-OpenAI-Key"))
	byokOpenRouterKey := strings.TrimSpace(req.Header.Get("X-Chiridion-Byok-OpenRouter-Key"))

	workerBaseURL := normalizeWorkerBaseURL(firstNonEmpty(req.Header.Get(s.cfg.HeaderWorkerBaseURL), s.cfg.WorkerBaseURL))
	if workerBaseURL == "" {
		errorJSON(w, "Missing worker base URL", http.StatusBadRequest)
		return nil
	}

	now := time.Now().UTC()
	threadKey := proxyThreadKey(name, threadID)
	if s.IsDraining() {
		bridge := s.hostPiBridgeForThread(threadID)
		if bridge == nil || bridge.threadKey != threadKey || !bridge.isActive() {
			errorJSON(w, "Sandbox host is draining for deploy", http.StatusServiceUnavailable)
			return nil
		}
	}

	s.proxyMu.Lock()
	existing := s.proxyThreads[threadKey]
	createdAt := now
	if existing != nil {
		createdAt = existing.CreatedAt
	}
	s.proxyThreads[threadKey] = &ProxyThreadContext{
		Key:               threadKey,
		ContainerName:     name,
		OrgID:             route.OrgID,
		WorkspaceID:       route.WorkspaceID,
		UserID:            userID,
		ThreadID:          threadID,
		WorkerBaseURL:     workerBaseURL,
		CreatedAt:         createdAt,
		LastSeenAt:        now,
		ExpiresAt:         now.Add(s.cfg.ProxyThreadActiveTTL),
		ClosedAt:          nil,
		ByokAnthropicKey:  byokAnthropicKey,
		ByokBedrockToken:  byokBedrockToken,
		ByokBedrockRegion: byokBedrockRegion,
		ByokOpenAIKey:     byokOpenAIKey,
		ByokOpenRouterKey: byokOpenRouterKey,
	}
	current := copyProxyThreadContext(s.proxyThreads[threadKey])
	s.proxyMu.Unlock()
	s.upsertProxyThreadState(current)
	cleanupFailedOpen := func() {
		if existing != nil {
			return
		}
		s.proxyMu.Lock()
		delete(s.proxyThreads, threadKey)
		s.proxyMu.Unlock()
		s.deleteProxyThreadState(threadKey)
	}

	log.Printf("[SandboxHost] chat session opened container=%s thread=%s", name, threadID)
	s.trace("chat_session_opened", map[string]any{
		"container":          name,
		"orgId":              route.OrgID,
		"workspaceId":        route.WorkspaceID,
		"threadId":           threadID,
		"threadKey":          threadKey,
		"workerBaseUrl":      workerBaseURL,
		"activeProxyThreads": s.proxyThreadCount(),
	})

	clientConn, err := s.wsUpgrader.Upgrade(w, req, nil)
	if err != nil {
		cleanupFailedOpen()
		s.trace("chat_session_upgrade_failed", map[string]any{
			"container":   name,
			"orgId":       route.OrgID,
			"workspaceId": route.WorkspaceID,
			"threadId":    threadID,
			"threadKey":   threadKey,
		})
		return nil
	}
	s.trace("chat_session_upgrade_success", map[string]any{
		"container":   name,
		"orgId":       route.OrgID,
		"workspaceId": route.WorkspaceID,
		"threadId":    threadID,
		"threadKey":   threadKey,
	})

	return s.serveHostPiChat(clientConn, name, route, opts, threadID, threadKey)
}

func (s *Server) handleHostPiInferenceRoute(w http.ResponseWriter, req *http.Request, sourceIP string) {
	if !isLoopbackSourceIP(sourceIP) {
		errorJSON(w, "Host Pi inference endpoint is loopback only", http.StatusForbidden)
		return
	}

	proxy, ok := parseHostPiInferenceRoute(req.URL.Path)
	if !ok {
		errorJSON(w, "Invalid Host Pi inference route", http.StatusNotFound)
		return
	}
	if !isInferenceProxyPath(proxy.UpstreamPath) {
		errorJSON(w, "Invalid Host Pi inference upstream", http.StatusForbidden)
		return
	}

	s.handleProxyRoute(w, req, proxy, sourceIP)
}

func (s *Server) handleProxyRoute(w http.ResponseWriter, req *http.Request, proxy ProxyRoute, sourceIP string) {
	startedAt := time.Now()
	requestID := randomID()

	if strings.TrimSpace(s.cfg.SandboxProxySecret) == "" {
		errorJSON(w, "SANDBOX_PROXY_SECRET not configured", http.StatusInternalServerError)
		return
	}

	caller, err := s.containers.ResolveContainerBySourceIP(sourceIP)
	if err != nil {
		errorJSON(w, "Proxy caller resolution failed", http.StatusInternalServerError)
		return
	}

	var threadKey string
	var threadContext *ProxyThreadContext
	hostPiLoopback := false
	if caller == nil {
		if isLoopbackSourceIP(sourceIP) {
			if resolvedKey, resolvedContext, ok := s.resolveHostPiLoopbackProxyThread(proxy.ThreadID, time.Now().UTC()); ok {
				threadKey = resolvedKey
				threadContext = resolvedContext
				hostPiLoopback = true
				caller = &container.ContainerRecord{Name: resolvedContext.ContainerName}
			}
		}
	}
	if caller == nil {
		s.trace("proxy_request_rejected_unknown_caller", map[string]any{
			"requestId":    requestID,
			"sourceIp":     sourceIP,
			"method":       req.Method,
			"upstreamPath": proxy.UpstreamPath,
			"threadId":     proxy.ThreadID,
		})
		errorJSON(w, "Unknown proxy caller", http.StatusForbidden)
		return
	}

	if !hostPiLoopback && isInferenceProxyPath(proxy.UpstreamPath) {
		s.trace("proxy_request_rejected_container_inference", map[string]any{
			"requestId":       requestID,
			"sourceIp":        sourceIP,
			"callerContainer": caller.Name,
			"method":          req.Method,
			"upstreamPath":    proxy.UpstreamPath,
			"threadId":        proxy.ThreadID,
		})
		errorJSON(w, "Inference proxy is only available to the host Pi harness", http.StatusForbidden)
		return
	}

	if threadContext == nil {
		threadKey = proxyThreadKey(caller.Name, proxy.ThreadID)
		var upsertedThread *ProxyThreadContext
		removedThread := false
		s.proxyMu.Lock()
		threadContext = s.proxyThreads[threadKey]
		now := time.Now().UTC()
		if threadContext != nil {
			if threadContext.ContainerName != caller.Name {
				threadContext = nil
				delete(s.proxyThreads, threadKey)
				removedThread = true
			} else if threadContext.ClosedAt != nil && !threadContext.ExpiresAt.After(now) {
				// Closed thread mappings are only valid through close-grace.
				threadContext = nil
				delete(s.proxyThreads, threadKey)
				removedThread = true
			} else {
				threadContext.LastSeenAt = now
				upsertedThread = copyProxyThreadContext(threadContext)
			}
		}
		s.proxyMu.Unlock()
		if upsertedThread != nil {
			s.upsertProxyThreadState(upsertedThread)
		}
		if removedThread {
			s.deleteProxyThreadState(threadKey)
		}
	}

	if threadContext == nil {
		s.trace("proxy_request_rejected_unknown_thread", map[string]any{
			"requestId":       requestID,
			"sourceIp":        sourceIP,
			"callerContainer": caller.Name,
			"method":          req.Method,
			"upstreamPath":    proxy.UpstreamPath,
			"threadId":        proxy.ThreadID,
			"threadKey":       threadKey,
		})
		errorJSON(w, "Unknown proxy thread", http.StatusForbidden)
		return
	}

	// BYOK: route Claude API requests directly to the provider (bypass AI Gateway).
	if strings.HasPrefix(proxy.UpstreamPath, "/api/claude/") {
		if threadContext.ByokAnthropicKey != "" {
			s.forwardClaudeToAnthropicDirect(w, req, proxy, threadContext, caller, requestID, startedAt)
			return
		}
		if threadContext.ByokOpenRouterKey != "" {
			s.forwardClaudeToOpenRouterDirect(w, req, proxy, threadContext, caller, requestID, startedAt)
			return
		}
		// Bedrock count_tokens falls through to AI Gateway (Bedrock uses Anthropic format for that).
		if threadContext.ByokBedrockToken != "" && !strings.Contains(proxy.UpstreamPath, "count_tokens") {
			s.forwardClaudeToBedrockDirect(w, req, proxy, threadContext, caller, requestID, startedAt)
			return
		}
	}

	// Hosted Claude API requests go through OpenRouter via AI Gateway. BYOK routes above
	// remain provider-direct.
	if strings.HasPrefix(proxy.UpstreamPath, "/api/claude/") && s.cfg.AIGatewayBaseURL != "" {
		s.forwardClaudeToOpenRouterGateway(w, req, proxy, threadContext, caller, requestID, startedAt)
		return
	}

	if strings.HasPrefix(proxy.UpstreamPath, "/api/openrouter/") && threadContext.ByokOpenRouterKey != "" {
		s.forwardOpenRouterDirect(w, req, proxy, threadContext, caller, requestID, startedAt)
		return
	}

	if s.cfg.AIGatewayBaseURL != "" && strings.HasPrefix(proxy.UpstreamPath, "/api/openrouter/") {
		s.forwardOpenAIToAIGateway(w, req, proxy, threadContext, caller, requestID, startedAt)
		return
	}

	if strings.HasPrefix(proxy.UpstreamPath, "/api/openai/") && threadContext.ByokOpenRouterKey != "" {
		s.forwardOpenRouterDirect(w, req, proxy, threadContext, caller, requestID, startedAt)
		return
	}

	if strings.HasPrefix(proxy.UpstreamPath, "/api/openai/") && threadContext.ByokOpenAIKey != "" {
		s.forwardOpenAIDirect(w, req, proxy, threadContext, caller, requestID, startedAt)
		return
	}

	// Route OpenAI API requests to AI Gateway (still uses gateway).
	if s.cfg.AIGatewayBaseURL != "" && strings.HasPrefix(proxy.UpstreamPath, "/api/openai/") {
		s.forwardOpenAIToAIGateway(w, req, proxy, threadContext, caller, requestID, startedAt)
		return
	}

	workerBaseURL := normalizeWorkerBaseURL(firstNonEmpty(threadContext.WorkerBaseURL, s.cfg.WorkerBaseURL))
	if workerBaseURL == "" {
		s.trace("proxy_request_rejected_missing_worker_base", map[string]any{
			"requestId":       requestID,
			"callerContainer": caller.Name,
			"threadId":        proxy.ThreadID,
			"threadKey":       threadKey,
		})
		errorJSON(w, "Worker base URL unavailable for proxy thread", http.StatusServiceUnavailable)
		return
	}

	targetURL := workerBaseURL + proxy.UpstreamPath
	if req.URL.RawQuery != "" {
		targetURL += "?" + req.URL.RawQuery
	}
	target, parseErr := url.Parse(targetURL)
	if parseErr != nil {
		errorJSON(w, "Invalid upstream URL", http.StatusBadGateway)
		return
	}

	forwardReq, newReqErr := http.NewRequestWithContext(req.Context(), req.Method, target.String(), req.Body)
	if newReqErr != nil {
		errorJSON(w, "Failed to create upstream request", http.StatusInternalServerError)
		return
	}

	headers := cloneHeaders(req.Header)
	if !shouldPreserveAuthorization(proxy.UpstreamPath) {
		headers.Del("Authorization")
	}
	headers.Del("x-api-key")
	headers.Del("x-sandbox-secret")
	headers.Del("x-chiridion-org-id")
	headers.Del("x-chiridion-workspace-id")
	headers.Del("x-chiridion-user-id")
	headers.Del("x-chiridion-thread-id")
	headers.Del("x-chiridion-mcp-identity")
	headers.Del("Host")
	if headers.Get("ngrok-skip-browser-warning") == "" && (strings.HasSuffix(target.Hostname(), ".ngrok-free.dev") || strings.HasSuffix(target.Hostname(), ".ngrok.app")) {
		headers.Set("ngrok-skip-browser-warning", "true")
	}
	headers.Set("X-Sandbox-Secret", s.cfg.SandboxProxySecret)
	headers.Set("X-Chiridion-Org-Id", threadContext.OrgID)
	headers.Set("X-Chiridion-Workspace-Id", threadContext.WorkspaceID)
	if strings.TrimSpace(threadContext.UserID) != "" {
		headers.Set("X-Chiridion-User-Id", threadContext.UserID)
	}
	headers.Set("X-Chiridion-Thread-Id", threadContext.ThreadID)
	applyStreamingRequestHeaders(headers)
	forwardReq.Header = headers

	s.trace("proxy_request_start", map[string]any{
		"requestId":       requestID,
		"sourceIp":        sourceIP,
		"callerContainer": caller.Name,
		"method":          req.Method,
		"threadId":        threadContext.ThreadID,
		"threadKey":       threadKey,
		"targetHost":      target.Hostname(),
		"targetPath":      proxy.UpstreamPath,
	})
	s.containers.AddProxyRequest(threadContext.ContainerName, fmt.Sprintf("proxy:%s:%s", req.Method, proxy.UpstreamPath))

	resp, upstreamErr := s.httpClient.Do(forwardReq)
	durationMs := time.Since(startedAt).Milliseconds()
	if upstreamErr != nil {
		s.trace("proxy_request_error", map[string]any{
			"requestId":       requestID,
			"callerContainer": caller.Name,
			"method":          req.Method,
			"threadId":        threadContext.ThreadID,
			"threadKey":       threadKey,
			"durationMs":      durationMs,
			"targetPath":      proxy.UpstreamPath,
			"error":           upstreamErr.Error(),
		})
		s.containers.RemoveProxyRequest(threadContext.ContainerName, fmt.Sprintf("proxy:%s:%s", req.Method, proxy.UpstreamPath), 0, durationMs)
		log.Printf("[SandboxHost] proxy request failed method=%s path=%s thread=%s container=%s target=%s durationMs=%d error=%v", req.Method, proxy.UpstreamPath, threadContext.ThreadID, threadContext.ContainerName, target.String(), durationMs, upstreamErr)
		errorJSON(w, "Upstream proxy request failed", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	s.trace("proxy_request_complete", map[string]any{
		"requestId":       requestID,
		"callerContainer": caller.Name,
		"method":          req.Method,
		"threadId":        threadContext.ThreadID,
		"threadKey":       threadKey,
		"status":          resp.StatusCode,
		"durationMs":      durationMs,
		"targetPath":      proxy.UpstreamPath,
	})
	s.containers.RemoveProxyRequest(threadContext.ContainerName, fmt.Sprintf("proxy:%s:%s", req.Method, proxy.UpstreamPath), resp.StatusCode, durationMs)

	copyHeaders(w.Header(), resp.Header)
	applyStreamingResponseHeaders(w.Header(), resp.Header.Get("Content-Type"))
	w.WriteHeader(resp.StatusCode)
	if err := copyResponseBody(w, resp.Body); err != nil {
		s.trace("proxy_response_copy_error", map[string]any{
			"requestId":       requestID,
			"callerContainer": caller.Name,
			"threadId":        threadContext.ThreadID,
			"threadKey":       threadKey,
			"error":           err.Error(),
		})
	}
}

type BillingAccessSnapshot struct {
	OrgID                           string `json:"org_id"`
	BillingStatus                   string `json:"billing_status"`
	BillingSubscriptionStatus       string `json:"billing_subscription_status"`
	BillingTrialEndsAt              *int64 `json:"billing_trial_ends_at"`
	BillingCreditPurchaseTotalCents int64  `json:"billing_credit_purchase_total_cents"`
	BillingCreditGrantTotalCents    int64  `json:"billing_credit_grant_total_cents"`
	BillingFreeCreditGrantCents     int64  `json:"billing_free_credit_grant_cents"`
	BillingFreeCreditGrantedAt      *int64 `json:"billing_free_credit_granted_at"`
	BillingCreditUsageStartedAt     *int64 `json:"billing_credit_usage_started_at"`
}

const (
	billingSourceHosted = "hosted"
	billingSourceBYOK   = "byok"
)

type BillingAccessDecision struct {
	Denied           bool
	StatusCode       int
	Message          string
	BillingSource    string
	CreditChargeable bool
}

func (s *Server) fetchBillingAccessSnapshot(threadContext *ProxyThreadContext) (*BillingAccessSnapshot, error) {
	workerBaseURL := normalizeWorkerBaseURL(firstNonEmpty(threadContext.WorkerBaseURL, s.cfg.WorkerBaseURL))
	if workerBaseURL == "" {
		return nil, errors.New("missing worker base URL")
	}

	targetURL := workerBaseURL + "/api/internal/billing/access"
	forwardReq, err := http.NewRequest(http.MethodGet, targetURL, nil)
	if err != nil {
		return nil, err
	}
	forwardReq.Header.Set("x-sandbox-secret", s.cfg.SandboxProxySecret)
	forwardReq.Header.Set("x-chiridion-org-id", threadContext.OrgID)
	forwardReq.Header.Set("x-chiridion-workspace-id", threadContext.WorkspaceID)
	if threadContext.UserID != "" {
		forwardReq.Header.Set("x-chiridion-user-id", threadContext.UserID)
	}
	if threadContext.ThreadID != "" {
		forwardReq.Header.Set("x-chiridion-thread-id", threadContext.ThreadID)
	}

	resp, err := s.httpClient.Do(forwardReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("billing access returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var snapshot BillingAccessSnapshot
	if err := json.NewDecoder(resp.Body).Decode(&snapshot); err != nil {
		return nil, err
	}
	return &snapshot, nil
}

func (s *Server) checkOrgBillingAccess(threadContext *ProxyThreadContext, billingSource string, model string) BillingAccessDecision {
	decision := BillingAccessDecision{
		BillingSource:    billingSource,
		CreditChargeable: false,
	}

	snapshot, err := s.fetchBillingAccessSnapshot(threadContext)
	if err != nil {
		log.Printf("[SandboxHost] billing check failed org=%s thread=%s error=%v (allowing request)",
			threadContext.OrgID, threadContext.ThreadID, err)
		return decision
	}
	if snapshot == nil {
		if billingSource == billingSourceBYOK {
			return decision
		}
		decision.Denied = true
		decision.StatusCode = http.StatusPaymentRequired
		decision.Message = "Hosted model access is not active for this organization. Start a subscription or add your own API key in Settings -> AI Provider. Your workspace is saved."
		return decision
	}

	switch snapshot.BillingStatus {
	case "enterprise":
		return decision
	case "trialing":
		if billingSource == billingSourceBYOK {
			return decision
		}
		return s.checkCreditBalance(threadContext, snapshot, decision, "Trial hosted-model credits are used up.")
	case "active":
		if billingSource == billingSourceBYOK {
			return decision
		}
		return s.checkCreditBalance(threadContext, snapshot, decision, "Hosted model credits are used up.")
	case "past_due":
		decision.Denied = true
		decision.StatusCode = http.StatusPaymentRequired
		decision.Message = "Your subscription is past due. Update payment details in Settings -> Billing or add your own API key in Settings -> AI Provider to continue. Your workspace is saved."
		return decision
	case "canceled":
		decision.Denied = true
		decision.StatusCode = http.StatusPaymentRequired
		decision.Message = "Your subscription was canceled. Start a new subscription in Settings -> Billing or add your own API key in Settings -> AI Provider to continue. Your workspace is saved."
		return decision
	default:
		if billingSource == billingSourceBYOK {
			return decision
		}
		decision.Denied = true
		decision.StatusCode = http.StatusPaymentRequired
		decision.Message = "Hosted models require billing access. Start a subscription or add your own API key in Settings -> AI Provider. Your workspace is saved."
		return decision
	}
}

func formatCreditCents(cents int64) string {
	if cents < 0 {
		cents = 0
	}
	return fmt.Sprintf("%.2f credits", float64(cents)/100)
}

func (s *Server) checkCreditBalance(threadContext *ProxyThreadContext, snapshot *BillingAccessSnapshot, decision BillingAccessDecision, deniedMessage string) BillingAccessDecision {
	sum, err := s.usage.GetCreditChargeableUsageLogSum(
		threadContext.OrgID,
		0,
		time.Now().UnixMilli(),
	)
	if err != nil {
		log.Printf("[SandboxHost] billing credit usage sum failed org=%s thread=%s error=%v (allowing request)",
			threadContext.OrgID, threadContext.ThreadID, err)
		return decision
	}

	spentCents := int64(math.Round(sum.TotalCostUSD * 100))
	totalCreditsCents := snapshot.BillingCreditPurchaseTotalCents + snapshot.BillingCreditGrantTotalCents
	if totalCreditsCents-spentCents > 0 {
		decision.CreditChargeable = true
		return decision
	}
	decision.Denied = true
	decision.StatusCode = http.StatusPaymentRequired
	decision.Message = fmt.Sprintf("%s You have used %s of %s. Buy credits or manage your subscription in Settings -> Billing, or add your own API key in Settings -> AI Provider. Your workspace is saved.",
		deniedMessage,
		formatCreditCents(spentCents),
		formatCreditCents(totalCreditsCents),
	)
	return decision
}

// recordUsage persists token usage and cost to the state store.
func (s *Server) recordUsage(tc *ProxyThreadContext, provider string, billingSource string, creditChargeable bool, usage UsageTokens, durationMs int64) {
	costUSD := usage.CostUSD()

	record := state.UsageRecord{
		OrgID:                    tc.OrgID,
		WorkspaceID:              tc.WorkspaceID,
		UserID:                   tc.UserID,
		ThreadID:                 tc.ThreadID,
		Model:                    usage.Model,
		Provider:                 provider,
		BillingSource:            billingSource,
		CreditChargeable:         creditChargeable,
		InputTokens:              usage.InputTokens,
		OutputTokens:             usage.OutputTokens,
		CacheCreationInputTokens: usage.CacheCreationInputTokens,
		CacheReadInputTokens:     usage.CacheReadInputTokens,
		CostUSD:                  costUSD,
		DurationMs:               durationMs,
	}

	if err := s.usage.RecordUsage(record); err != nil {
		log.Printf("[SandboxHost] failed to record usage org=%s thread=%s model=%s cost=%.6f error=%v",
			tc.OrgID, tc.ThreadID, usage.Model, costUSD, err)
		return
	}

	s.trace("usage_recorded", map[string]any{
		"orgId":                    tc.OrgID,
		"workspaceId":              tc.WorkspaceID,
		"threadId":                 tc.ThreadID,
		"userId":                   tc.UserID,
		"model":                    usage.Model,
		"provider":                 provider,
		"billingSource":            billingSource,
		"creditChargeable":         creditChargeable,
		"inputTokens":              usage.InputTokens,
		"outputTokens":             usage.OutputTokens,
		"cacheCreationInputTokens": usage.CacheCreationInputTokens,
		"cacheReadInputTokens":     usage.CacheReadInputTokens,
		"costUSD":                  costUSD,
		"durationMs":               durationMs,
	})
}

// forwardClaudeToAnthropicDirect handles BYOK Anthropic requests by
// forwarding to api.anthropic.com with the org's API key. Pure passthrough —
// no body parsing or transformation needed.
func (s *Server) forwardClaudeToAnthropicDirect(
	w http.ResponseWriter,
	req *http.Request,
	proxy ProxyRoute,
	threadContext *ProxyThreadContext,
	caller *container.ContainerRecord,
	requestID string,
	startedAt time.Time,
) {
	claudeEndpoint := strings.TrimPrefix(
		strings.Replace(proxy.UpstreamPath, "/api/claude/", "/", 1),
		"/",
	)
	isMessagesEndpoint := strings.Contains(claudeEndpoint, "messages") && !strings.Contains(claudeEndpoint, "count_tokens")
	billingDecision := BillingAccessDecision{BillingSource: billingSourceBYOK}
	if req.Method == http.MethodPost && isMessagesEndpoint {
		billingDecision = s.checkOrgBillingAccess(threadContext, billingSourceBYOK, "")
		if billingDecision.Denied {
			errorJSON(w, billingDecision.Message, billingDecision.StatusCode)
			return
		}
	}

	rawBody, err := io.ReadAll(req.Body)
	if err != nil {
		errorJSON(w, "Failed to read request body", http.StatusBadRequest)
		return
	}

	targetURL := "https://api.anthropic.com" + strings.Replace(proxy.UpstreamPath, "/api/claude", "", 1)

	forwardReq, err := http.NewRequestWithContext(req.Context(), req.Method, targetURL, bytes.NewReader(rawBody))
	if err != nil {
		errorJSON(w, "Failed to create Anthropic request", http.StatusInternalServerError)
		return
	}

	// Copy all Anthropic headers, replace auth.
	forwardReq.Header = cloneHeaders(req.Header)
	forwardReq.Header.Set("x-api-key", threadContext.ByokAnthropicKey)
	applyStreamingRequestHeaders(forwardReq.Header)

	proxyTag := fmt.Sprintf("proxy:%s:%s", req.Method, proxy.UpstreamPath)
	s.containers.AddProxyRequest(threadContext.ContainerName, proxyTag)

	resp, upstreamErr := s.httpClient.Do(forwardReq)
	durationMs := time.Since(startedAt).Milliseconds()
	if upstreamErr != nil {
		s.containers.RemoveProxyRequest(threadContext.ContainerName, proxyTag, 0, durationMs)
		log.Printf("[SandboxHost] BYOK Anthropic proxy failed thread=%s durationMs=%d error=%v",
			threadContext.ThreadID, durationMs, upstreamErr)
		errorJSON(w, "Anthropic upstream unavailable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	s.containers.RemoveProxyRequest(threadContext.ContainerName, proxyTag, resp.StatusCode, durationMs)

	copyHeaders(w.Header(), resp.Header)
	applyStreamingResponseHeaders(w.Header(), w.Header().Get("Content-Type"))
	w.WriteHeader(resp.StatusCode)
	streaming := isStreamingContentType(resp.Header.Get("Content-Type"))
	usage, err := copyResponseBodyWithUsage(w, resp.Body, streaming)
	if err != nil && !errors.Is(err, context.Canceled) {
		s.trace("byok_anthropic_direct_copy_error", map[string]any{
			"requestId":       requestID,
			"callerContainer": caller.Name,
			"threadId":        threadContext.ThreadID,
			"error":           err.Error(),
		})
	}
	if usage.Model == "" {
		usage.Model = extractModelFromRequestBody(rawBody)
	}
	if isMessagesEndpoint && resp.StatusCode < 400 && usage.HasBillableTokens() {
		go s.recordUsage(threadContext, "anthropic", billingDecision.BillingSource, billingDecision.CreditChargeable, usage, durationMs)
	}
}

// forwardClaudeToOpenRouterDirect handles OpenRouter BYOK requests through
// OpenRouter's Anthropic-compatible Messages API.
func (s *Server) forwardClaudeToOpenRouterDirect(
	w http.ResponseWriter,
	req *http.Request,
	proxy ProxyRoute,
	threadContext *ProxyThreadContext,
	caller *container.ContainerRecord,
	requestID string,
	startedAt time.Time,
) {
	claudeEndpoint := strings.TrimPrefix(
		strings.Replace(proxy.UpstreamPath, "/api/claude/", "/", 1),
		"/",
	)
	isMessagesEndpoint := strings.Contains(claudeEndpoint, "messages") && !strings.Contains(claudeEndpoint, "count_tokens")
	billingDecision := BillingAccessDecision{BillingSource: billingSourceBYOK}
	if req.Method == http.MethodPost && isMessagesEndpoint {
		billingDecision = s.checkOrgBillingAccess(threadContext, billingSourceBYOK, "")
		if billingDecision.Denied {
			errorJSON(w, billingDecision.Message, billingDecision.StatusCode)
			return
		}
	}

	rawBody, err := io.ReadAll(req.Body)
	if err != nil {
		errorJSON(w, "Failed to read request body", http.StatusBadRequest)
		return
	}
	forwardBody := rewriteClaudeRequestBodyForOpenRouter(rawBody)

	targetURL := "https://openrouter.ai/api" + strings.Replace(proxy.UpstreamPath, "/api/claude", "", 1)
	forwardReq, err := http.NewRequestWithContext(req.Context(), req.Method, targetURL, bytes.NewReader(forwardBody))
	if err != nil {
		errorJSON(w, "Failed to create OpenRouter request", http.StatusInternalServerError)
		return
	}

	forwardReq.Header = cloneHeaders(req.Header)
	forwardReq.Header.Del("x-api-key")
	forwardReq.Header.Set("Authorization", "Bearer "+threadContext.ByokOpenRouterKey)
	applyOpenRouterAttributionHeaders(forwardReq.Header)
	applyStreamingRequestHeaders(forwardReq.Header)

	proxyTag := fmt.Sprintf("proxy:%s:%s", req.Method, proxy.UpstreamPath)
	s.containers.AddProxyRequest(threadContext.ContainerName, proxyTag)

	resp, upstreamErr := s.httpClient.Do(forwardReq)
	durationMs := time.Since(startedAt).Milliseconds()
	if upstreamErr != nil {
		s.containers.RemoveProxyRequest(threadContext.ContainerName, proxyTag, 0, durationMs)
		log.Printf("[SandboxHost] BYOK OpenRouter Anthropic proxy failed thread=%s durationMs=%d error=%v",
			threadContext.ThreadID, durationMs, upstreamErr)
		errorJSON(w, "OpenRouter upstream unavailable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	s.containers.RemoveProxyRequest(threadContext.ContainerName, proxyTag, resp.StatusCode, durationMs)

	copyHeaders(w.Header(), resp.Header)
	applyStreamingResponseHeaders(w.Header(), w.Header().Get("Content-Type"))
	w.WriteHeader(resp.StatusCode)
	streaming := isStreamingContentType(resp.Header.Get("Content-Type"))
	usage, err := copyResponseBodyWithUsage(w, resp.Body, streaming)
	if err != nil && !errors.Is(err, context.Canceled) {
		s.trace("byok_openrouter_anthropic_direct_copy_error", map[string]any{
			"requestId":       requestID,
			"callerContainer": caller.Name,
			"threadId":        threadContext.ThreadID,
			"error":           err.Error(),
		})
	}
	if usage.Model == "" {
		usage.Model = extractModelFromRequestBody(rawBody)
	}
	if isMessagesEndpoint && resp.StatusCode < 400 && usage.HasBillableTokens() {
		go s.recordUsage(threadContext, "openrouter", billingDecision.BillingSource, billingDecision.CreditChargeable, usage, durationMs)
	}
}

// forwardClaudeToOpenRouterGateway handles hosted Anthropic-compatible Claude
// requests through the OpenRouter provider configured on Cloudflare AI Gateway.
func (s *Server) forwardClaudeToOpenRouterGateway(
	w http.ResponseWriter,
	req *http.Request,
	proxy ProxyRoute,
	threadContext *ProxyThreadContext,
	caller *container.ContainerRecord,
	requestID string,
	startedAt time.Time,
) {
	claudeEndpoint := strings.TrimPrefix(
		strings.Replace(proxy.UpstreamPath, "/api/claude/", "/", 1),
		"/",
	)
	isMessagesEndpoint := strings.Contains(claudeEndpoint, "messages") && !strings.Contains(claudeEndpoint, "count_tokens")
	billingDecision := BillingAccessDecision{BillingSource: billingSourceHosted}

	rawBody, err := io.ReadAll(req.Body)
	if err != nil {
		errorJSON(w, "Failed to read request body", http.StatusBadRequest)
		return
	}
	if req.Method == http.MethodPost && isMessagesEndpoint {
		billingDecision = s.checkOrgBillingAccess(threadContext, billingSourceHosted, extractModelFromRequestBody(rawBody))
		if billingDecision.Denied {
			errorJSON(w, billingDecision.Message, billingDecision.StatusCode)
			return
		}
	}
	forwardBody := rewriteClaudeRequestBodyForOpenRouter(rawBody)

	targetURL := s.cfg.AIGatewayBaseURL + "/openrouter" + strings.Replace(proxy.UpstreamPath, "/api/claude", "", 1)
	if req.URL.RawQuery != "" {
		targetURL += "?" + req.URL.RawQuery
	}
	forwardReq, err := http.NewRequestWithContext(req.Context(), req.Method, targetURL, bytes.NewReader(forwardBody))
	if err != nil {
		errorJSON(w, "Failed to create OpenRouter request", http.StatusInternalServerError)
		return
	}

	headers := sanitizeGatewayUpstreamHeaders(req.Header)
	headers.Set("cf-aig-authorization", "Bearer "+s.cfg.AIGatewayToken)
	headers.Set("cf-aig-metadata", buildAIGatewayMetadata(threadContext))
	applyOpenRouterAttributionHeaders(headers)
	applyStreamingRequestHeaders(headers)
	forwardReq.Header = headers

	proxyTag := fmt.Sprintf("proxy:%s:%s", req.Method, proxy.UpstreamPath)
	s.trace("gateway_openrouter_claude_proxy_start", map[string]any{
		"requestId":       requestID,
		"callerContainer": caller.Name,
		"method":          req.Method,
		"threadId":        threadContext.ThreadID,
		"targetPath":      "/openrouter" + strings.Replace(proxy.UpstreamPath, "/api/claude", "", 1),
	})
	s.containers.AddProxyRequest(threadContext.ContainerName, proxyTag)

	resp, upstreamErr := s.httpClient.Do(forwardReq)
	durationMs := time.Since(startedAt).Milliseconds()
	if upstreamErr != nil {
		s.trace("gateway_openrouter_claude_proxy_error", map[string]any{
			"requestId":       requestID,
			"callerContainer": caller.Name,
			"method":          req.Method,
			"threadId":        threadContext.ThreadID,
			"durationMs":      durationMs,
			"error":           upstreamErr.Error(),
		})
		s.containers.RemoveProxyRequest(threadContext.ContainerName, proxyTag, 0, durationMs)
		errorJSON(w, "OpenRouter upstream unavailable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	s.trace("gateway_openrouter_claude_proxy_complete", map[string]any{
		"requestId":       requestID,
		"callerContainer": caller.Name,
		"method":          req.Method,
		"threadId":        threadContext.ThreadID,
		"status":          resp.StatusCode,
		"durationMs":      durationMs,
	})
	s.containers.RemoveProxyRequest(threadContext.ContainerName, proxyTag, resp.StatusCode, durationMs)

	copyHeaders(w.Header(), resp.Header)
	applyStreamingResponseHeaders(w.Header(), w.Header().Get("Content-Type"))
	w.WriteHeader(resp.StatusCode)
	streaming := isStreamingContentType(resp.Header.Get("Content-Type"))
	usage, err := copyResponseBodyWithUsage(w, resp.Body, streaming)
	if err != nil && !errors.Is(err, context.Canceled) {
		s.trace("gateway_openrouter_claude_proxy_copy_error", map[string]any{
			"requestId":       requestID,
			"callerContainer": caller.Name,
			"threadId":        threadContext.ThreadID,
			"error":           err.Error(),
		})
	}
	if usage.Model == "" {
		usage.Model = extractModelFromRequestBody(forwardBody)
	}
	if isMessagesEndpoint && resp.StatusCode < 400 && usage.HasBillableTokens() {
		go s.recordUsage(threadContext, "openrouter", billingDecision.BillingSource, billingDecision.CreditChargeable, usage, durationMs)
	}
}

func rewriteClaudeRequestBodyForOpenRouter(rawBody []byte) []byte {
	if len(rawBody) == 0 {
		return rawBody
	}

	var body map[string]any
	if err := json.Unmarshal(rawBody, &body); err != nil {
		return rawBody
	}
	model, ok := body["model"].(string)
	if !ok {
		return rawBody
	}
	openRouterModel := openRouterClaudeModel(model)
	if openRouterModel == model {
		return rawBody
	}
	body["model"] = openRouterModel
	rewritten, err := json.Marshal(body)
	if err != nil {
		return rawBody
	}
	return rewritten
}

func openRouterClaudeModel(model string) string {
	switch strings.ToLower(strings.TrimSpace(model)) {
	case "sonnet":
		return "anthropic/claude-sonnet-4.6"
	case "haiku":
		return "anthropic/claude-haiku-4.5"
	case "opus":
		return "anthropic/claude-opus-4.6"
	case "claude-sonnet-4-6":
		return "anthropic/claude-sonnet-4.6"
	case "claude-opus-4-6":
		return "anthropic/claude-opus-4.6"
	case "claude-sonnet-4-5-20250929":
		return "anthropic/claude-sonnet-4.5"
	case "claude-haiku-4-5-20251001":
		return "anthropic/claude-haiku-4.5"
	case "claude-opus-4-5-20251101":
		return "anthropic/claude-opus-4.5"
	case "claude-sonnet-4-20250514":
		return "anthropic/claude-sonnet-4"
	case "claude-opus-4-20250514":
		return "anthropic/claude-opus-4"
	case "claude-3-7-sonnet-20250219":
		return "anthropic/claude-3.7-sonnet"
	case "claude-3-5-sonnet-20241022", "claude-3-5-sonnet-20240620":
		return "anthropic/claude-3.5-sonnet"
	case "claude-3-5-haiku-20241022":
		return "anthropic/claude-3.5-haiku"
	default:
		return model
	}
}

// forwardClaudeToBedrockDirect handles BYOK Bedrock requests by calling
// the Bedrock invoke-with-response-stream endpoint directly using the
// org's bearer token (bypasses AI Gateway).
func (s *Server) forwardClaudeToBedrockDirect(
	w http.ResponseWriter,
	req *http.Request,
	proxy ProxyRoute,
	threadContext *ProxyThreadContext,
	caller *container.ContainerRecord,
	requestID string,
	startedAt time.Time,
) {
	billingDecision := BillingAccessDecision{BillingSource: billingSourceBYOK}
	if req.Method == http.MethodPost {
		billingDecision = s.checkOrgBillingAccess(threadContext, billingSourceBYOK, "")
		if billingDecision.Denied {
			errorJSON(w, billingDecision.Message, billingDecision.StatusCode)
			return
		}
	}

	rawBody, err := io.ReadAll(req.Body)
	if err != nil {
		errorJSON(w, "Failed to read request body", http.StatusBadRequest)
		return
	}

	var bodyJSON map[string]any
	if len(rawBody) > 0 {
		if err := json.Unmarshal(rawBody, &bodyJSON); err != nil {
			errorJSON(w, "Invalid JSON body", http.StatusBadRequest)
			return
		}
	}

	modelStr, _ := bodyJSON["model"].(string)
	if modelStr == "" {
		errorJSON(w, "Missing model in request body", http.StatusBadRequest)
		return
	}
	bedrockModel := mapToBedrockModel(modelStr)

	isStreaming, _ := bodyJSON["stream"].(bool)
	endpoint := "invoke"
	if isStreaming {
		endpoint = "invoke-with-response-stream"
	}

	region := threadContext.ByokBedrockRegion
	if region == "" {
		region = "us-east-1"
	}

	targetURL := fmt.Sprintf("https://bedrock-runtime.%s.amazonaws.com/model/%s/%s",
		region, bedrockModel, endpoint)

	bedrockBody := map[string]any{
		"anthropic_version": "bedrock-2023-05-31",
	}
	for key, val := range bodyJSON {
		if key != "model" && key != "stream" {
			bedrockBody[key] = val
		}
	}

	if betaHeader := req.Header.Get("anthropic-beta"); betaHeader != "" {
		var betas []string
		for _, b := range strings.Split(betaHeader, ",") {
			b = strings.TrimSpace(b)
			if b != "" {
				betas = append(betas, b)
			}
		}
		if len(betas) > 0 {
			bedrockBody["anthropic_beta"] = betas
		}
	}

	payload, err := json.Marshal(bedrockBody)
	if err != nil {
		errorJSON(w, "Failed to build Bedrock payload", http.StatusInternalServerError)
		return
	}

	forwardReq, err := http.NewRequestWithContext(req.Context(), http.MethodPost, targetURL, bytes.NewReader(payload))
	if err != nil {
		errorJSON(w, "Failed to create Bedrock request", http.StatusInternalServerError)
		return
	}

	forwardReq.Header.Set("Content-Type", "application/json")
	forwardReq.Header.Set("Authorization", "Bearer "+threadContext.ByokBedrockToken)
	applyStreamingRequestHeaders(forwardReq.Header)

	s.trace("byok_bedrock_direct_start", map[string]any{
		"requestId":       requestID,
		"callerContainer": caller.Name,
		"method":          req.Method,
		"threadId":        threadContext.ThreadID,
		"model":           modelStr,
		"bedrockModel":    bedrockModel,
		"region":          region,
		"streaming":       isStreaming,
	})
	s.containers.AddProxyRequest(threadContext.ContainerName, fmt.Sprintf("proxy:%s:%s", req.Method, proxy.UpstreamPath))

	resp, upstreamErr := s.httpClient.Do(forwardReq)
	durationMs := time.Since(startedAt).Milliseconds()
	if upstreamErr != nil {
		s.trace("byok_bedrock_direct_error", map[string]any{
			"requestId":       requestID,
			"callerContainer": caller.Name,
			"threadId":        threadContext.ThreadID,
			"durationMs":      durationMs,
			"error":           upstreamErr.Error(),
		})
		s.containers.RemoveProxyRequest(threadContext.ContainerName, fmt.Sprintf("proxy:%s:%s", req.Method, proxy.UpstreamPath), 0, durationMs)
		log.Printf("[SandboxHost] BYOK Bedrock direct proxy failed thread=%s container=%s durationMs=%d error=%v",
			threadContext.ThreadID, threadContext.ContainerName, durationMs, upstreamErr)
		errorJSON(w, "Bedrock upstream unavailable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	s.trace("byok_bedrock_direct_complete", map[string]any{
		"requestId":       requestID,
		"callerContainer": caller.Name,
		"threadId":        threadContext.ThreadID,
		"status":          resp.StatusCode,
		"durationMs":      durationMs,
		"model":           modelStr,
		"bedrockModel":    bedrockModel,
	})
	s.containers.RemoveProxyRequest(threadContext.ContainerName, fmt.Sprintf("proxy:%s:%s", req.Method, proxy.UpstreamPath), resp.StatusCode, durationMs)

	if isStreaming && resp.StatusCode == http.StatusOK {
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		applyStreamingResponseHeaders(w.Header(), "text/event-stream")
		w.WriteHeader(resp.StatusCode)
		usage, err := copyBedrockStreamToSSEWithUsage(w, resp.Body)
		if err != nil {
			if !errors.Is(err, context.Canceled) {
				s.trace("byok_bedrock_direct_copy_error", map[string]any{
					"requestId":       requestID,
					"callerContainer": caller.Name,
					"threadId":        threadContext.ThreadID,
					"error":           err.Error(),
				})
			}
		}
		if usage.Model == "" {
			usage.Model = modelStr
		}
		if resp.StatusCode < 400 && usage.HasBillableTokens() {
			go s.recordUsage(threadContext, "bedrock", billingDecision.BillingSource, billingDecision.CreditChargeable, usage, durationMs)
		}
	} else {
		copyHeaders(w.Header(), resp.Header)
		applyStreamingResponseHeaders(w.Header(), w.Header().Get("Content-Type"))
		w.WriteHeader(resp.StatusCode)
		usage, err := copyNonStreamingWithUsage(w, resp.Body)
		if err != nil {
			if !errors.Is(err, context.Canceled) {
				s.trace("byok_bedrock_direct_copy_error", map[string]any{
					"requestId":       requestID,
					"callerContainer": caller.Name,
					"threadId":        threadContext.ThreadID,
					"error":           err.Error(),
				})
			}
		}
		if usage.Model == "" {
			usage.Model = modelStr
		}
		if resp.StatusCode < 400 && usage.HasBillableTokens() {
			go s.recordUsage(threadContext, "bedrock", billingDecision.BillingSource, billingDecision.CreditChargeable, usage, durationMs)
		}
	}
}

func (s *Server) forwardOpenAIToAIGateway(
	w http.ResponseWriter,
	req *http.Request,
	proxy ProxyRoute,
	threadContext *ProxyThreadContext,
	caller *container.ContainerRecord,
	requestID string,
	startedAt time.Time,
) {
	// Map /api/openai/v1/* or /api/openrouter/v1/* -> /openrouter/*.
	// BYOK routes bypass this function.
	_, normalizedPath, ok := openAICompatibleProxyPath(proxy.UpstreamPath)
	if !ok {
		errorJSON(w, "Invalid OpenAI proxy path", http.StatusBadRequest)
		return
	}
	billingDecision := BillingAccessDecision{BillingSource: billingSourceHosted}

	gatewayProvider := "openrouter"
	requestModel := ""
	var err error
	var rawBody []byte
	var forwardBody io.Reader = req.Body
	if req.Method == http.MethodPost {
		rawBody, err = io.ReadAll(req.Body)
		if err != nil {
			errorJSON(w, "Failed to read request body", http.StatusBadRequest)
			return
		}
		requestModel = extractModelFromRequestBody(rawBody)
		rawBody = ensureOpenAIStreamingUsage(rawBody, normalizedPath)
		forwardBody = bytes.NewReader(rawBody)
		billingDecision = s.checkOrgBillingAccess(threadContext, billingSourceHosted, requestModel)
		if billingDecision.Denied {
			errorJSON(w, billingDecision.Message, billingDecision.StatusCode)
			return
		}
	}

	targetURL := s.cfg.AIGatewayBaseURL + "/" + gatewayProvider + normalizedPath
	if req.URL.RawQuery != "" {
		targetURL += "?" + req.URL.RawQuery
	}

	forwardReq, err := http.NewRequestWithContext(req.Context(), req.Method, targetURL, forwardBody)
	if err != nil {
		errorJSON(w, "Failed to create gateway request", http.StatusInternalServerError)
		return
	}

	headers := sanitizeGatewayUpstreamHeaders(req.Header)
	headers.Set("cf-aig-authorization", "Bearer "+s.cfg.AIGatewayToken)
	headers.Set("cf-aig-metadata", buildAIGatewayMetadata(threadContext))
	applyOpenRouterAttributionHeaders(headers)
	applyStreamingRequestHeaders(headers)
	forwardReq.Header = headers

	s.trace("gateway_openai_proxy_start", map[string]any{
		"requestId":       requestID,
		"callerContainer": caller.Name,
		"method":          req.Method,
		"threadId":        threadContext.ThreadID,
		"targetPath":      "/" + gatewayProvider + normalizedPath,
	})
	s.containers.AddProxyRequest(threadContext.ContainerName, fmt.Sprintf("proxy:%s:%s", req.Method, proxy.UpstreamPath))

	resp, upstreamErr := s.httpClient.Do(forwardReq)
	durationMs := time.Since(startedAt).Milliseconds()
	if upstreamErr != nil {
		s.trace("gateway_openai_proxy_error", map[string]any{
			"requestId":       requestID,
			"callerContainer": caller.Name,
			"method":          req.Method,
			"threadId":        threadContext.ThreadID,
			"durationMs":      durationMs,
			"error":           upstreamErr.Error(),
		})
		s.containers.RemoveProxyRequest(threadContext.ContainerName, fmt.Sprintf("proxy:%s:%s", req.Method, proxy.UpstreamPath), 0, durationMs)
		log.Printf("[SandboxHost] AI Gateway OpenAI proxy failed method=%s thread=%s container=%s durationMs=%d error=%v",
			req.Method, threadContext.ThreadID, threadContext.ContainerName, durationMs, upstreamErr)
		errorJSON(w, "AI Gateway upstream unavailable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	s.trace("gateway_openai_proxy_complete", map[string]any{
		"requestId":       requestID,
		"callerContainer": caller.Name,
		"method":          req.Method,
		"threadId":        threadContext.ThreadID,
		"status":          resp.StatusCode,
		"durationMs":      durationMs,
	})
	s.containers.RemoveProxyRequest(threadContext.ContainerName, fmt.Sprintf("proxy:%s:%s", req.Method, proxy.UpstreamPath), resp.StatusCode, durationMs)

	copyHeaders(w.Header(), resp.Header)
	applyStreamingResponseHeaders(w.Header(), resp.Header.Get("Content-Type"))
	w.WriteHeader(resp.StatusCode)
	streaming := isStreamingContentType(resp.Header.Get("Content-Type"))
	usage, err := copyResponseBodyWithUsage(w, resp.Body, streaming)
	if err != nil {
		if !errors.Is(err, context.Canceled) {
			s.trace("gateway_openai_proxy_copy_error", map[string]any{
				"requestId":       requestID,
				"callerContainer": caller.Name,
				"threadId":        threadContext.ThreadID,
				"error":           err.Error(),
			})
		}
	}
	if usage.Model == "" {
		usage.Model = extractModelFromRequestBody(rawBody)
	}
	if resp.StatusCode < 400 && usage.HasBillableTokens() {
		go s.recordUsage(threadContext, "openrouter", billingDecision.BillingSource, billingDecision.CreditChargeable, usage, durationMs)
	}
}

func (s *Server) handleVirtualAIRoute(w http.ResponseWriter, req *http.Request) {
	if req.URL.Path != "/v1/virtual-ai/chat/completions" {
		errorJSON(w, "Not found", http.StatusNotFound)
		return
	}
	if req.Method != http.MethodPost {
		errorJSON(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.cfg.AIGatewayBaseURL == "" || strings.TrimSpace(s.cfg.AIGatewayToken) == "" {
		errorJSON(w, "AI Gateway is not configured", http.StatusServiceUnavailable)
		return
	}
	if expectedSecret := strings.TrimSpace(s.cfg.SandboxProxySecret); expectedSecret != "" &&
		req.Header.Get("x-sandbox-secret") != expectedSecret {
		errorJSON(w, "Unauthorized", http.StatusForbidden)
		return
	}

	threadContext := &ProxyThreadContext{
		OrgID:         strings.TrimSpace(req.Header.Get("x-chiridion-org-id")),
		WorkspaceID:   strings.TrimSpace(req.Header.Get("x-chiridion-workspace-id")),
		UserID:        strings.TrimSpace(req.Header.Get("x-chiridion-user-id")),
		ThreadID:      "virtual-ai",
		ContainerName: "virtual-ai",
		WorkerBaseURL: strings.TrimSpace(req.Header.Get("x-chiridion-worker-base-url")),
	}
	if threadContext.OrgID == "" || threadContext.WorkspaceID == "" {
		errorJSON(w, "Missing virtual AI tenant context", http.StatusBadRequest)
		return
	}

	startedAt := time.Now()
	rawBody, err := io.ReadAll(req.Body)
	if err != nil {
		errorJSON(w, "Failed to read request body", http.StatusBadRequest)
		return
	}

	requestModel := ""
	gatewayProvider := "compat"
	var bodyJSON map[string]any
	if len(rawBody) > 0 {
		if err := json.Unmarshal(rawBody, &bodyJSON); err != nil {
			errorJSON(w, "Invalid JSON body", http.StatusBadRequest)
			return
		}
	}
	if bodyJSON == nil {
		bodyJSON = make(map[string]any)
	}
	if model, _ := bodyJSON["model"].(string); model != "" {
		requestModel = model
	}
	resolved := resolveVirtualAIModel(requestModel)
	bodyJSON["model"] = resolved
	if isVirtualAIOpenRouterModel(resolved) {
		gatewayProvider = "openrouter"
	}
	ensureOpenAIStreamUsage(bodyJSON)
	rawBody, _ = json.Marshal(bodyJSON)
	provider := "openai"
	if gatewayProvider == "openrouter" {
		provider = "openrouter"
	}

	billingDecision := s.checkOrgBillingAccess(threadContext, billingSourceHosted, requestModel)
	log.Printf("[SandboxHost] virtual AI billing decision org=%s workspace=%s user=%s requestModel=%s resolvedModel=%s provider=%s billingSource=%s creditChargeable=%t denied=%t workerBaseURLSet=%t",
		threadContext.OrgID, threadContext.WorkspaceID, threadContext.UserID, requestModel, resolved, provider,
		billingDecision.BillingSource, billingDecision.CreditChargeable, billingDecision.Denied, threadContext.WorkerBaseURL != "")
	if billingDecision.Denied {
		errorJSON(w, billingDecision.Message, billingDecision.StatusCode)
		return
	}

	targetURL := s.cfg.AIGatewayBaseURL + "/" + gatewayProvider + "/chat/completions"
	if req.URL.RawQuery != "" {
		targetURL += "?" + req.URL.RawQuery
	}

	forwardReq, err := http.NewRequestWithContext(req.Context(), http.MethodPost, targetURL, bytes.NewReader(rawBody))
	if err != nil {
		errorJSON(w, "Failed to create gateway request", http.StatusInternalServerError)
		return
	}
	headers := sanitizeGatewayUpstreamHeaders(req.Header)
	headers.Set("cf-aig-authorization", "Bearer "+s.cfg.AIGatewayToken)
	headers.Set("cf-aig-metadata", buildAIGatewayMetadata(threadContext))
	if gatewayProvider == "openrouter" {
		applyOpenRouterAttributionHeaders(headers)
	}
	applyStreamingRequestHeaders(headers)
	forwardReq.Header = headers

	resp, upstreamErr := s.httpClient.Do(forwardReq)
	durationMs := time.Since(startedAt).Milliseconds()
	if upstreamErr != nil {
		log.Printf("[SandboxHost] virtual AI Gateway proxy failed org=%s workspace=%s durationMs=%d error=%v",
			threadContext.OrgID, threadContext.WorkspaceID, durationMs, upstreamErr)
		errorJSON(w, "AI Gateway upstream unavailable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	copyHeaders(w.Header(), resp.Header)
	applyStreamingResponseHeaders(w.Header(), resp.Header.Get("Content-Type"))
	w.WriteHeader(resp.StatusCode)

	streaming := isStreamingContentType(resp.Header.Get("Content-Type"))
	log.Printf("[SandboxHost] virtual AI Gateway response org=%s workspace=%s user=%s provider=%s status=%d contentType=%q streaming=%t durationMs=%d",
		threadContext.OrgID, threadContext.WorkspaceID, threadContext.UserID, provider, resp.StatusCode, resp.Header.Get("Content-Type"), streaming, durationMs)
	usage, err := copyResponseBodyWithUsage(w, resp.Body, streaming)
	if err != nil && !errors.Is(err, context.Canceled) {
		s.trace("virtual_ai_proxy_copy_error", map[string]any{
			"orgId":       threadContext.OrgID,
			"workspaceId": threadContext.WorkspaceID,
			"error":       err.Error(),
		})
	}
	if usage.Model == "" {
		usage.Model = extractModelFromRequestBody(rawBody)
	}
	costUSD := usage.CostUSD()
	log.Printf("[SandboxHost] virtual AI usage parsed org=%s workspace=%s user=%s requestModel=%s usageModel=%s provider=%s status=%d inputTokens=%d outputTokens=%d cacheCreationInputTokens=%d cacheReadInputTokens=%d billableTokens=%t costUSD=%.6f billingSource=%s creditChargeable=%t durationMs=%d copyError=%t",
		threadContext.OrgID, threadContext.WorkspaceID, threadContext.UserID, requestModel, usage.Model, provider, resp.StatusCode,
		usage.InputTokens, usage.OutputTokens, usage.CacheCreationInputTokens, usage.CacheReadInputTokens, usage.HasBillableTokens(), costUSD,
		billingDecision.BillingSource, billingDecision.CreditChargeable, durationMs, err != nil)
	if resp.StatusCode < 400 && usage.HasBillableTokens() {
		log.Printf("[SandboxHost] virtual AI recording usage org=%s workspace=%s user=%s model=%s provider=%s billingSource=%s creditChargeable=%t costUSD=%.6f",
			threadContext.OrgID, threadContext.WorkspaceID, threadContext.UserID, usage.Model, provider,
			billingDecision.BillingSource, billingDecision.CreditChargeable, costUSD)
		go s.recordUsage(threadContext, provider, billingDecision.BillingSource, billingDecision.CreditChargeable, usage, durationMs)
	} else {
		log.Printf("[SandboxHost] virtual AI usage not recorded org=%s workspace=%s user=%s status=%d billableTokens=%t copyError=%t",
			threadContext.OrgID, threadContext.WorkspaceID, threadContext.UserID, resp.StatusCode, usage.HasBillableTokens(), err != nil)
	}
}

func ensureOpenAIStreamUsage(body map[string]any) {
	stream, _ := body["stream"].(bool)
	if !stream {
		return
	}
	options, _ := body["stream_options"].(map[string]any)
	if options == nil {
		options = make(map[string]any)
	}
	options["include_usage"] = true
	body["stream_options"] = options
}

func resolveVirtualAIModel(model string) string {
	trimmed := strings.TrimSpace(model)
	switch trimmed {
	case "", "auto", "dynamic/auto":
		return "google/gemini-3-flash-preview"
	case "auto_search", "auto_image":
		return "dynamic/" + trimmed
	default:
		return trimmed
	}
}

func isVirtualAIOpenRouterModel(model string) bool {
	return !strings.HasPrefix(strings.TrimSpace(model), "dynamic/")
}

func (s *Server) forwardOpenAIDirect(
	w http.ResponseWriter,
	req *http.Request,
	proxy ProxyRoute,
	threadContext *ProxyThreadContext,
	caller *container.ContainerRecord,
	requestID string,
	startedAt time.Time,
) {
	s.forwardOpenAICompatibleDirect(w, req, proxy, threadContext, caller, requestID, startedAt, "https://api.openai.com", threadContext.ByokOpenAIKey, "openai")
}

func (s *Server) forwardOpenRouterDirect(
	w http.ResponseWriter,
	req *http.Request,
	proxy ProxyRoute,
	threadContext *ProxyThreadContext,
	caller *container.ContainerRecord,
	requestID string,
	startedAt time.Time,
) {
	s.forwardOpenAICompatibleDirect(w, req, proxy, threadContext, caller, requestID, startedAt, "https://openrouter.ai/api", threadContext.ByokOpenRouterKey, "openrouter")
}

func (s *Server) forwardOpenAICompatibleDirect(
	w http.ResponseWriter,
	req *http.Request,
	proxy ProxyRoute,
	threadContext *ProxyThreadContext,
	caller *container.ContainerRecord,
	requestID string,
	startedAt time.Time,
	upstreamBaseURL string,
	apiKey string,
	providerName string,
) {
	openaiPath, normalizedPath, ok := openAICompatibleProxyPath(proxy.UpstreamPath)
	if !ok {
		errorJSON(w, "Invalid OpenAI proxy path", http.StatusBadRequest)
		return
	}
	billingDecision := BillingAccessDecision{BillingSource: billingSourceBYOK}
	if req.Method == http.MethodPost {
		billingDecision = s.checkOrgBillingAccess(threadContext, billingSourceBYOK, "")
		if billingDecision.Denied {
			errorJSON(w, billingDecision.Message, billingDecision.StatusCode)
			return
		}
	}

	targetURL := strings.TrimRight(upstreamBaseURL, "/") + openaiPath
	if req.URL.RawQuery != "" {
		targetURL += "?" + req.URL.RawQuery
	}

	var err error
	var rawBody []byte
	var forwardBody io.Reader = req.Body
	if req.Method == http.MethodPost {
		rawBody, err = io.ReadAll(req.Body)
		if err != nil {
			errorJSON(w, "Failed to read request body", http.StatusBadRequest)
			return
		}
		rawBody = ensureOpenAIStreamingUsage(rawBody, normalizedPath)
		forwardBody = bytes.NewReader(rawBody)
	}

	forwardReq, err := http.NewRequestWithContext(req.Context(), req.Method, targetURL, forwardBody)
	if err != nil {
		errorJSON(w, "Failed to create OpenAI request", http.StatusInternalServerError)
		return
	}

	headers := sanitizeGatewayUpstreamHeaders(req.Header)
	headers.Set("Authorization", "Bearer "+apiKey)
	if providerName == "openrouter" {
		applyOpenRouterAttributionHeaders(headers)
	}
	applyStreamingRequestHeaders(headers)
	forwardReq.Header = headers

	s.trace("byok_openai_direct_start", map[string]any{
		"requestId":       requestID,
		"callerContainer": caller.Name,
		"method":          req.Method,
		"threadId":        threadContext.ThreadID,
		"targetPath":      openaiPath,
		"provider":        providerName,
	})
	s.containers.AddProxyRequest(threadContext.ContainerName, fmt.Sprintf("proxy:%s:%s", req.Method, proxy.UpstreamPath))

	resp, upstreamErr := s.httpClient.Do(forwardReq)
	durationMs := time.Since(startedAt).Milliseconds()
	if upstreamErr != nil {
		s.trace("byok_openai_direct_error", map[string]any{
			"requestId":       requestID,
			"callerContainer": caller.Name,
			"method":          req.Method,
			"threadId":        threadContext.ThreadID,
			"durationMs":      durationMs,
			"error":           upstreamErr.Error(),
		})
		s.containers.RemoveProxyRequest(threadContext.ContainerName, fmt.Sprintf("proxy:%s:%s", req.Method, proxy.UpstreamPath), 0, durationMs)
		errorJSON(w, "LLM provider upstream unavailable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	s.trace("byok_openai_direct_complete", map[string]any{
		"requestId":       requestID,
		"callerContainer": caller.Name,
		"method":          req.Method,
		"threadId":        threadContext.ThreadID,
		"status":          resp.StatusCode,
		"durationMs":      durationMs,
	})
	s.containers.RemoveProxyRequest(threadContext.ContainerName, fmt.Sprintf("proxy:%s:%s", req.Method, proxy.UpstreamPath), resp.StatusCode, durationMs)

	copyHeaders(w.Header(), resp.Header)
	applyStreamingResponseHeaders(w.Header(), resp.Header.Get("Content-Type"))
	w.WriteHeader(resp.StatusCode)
	streaming := isStreamingContentType(resp.Header.Get("Content-Type"))
	usage, err := copyResponseBodyWithUsage(w, resp.Body, streaming)
	if err != nil && !errors.Is(err, context.Canceled) {
		s.trace("byok_openai_direct_copy_error", map[string]any{
			"requestId":       requestID,
			"callerContainer": caller.Name,
			"threadId":        threadContext.ThreadID,
			"error":           err.Error(),
		})
	}
	if usage.Model == "" {
		usage.Model = extractModelFromRequestBody(rawBody)
	}
	if resp.StatusCode < 400 && usage.HasBillableTokens() {
		go s.recordUsage(threadContext, providerName, billingDecision.BillingSource, billingDecision.CreditChargeable, usage, durationMs)
	}
}

func sanitizeGatewayUpstreamHeaders(src http.Header) http.Header {
	headers := cloneHeaders(src)
	headers.Del("Host")
	headers.Del("Authorization")
	headers.Del("Content-Length")
	headers.Del("X-Sandbox-Secret")
	headers.Del("X-Chiridion-Org-Id")
	headers.Del("X-Chiridion-Workspace-Id")
	headers.Del("X-Chiridion-User-Id")
	headers.Del("X-Chiridion-Thread-Id")
	headers.Del("X-Chiridion-Worker-Base-Url")
	headers.Del("X-Api-Key")
	headers.Del("x-api-key")
	// Strip spoofable forwarding/proxy headers from sandbox callers
	headers.Del("X-Forwarded-For")
	headers.Del("X-Forwarded-Host")
	headers.Del("X-Forwarded-Proto")
	headers.Del("X-Real-Ip")
	headers.Del("Cf-Connecting-Ip")
	headers.Del("Forwarded")
	headers.Del("Via")
	return headers
}

func applyOpenRouterAttributionHeaders(headers http.Header) {
	if headers == nil {
		return
	}
	headers.Set("HTTP-Referer", openRouterAttributionReferer)
	headers.Set("X-OpenRouter-Title", openRouterAttributionTitle)
	headers.Set("X-OpenRouter-Categories", openRouterAttributionCategories)
}

// buildAIGatewayMetadata builds the cf-aig-metadata header for Cloudflare
// AI Gateway spend tracking and tenant attribution.
func buildAIGatewayMetadata(tc *ProxyThreadContext) string {
	userID := strings.TrimSpace(tc.UserID)
	uidParts := []string{tc.OrgID, tc.WorkspaceID}
	if userID != "" {
		uidParts = append(uidParts, userID)
	}
	uid := strings.Join(uidParts, ":")
	if tc.ThreadID != "" {
		uid = uid + ":" + tc.ThreadID
	}

	chiridion := map[string]string{
		"orgId":       tc.OrgID,
		"workspaceId": tc.WorkspaceID,
		"threadId":    tc.ThreadID,
	}
	if userID != "" {
		chiridion["userId"] = userID
	}

	payload := map[string]any{
		"uid":       uid,
		"chiridion": chiridion,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return `{"uid":"unknown"}`
	}
	return string(encoded)
}

// Bedrock model mapping (Anthropic model ID -> Bedrock model ID)
var bedrockModelMap = map[string]string{
	"claude-sonnet-4-5-20250929": "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
	"claude-haiku-4-5-20251001":  "global.anthropic.claude-haiku-4-5-20251001-v1:0",
	"claude-opus-4-5-20251101":   "global.anthropic.claude-opus-4-5-20251101-v1:0",
	"claude-sonnet-4-6":          "global.anthropic.claude-sonnet-4-6",
	"claude-opus-4-6":            "global.anthropic.claude-opus-4-6-v1",
	"claude-sonnet-4-20250514":   "global.anthropic.claude-sonnet-4-20250514-v1:0",
	"claude-opus-4-20250514":     "global.anthropic.claude-opus-4-20250514-v1:0",
	"claude-3-5-sonnet-20241022": "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
	"claude-3-5-haiku-20241022":  "us.anthropic.claude-3-5-haiku-20241022-v1:0",
}

func mapToBedrockModel(model string) string {
	if mapped, ok := bedrockModelMap[model]; ok {
		return mapped
	}
	m := strings.ToLower(model)
	if strings.Contains(m, "sonnet-4-6") || strings.Contains(m, "sonnet-4.6") {
		return "global.anthropic.claude-sonnet-4-6"
	}
	return "global.anthropic." + model + "-v1:0"
}

func ensureOpenAIStreamingUsage(rawBody []byte, normalizedPath string) []byte {
	if normalizedPath != "/chat/completions" {
		return rawBody
	}
	var bodyJSON map[string]any
	if len(rawBody) == 0 || json.Unmarshal(rawBody, &bodyJSON) != nil {
		return rawBody
	}
	if stream, _ := bodyJSON["stream"].(bool); !stream {
		return rawBody
	}

	streamOptions, _ := bodyJSON["stream_options"].(map[string]any)
	if streamOptions == nil {
		streamOptions = map[string]any{}
		bodyJSON["stream_options"] = streamOptions
	}
	if includeUsage, _ := streamOptions["include_usage"].(bool); includeUsage {
		return rawBody
	}
	streamOptions["include_usage"] = true

	nextBody, err := json.Marshal(bodyJSON)
	if err != nil {
		return rawBody
	}
	return nextBody
}

func (s *Server) resolveHostPiLoopbackProxyThread(threadID string, now time.Time) (threadKey string, threadContext *ProxyThreadContext, ok bool) {
	bridge := s.hostPiBridgeForThread(threadID)
	if bridge == nil {
		return "", nil, false
	}

	s.proxyMu.Lock()
	ctx := s.proxyThreads[bridge.threadKey]
	if ctx == nil || ctx.ThreadID != threadID {
		s.proxyMu.Unlock()
		return "", nil, false
	}

	ctx.ClosedAt = nil
	ctx.LastSeenAt = now
	ctx.ExpiresAt = now.Add(s.cfg.ProxyThreadActiveTTL)
	resolved := copyProxyThreadContext(ctx)
	s.proxyMu.Unlock()

	s.upsertProxyThreadState(resolved)
	return bridge.threadKey, resolved, true
}

func isInferenceProxyPath(upstreamPath string) bool {
	upstreamPath = strings.TrimSpace(upstreamPath)
	return upstreamPath == "/api/claude" ||
		strings.HasPrefix(upstreamPath, "/api/claude/") ||
		upstreamPath == "/api/openai" ||
		strings.HasPrefix(upstreamPath, "/api/openai/") ||
		upstreamPath == "/api/openrouter" ||
		strings.HasPrefix(upstreamPath, "/api/openrouter/")
}

func (s *Server) runProxyThreadCleanup() {
	ticker := time.NewTicker(s.cfg.ProxyThreadCleanupInterval)
	defer ticker.Stop()
	for range ticker.C {
		s.cleanupExpiredProxyThreads()
	}
}

func (s *Server) cleanupExpiredProxyThreads() {
	now := time.Now().UTC()
	removed := 0
	expiredKeys := make([]string, 0)

	s.proxyMu.Lock()
	for key, thread := range s.proxyThreads {
		if thread.ClosedAt == nil {
			continue
		}
		if thread.ExpiresAt.After(now) {
			continue
		}
		s.trace("proxy_thread_expired", map[string]any{
			"threadKey":   key,
			"container":   thread.ContainerName,
			"threadId":    thread.ThreadID,
			"orgId":       thread.OrgID,
			"workspaceId": thread.WorkspaceID,
			"createdAt":   thread.CreatedAt.UnixMilli(),
			"lastSeenAt":  thread.LastSeenAt.UnixMilli(),
			"closedAt":    nullableMillis(thread.ClosedAt),
			"expiredAt":   thread.ExpiresAt.UnixMilli(),
		})
		delete(s.proxyThreads, key)
		expiredKeys = append(expiredKeys, key)
		removed++
	}
	s.proxyMu.Unlock()
	for _, key := range expiredKeys {
		s.deleteProxyThreadState(key)
	}

	if removed > 0 {
		log.Printf("[SandboxHost] cleaned up %d expired proxy thread mapping(s)", removed)
	}
}

func (s *Server) loadProxyThreadsFromState() {
	if s.state == nil {
		return
	}

	records, err := s.state.LoadProxyThreads()
	if err != nil {
		log.Printf("[SandboxHost] failed to load persisted proxy threads: %v", err)
		return
	}

	now := time.Now().UTC()
	restored := 0

	s.proxyMu.Lock()
	for _, record := range records {
		// Restore open mappings regardless of ExpiresAt.
		// For closed mappings, only restore entries still within close-grace.
		if record.ClosedAt != nil && !record.ExpiresAt.After(now) {
			continue
		}
		s.proxyThreads[record.Key] = &ProxyThreadContext{
			Key:           record.Key,
			ContainerName: record.ContainerName,
			OrgID:         record.OrgID,
			WorkspaceID:   record.WorkspaceID,
			UserID:        record.UserID,
			ThreadID:      record.ThreadID,
			WorkerBaseURL: record.WorkerBaseURL,
			CreatedAt:     record.CreatedAt,
			LastSeenAt:    record.LastSeenAt,
			ExpiresAt:     record.ExpiresAt,
			ClosedAt:      record.ClosedAt,
		}
		restored++
	}
	s.proxyMu.Unlock()

	for _, record := range records {
		// Keep open mappings in durable state; only purge expired closed-grace mappings.
		if record.ClosedAt == nil {
			continue
		}
		if record.ExpiresAt.After(now) {
			continue
		}
		s.deleteProxyThreadState(record.Key)
	}

	if restored > 0 {
		log.Printf("[SandboxHost] restored %d proxy thread mapping(s) from state DB", restored)
	}
}

func (s *Server) upsertProxyThreadState(thread *ProxyThreadContext) {
	if s.state == nil || thread == nil {
		return
	}
	if err := s.state.UpsertProxyThread(state.ProxyThreadRecord{
		Key:           thread.Key,
		ContainerName: thread.ContainerName,
		OrgID:         thread.OrgID,
		WorkspaceID:   thread.WorkspaceID,
		UserID:        thread.UserID,
		ThreadID:      thread.ThreadID,
		WorkerBaseURL: thread.WorkerBaseURL,
		CreatedAt:     thread.CreatedAt.UTC(),
		LastSeenAt:    thread.LastSeenAt.UTC(),
		ExpiresAt:     thread.ExpiresAt.UTC(),
		ClosedAt:      thread.ClosedAt,
	}); err != nil {
		log.Printf("[SandboxHost] failed to persist proxy thread %s: %v", thread.Key, err)
	}
}

func (s *Server) deleteProxyThreadState(key string) {
	if s.state == nil || strings.TrimSpace(key) == "" {
		return
	}
	if err := s.state.DeleteProxyThread(key); err != nil {
		log.Printf("[SandboxHost] failed to delete proxy thread state for %s: %v", key, err)
	}
}

func (s *Server) proxyThreadCount() int {
	s.proxyMu.Lock()
	defer s.proxyMu.Unlock()
	return len(s.proxyThreads)
}

func (s *Server) handleFSError(w http.ResponseWriter, err error, fallback string) error {
	message := err.Error()
	lower := strings.ToLower(message)
	if strings.Contains(lower, "traversal") {
		errorJSON(w, message, http.StatusForbidden)
		return nil
	}
	if strings.Contains(lower, "no such file") || strings.Contains(lower, "not exist") {
		errorJSON(w, fallback, http.StatusNotFound)
		return nil
	}
	return err
}

func parseWorkspaceRoute(path string) (WorkspaceRoute, bool) {
	matches := workspaceRouteRegex.FindStringSubmatch(path)
	if len(matches) == 0 {
		return WorkspaceRoute{}, false
	}
	orgID, err := url.PathUnescape(matches[1])
	if err != nil {
		return WorkspaceRoute{}, false
	}
	workspaceID, err := url.PathUnescape(matches[2])
	if err != nil {
		return WorkspaceRoute{}, false
	}
	return WorkspaceRoute{
		Name:        sandboxName(workspaceID),
		OrgID:       orgID,
		WorkspaceID: workspaceID,
		Subpath:     matches[3],
	}, true
}

func parseProxyRoute(path string) (ProxyRoute, bool) {
	matches := proxyRouteRegex.FindStringSubmatch(path)
	if len(matches) == 0 {
		return ProxyRoute{}, false
	}
	threadID, err := url.PathUnescape(matches[1])
	if err != nil {
		return ProxyRoute{}, false
	}
	return ProxyRoute{ThreadID: threadID, UpstreamPath: firstNonEmpty(matches[2], "/")}, true
}

func parseHostPiInferenceRoute(path string) (ProxyRoute, bool) {
	matches := hostPiInferenceRouteRegex.FindStringSubmatch(path)
	if len(matches) == 0 {
		return ProxyRoute{}, false
	}
	threadID, err := url.PathUnescape(matches[1])
	if err != nil {
		return ProxyRoute{}, false
	}
	return ProxyRoute{ThreadID: threadID, UpstreamPath: firstNonEmpty(matches[2], "/")}, true
}

var workspaceRouteRegex = regexp.MustCompile(`^/v1/workspaces/([^/]+)/([^/]+)(/.*)?$`)
var proxyRouteRegex = regexp.MustCompile(`^/proxy/([^/]+)(/.*)?$`)
var hostPiInferenceRouteRegex = regexp.MustCompile(`^/internal/host-pi/inference/([^/]+)(/.*)?$`)
var cfAssetsUploadProxyRegex = regexp.MustCompile(`^/client/v4/accounts/[^/]+/workers/assets/upload$`)

func shouldPreserveAuthorization(upstreamPath string) bool {
	return cfAssetsUploadProxyRegex.MatchString(upstreamPath)
}

func sandboxName(workspaceID string) string {
	replacer := regexp.MustCompile(`[^a-zA-Z0-9_-]`)
	safeID := replacer.ReplaceAllString(workspaceID, "_")
	raw := "chiridion-ws-" + safeID

	normalized := strings.ToLower(raw)
	normalized = regexp.MustCompile(`[^a-z0-9-]`).ReplaceAllString(normalized, "-")
	normalized = regexp.MustCompile(`-+`).ReplaceAllString(normalized, "-")
	normalized = strings.Trim(normalized, "-")
	if normalized == "" {
		normalized = fmt.Sprintf("chiridion-%d", time.Now().UnixMilli())
	}
	if len(normalized) > 63 {
		normalized = normalized[:63]
	}
	return normalized
}

func normalizeWorkerBaseURL(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return ""
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return ""
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return ""
	}
	parsed.Path = ""
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return strings.TrimSuffix(parsed.String(), "/")
}

func proxyThreadKey(containerName, threadID string) string {
	return containerName + "::" + threadID
}

func copyProxyThreadContext(thread *ProxyThreadContext) *ProxyThreadContext {
	if thread == nil {
		return nil
	}
	cloned := *thread
	if thread.ClosedAt != nil {
		closedAt := *thread.ClosedAt
		cloned.ClosedAt = &closedAt
	}
	return &cloned
}

func requestSourceIP(req *http.Request) string {
	host, _, err := net.SplitHostPort(strings.TrimSpace(req.RemoteAddr))
	if err != nil {
		return strings.TrimSpace(req.RemoteAddr)
	}
	return host
}

func isLoopbackSourceIP(sourceIP string) bool {
	ip := net.ParseIP(strings.TrimSpace(sourceIP))
	if ip == nil {
		return false
	}
	if mapped := ip.To4(); mapped != nil {
		return mapped.IsLoopback()
	}
	return ip.IsLoopback()
}

func applyStreamingRequestHeaders(headers http.Header) {
	if headers == nil {
		return
	}
	headers.Set("Accept-Encoding", "identity")
	headers.Set("Cache-Control", "no-cache, no-transform")
	headers.Set("Pragma", "no-cache")
}

func applyStreamingResponseHeaders(headers http.Header, contentType string) {
	if headers == nil {
		return
	}
	if !isStreamingContentType(contentType) {
		return
	}
	headers.Set("Cache-Control", "no-cache, no-transform")
	headers.Set("X-Accel-Buffering", "no")
}

func isStreamingContentType(contentType string) bool {
	value := strings.ToLower(strings.TrimSpace(contentType))
	switch {
	case strings.Contains(value, "text/event-stream"):
		return true
	case strings.Contains(value, "application/x-ndjson"):
		return true
	case strings.Contains(value, "application/json-seq"):
		return true
	default:
		return false
	}
}

func copyResponseBody(w http.ResponseWriter, body io.Reader) error {
	if w == nil || body == nil {
		return nil
	}

	writer := io.Writer(w)
	if flusher, ok := w.(http.Flusher); ok {
		writer = &flushWriter{writer: w, flusher: flusher}
	}

	_, err := io.Copy(writer, body)
	return err
}

type flushWriter struct {
	writer  io.Writer
	flusher http.Flusher
}

// copyBedrockStreamToSSE converts Amazon EventStream binary frames to Anthropic SSE format.
func copyBedrockStreamToSSE(w http.ResponseWriter, body io.Reader) error {
	_, err := copyBedrockStreamToSSEWithUsage(w, body)
	return err
}

// copyBedrockStreamToSSEWithUsage converts a Bedrock eventstream to SSE while
// extracting Anthropic-format usage tokens from the decoded events.
func copyBedrockStreamToSSEWithUsage(w http.ResponseWriter, body io.Reader) (UsageTokens, error) {
	var usage UsageTokens
	if w == nil || body == nil {
		return usage, nil
	}

	flusher, _ := w.(http.Flusher)
	r := bufio.NewReader(body)

	for {
		var prelude [12]byte
		if _, err := io.ReadFull(r, prelude[:]); err != nil {
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				return usage, nil
			}
			return usage, err
		}

		totalLen := binary.BigEndian.Uint32(prelude[0:4])
		headersLen := binary.BigEndian.Uint32(prelude[4:8])
		if totalLen < 16 {
			continue
		}

		remaining := make([]byte, totalLen-12)
		if _, err := io.ReadFull(r, remaining); err != nil {
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				return usage, nil
			}
			return usage, err
		}

		payloadStart := headersLen
		payloadEnd := uint32(len(remaining)) - 4
		if payloadStart >= payloadEnd {
			continue
		}
		payload := remaining[payloadStart:payloadEnd]

		var frame struct {
			Bytes string `json:"bytes"`
		}
		if err := json.Unmarshal(payload, &frame); err != nil || frame.Bytes == "" {
			continue
		}

		decoded, err := base64.StdEncoding.DecodeString(frame.Bytes)
		if err != nil {
			continue
		}

		var event struct {
			Type string `json:"type"`
		}
		eventType := "content_block_delta"
		if json.Unmarshal(decoded, &event) == nil && event.Type != "" {
			eventType = event.Type
		}

		// Extract usage from decoded Anthropic-format events.
		extractUsageFromSSEData(decoded, eventType, &usage)

		sseLine := fmt.Sprintf("event: %s\ndata: %s\n\n", eventType, string(decoded))
		if _, err := io.WriteString(w, sseLine); err != nil {
			return usage, err
		}
		if flusher != nil {
			flusher.Flush()
		}
	}
}

func (w *flushWriter) Write(p []byte) (int, error) {
	n, err := w.writer.Write(p)
	if n > 0 {
		w.flusher.Flush()
	}
	return n, err
}

func randomID() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("req-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}

func cloneHeaders(headers http.Header) http.Header {
	out := make(http.Header, len(headers))
	for key, values := range headers {
		if isInternalProxyHeader(key) {
			continue
		}
		copied := make([]string, len(values))
		copy(copied, values)
		out[key] = copied
	}
	return out
}

func copyHeaders(dst, src http.Header) {
	for key, values := range src {
		if isInternalProxyHeader(key) {
			continue
		}
		for _, value := range values {
			dst.Add(key, value)
		}
	}
}

func isInternalProxyHeader(key string) bool {
	// Miniflare injects MF-* headers for local service-binding proxying. They
	// are not valid user/Worker headers and must not be replayed downstream.
	return strings.HasPrefix(strings.ToLower(key), "mf-")
}

func decodeJSON(req *http.Request, target any) error {
	decoder := json.NewDecoder(req.Body)
	return decoder.Decode(target)
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func errorJSON(w http.ResponseWriter, message string, status int) {
	writeJSON(w, status, map[string]string{"error": message})
}

func nullableMillis(ts *time.Time) any {
	if ts == nil {
		return nil
	}
	return ts.UnixMilli()
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func (s *Server) trace(event string, details map[string]any) {
	if !s.cfg.TraceSandboxHost {
		return
	}
	log.Printf("[SandboxHost][trace] %s %+v", event, details)
}
