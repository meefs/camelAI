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

	httpClient *http.Client
	wsUpgrader websocket.Upgrader
}

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

	// Usage/spend endpoints (org-scoped, control port only).
	if strings.HasPrefix(req.URL.Path, "/v1/usage/") {
		s.handleUsageRoute(w, req)
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

	if strings.HasPrefix(route.Subpath, "/fs/") || route.Subpath == "/chat/messages" {
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
	case strings.HasPrefix(route.Subpath, "/data-proxy/"):
		return s.forwardDataProxyRequest(w, req, route)
	case route.Subpath == "/health" && req.Method == http.MethodGet:
		if _, err := s.containers.EnsureContainer(name, opts); err != nil {
			return err
		}
		return s.proxyToControlPlane(w, req, name, "/health", opts)
	case route.Subpath == "/chat":
		return s.handleChatProxy(w, req, name, route, opts)
	default:
		errorJSON(w, "Not found", http.StatusNotFound)
		return nil
	}
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

	sessionIDs := []string{threadID}
	if claudeSessionID != "" && claudeSessionID != threadID {
		sessionIDs = append(sessionIDs, claudeSessionID)
	}

	for _, sessionID := range sessionIDs {
		jsonlPath := fmt.Sprintf("/home/claude/.claude/projects/-home-claude/%s.jsonl", sessionID)
		info, err := s.fs.ReadInfo(name, jsonlPath)
		if err != nil {
			lower := strings.ToLower(err.Error())
			if strings.Contains(lower, "no such file") || strings.Contains(lower, "not exist") {
				continue
			}
			return s.handleFSError(w, err, "Chat messages unavailable")
		}

		file, err := os.Open(info.HostPath)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return err
		}
		defer file.Close()

		content, err := io.ReadAll(file)
		if err != nil {
			return err
		}
		messages := parseClaudeJSONLMessages(string(content), threadID)
		if len(messages) == 0 {
			continue
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"success":  true,
			"messages": messages,
		})
		return nil
	}

	if info, err := s.fs.ReadInfo(name, fmt.Sprintf("/home/claude/.codex/threads/%s/state_5.sqlite", threadID)); err == nil {
		hostCodexHome := filepath.Dir(info.HostPath)
		if messages, err := readCodexAppServerMessages(req.Context(), s.cfg.HostCodexPath, hostCodexHome, threadID, codexSessionID); err != nil {
			log.Printf("[SandboxHost] codex message history unavailable thread=%s codexHome=%s: %v", threadID, hostCodexHome, err)
		} else if len(messages) > 0 {
			writeJSON(w, http.StatusOK, map[string]any{
				"success":  true,
				"messages": messages,
			})
			return nil
		}
	} else if err != nil {
		lower := strings.ToLower(err.Error())
		if !strings.Contains(lower, "no such file") && !strings.Contains(lower, "not exist") {
			return s.handleFSError(w, err, "Chat messages unavailable")
		}
	}

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

func (s *Server) handleFSRead(w http.ResponseWriter, req *http.Request, route WorkspaceRoute) error {
	path := req.URL.Query().Get("path")
	if strings.TrimSpace(path) == "" {
		errorJSON(w, "path query param required", http.StatusBadRequest)
		return nil
	}

	// Resolve /mnt/user-outputs/ and /mnt/user-uploads/ to host R2 FUSE paths
	if hostPath, ok := s.resolveR2MountPath(path, route.OrgID, route.WorkspaceID); ok {
		return s.serveHostFile(w, hostPath)
	}

	info, err := s.fs.ReadInfo(route.Name, path)
	if err != nil {
		return s.handleFSError(w, err, "File not found")
	}

	return s.serveHostFile(w, info.HostPath)
}

// resolveR2MountPath checks if a sandbox path targets /mnt/user-outputs/ or
// /mnt/user-uploads/ and returns the corresponding host R2 FUSE path.
// Returns ("", false) if the path doesn't match or is invalid.
func (s *Server) resolveR2MountPath(sandboxPath, orgID, workspaceID string) (string, bool) {
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
	if _, err := s.containers.EnsureContainer(name, opts); err != nil {
		return err
	}
	// Fast path: execute through the already-running control plane process
	// instead of spawning docker exec per request.
	return s.proxyToControlPlane(w, req, name, "/exec", opts)
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
	userID := strings.TrimSpace(req.Header.Get(s.cfg.HeaderUserID))
	byokAnthropicKey := strings.TrimSpace(req.Header.Get("X-Chiridion-Byok-Anthropic-Key"))
	byokBedrockToken := strings.TrimSpace(req.Header.Get("X-Chiridion-Byok-Bedrock-Token"))
	byokBedrockRegion := strings.TrimSpace(req.Header.Get("X-Chiridion-Byok-Bedrock-Region"))
	byokOpenAIKey := strings.TrimSpace(req.Header.Get("X-Chiridion-Byok-OpenAI-Key"))

	workerBaseURL := normalizeWorkerBaseURL(firstNonEmpty(req.Header.Get(s.cfg.HeaderWorkerBaseURL), s.cfg.WorkerBaseURL))
	if workerBaseURL == "" {
		errorJSON(w, "Missing worker base URL", http.StatusBadRequest)
		return nil
	}

	if _, err := s.containers.EnsureContainer(name, opts); err != nil {
		return err
	}

	now := time.Now().UTC()
	threadKey := proxyThreadKey(name, threadID)

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
	}
	current := copyProxyThreadContext(s.proxyThreads[threadKey])
	s.proxyMu.Unlock()
	s.upsertProxyThreadState(current)

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

	port, err := s.containers.GetControlPlanePort(name, opts)
	if err != nil {
		return err
	}
	targetWSURL := fmt.Sprintf("ws://127.0.0.1:%d/chat", port)

	clientConn, err := s.wsUpgrader.Upgrade(w, req, nil)
	if err != nil {
		if existing == nil {
			s.proxyMu.Lock()
			delete(s.proxyThreads, threadKey)
			s.proxyMu.Unlock()
			s.deleteProxyThreadState(threadKey)
		}
		s.trace("chat_session_upgrade_failed", map[string]any{
			"container":   name,
			"orgId":       route.OrgID,
			"workspaceId": route.WorkspaceID,
			"threadId":    threadID,
			"threadKey":   threadKey,
			"targetWsUrl": targetWSURL,
		})
		return nil
	}
	s.trace("chat_session_upgrade_success", map[string]any{
		"container":   name,
		"orgId":       route.OrgID,
		"workspaceId": route.WorkspaceID,
		"threadId":    threadID,
		"threadKey":   threadKey,
		"targetWsUrl": targetWSURL,
	})

	s.containers.AddWebSocket(name, "chat_client_ws_open")
	s.trace("chat_ws_open", map[string]any{"container": name, "threadId": threadID, "threadKey": threadKey, "targetWsUrl": targetWSURL})

	upstreamDialer := *websocket.DefaultDialer
	upstreamDialer.HandshakeTimeout = 10 * time.Second
	upstreamConn, _, err := upstreamDialer.Dial(targetWSURL, nil)
	if err != nil {
		// Port may be stale (container restarted). Refresh from Docker and retry once.
		refreshedPort, refreshErr := s.containers.RefreshControlPlanePort(name, opts)
		if refreshErr == nil && refreshedPort != port {
			targetWSURL = fmt.Sprintf("ws://127.0.0.1:%d/chat", refreshedPort)
			upstreamConn, _, err = upstreamDialer.Dial(targetWSURL, nil)
		}
		if err != nil {
			_ = clientConn.Close()
			s.containers.RemoveWebSocket(name, "chat_client_ws_close", 1011, "upstream dial failed")
			return err
		}
	}
	log.Printf("[SandboxHost] chat session upstream connected container=%s thread=%s target=%s", name, threadID, targetWSURL)

	var closeOnce sync.Once
	closeAll := func(code int, reason string) {
		closeOnce.Do(func() {
			now := time.Now().UTC()
			var updated *ProxyThreadContext
			s.proxyMu.Lock()
			if ctx := s.proxyThreads[threadKey]; ctx != nil {
				ctx.ClosedAt = &now
				ctx.ExpiresAt = now.Add(s.cfg.ProxyThreadCloseGrace)
				updated = copyProxyThreadContext(ctx)
			}
			s.proxyMu.Unlock()
			s.upsertProxyThreadState(updated)

			log.Printf("[SandboxHost] chat session closed container=%s thread=%s code=%d reason=%s", name, threadID, code, reason)
			s.trace("chat_ws_close", map[string]any{
				"container":          name,
				"threadId":           threadID,
				"threadKey":          threadKey,
				"code":               code,
				"reason":             reason,
				"upstreamReadyState": upstreamConn.UnderlyingConn() != nil,
			})
			s.containers.RemoveWebSocket(name, "chat_client_ws_close", code, reason)
			_ = upstreamConn.Close()
			_ = clientConn.Close()
		})
	}

	done := make(chan struct{}, 2)

	go func() {
		defer func() { done <- struct{}{} }()
		if err := s.streamWebSocket(clientConn, upstreamConn, "chat_ws_client_message", map[string]any{
			"container": name,
			"threadId":  threadID,
			"threadKey": threadKey,
		}); err != nil {
			closeAll(1000, "client_to_upstream: "+err.Error())
			return
		}
	}()

	go func() {
		defer func() { done <- struct{}{} }()
		if err := s.streamWebSocket(upstreamConn, clientConn, "chat_ws_upstream_message", map[string]any{
			"container": name,
			"threadId":  threadID,
			"threadKey": threadKey,
		}); err != nil {
			closeAll(1000, "upstream_to_client: "+err.Error())
			return
		}
	}()

	<-done
	closeAll(1000, "session ended")
	<-done
	return nil
}

func (s *Server) proxyToControlPlane(
	w http.ResponseWriter,
	req *http.Request,
	containerName string,
	path string,
	opts container.EnsureContainerOptions,
) error {
	port, err := s.containers.GetControlPlanePort(containerName, opts)
	if err != nil {
		return err
	}

	target := fmt.Sprintf("http://127.0.0.1:%d%s", port, path)
	if req.URL.RawQuery != "" {
		target += "?" + req.URL.RawQuery
	}

	forwardReq, err := http.NewRequestWithContext(req.Context(), req.Method, target, req.Body)
	if err != nil {
		return err
	}
	forwardReq.Header = cloneHeaders(req.Header)
	forwardReq.Header.Del("Authorization")
	forwardReq.Header.Del(s.cfg.HeaderSandboxSecret)
	forwardReq.Header.Del(s.cfg.HeaderWorkerBaseURL)
	forwardReq.Header.Del(s.cfg.HeaderThreadID)
	forwardReq.Header.Del("Host")
	applyStreamingRequestHeaders(forwardReq.Header)

	resp, err := s.httpClient.Do(forwardReq)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	copyHeaders(w.Header(), resp.Header)
	applyStreamingResponseHeaders(w.Header(), resp.Header.Get("Content-Type"))
	w.WriteHeader(resp.StatusCode)
	return copyResponseBody(w, resp.Body)
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
	fallbackThreadKey := ""
	if caller == nil {
		if isLoopbackSourceIP(sourceIP) {
			if threadKey, containerName, ok := s.findActiveProxyThreadByThreadID(proxy.ThreadID, time.Now().UTC()); ok {
				fallbackThreadKey = threadKey
				caller = &container.ContainerRecord{Name: containerName}
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

	threadKey := proxyThreadKey(caller.Name, proxy.ThreadID)
	if fallbackThreadKey != "" {
		threadKey = fallbackThreadKey
	}
	var upsertedThread *ProxyThreadContext
	removedThread := false
	s.proxyMu.Lock()
	threadContext := s.proxyThreads[threadKey]
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
		// Bedrock count_tokens falls through to AI Gateway (Bedrock uses Anthropic format for that).
		if threadContext.ByokBedrockToken != "" && !strings.Contains(proxy.UpstreamPath, "count_tokens") {
			s.forwardClaudeToBedrockDirect(w, req, proxy, threadContext, caller, requestID, startedAt)
			return
		}
	}

	// Route Claude API requests directly to Bedrock/Anthropic (no AI Gateway).
	if strings.HasPrefix(proxy.UpstreamPath, "/api/claude/") && (s.cfg.AnthropicAPIKey != "" || s.cfg.BedrockAccessToken != "") {
		s.forwardClaudeDirect(w, req, proxy, threadContext, caller, requestID, startedAt)
		return
	}

	// Route OpenAI API requests to AI Gateway (still uses gateway).
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

// forwardClaudeDirect calls Bedrock first (if configured), falling back to
// Anthropic direct. No AI Gateway in the path. Usage is tracked for both
// streaming and non-streaming responses.
func (s *Server) forwardClaudeDirect(
	w http.ResponseWriter,
	req *http.Request,
	proxy ProxyRoute,
	threadContext *ProxyThreadContext,
	caller *container.ContainerRecord,
	requestID string,
	startedAt time.Time,
) {
	rawBody, err := io.ReadAll(req.Body)
	if err != nil {
		errorJSON(w, "Failed to read request body", http.StatusBadRequest)
		return
	}

	claudeEndpoint := strings.TrimPrefix(
		strings.Replace(proxy.UpstreamPath, "/api/claude/", "/", 1),
		"/",
	)

	isMessagesEndpoint := strings.Contains(claudeEndpoint, "messages") && !strings.Contains(claudeEndpoint, "count_tokens")

	// Budget enforcement: reject if org has exceeded its spend limit.
	if isMessagesEndpoint {
		if exceeded, msg := s.checkOrgBudget(threadContext.OrgID); exceeded {
			s.trace("claude_direct_budget_exceeded", map[string]any{
				"requestId":       requestID,
				"callerContainer": caller.Name,
				"orgId":           threadContext.OrgID,
				"threadId":        threadContext.ThreadID,
			})
			errorJSON(w, msg, http.StatusTooManyRequests)
			return
		}
	}

	// Determine provider order: Bedrock first (messages only), then Anthropic.
	type providerAttempt struct {
		name string
		fn   func() (*http.Response, bool, error) // returns (resp, isBedrock, err)
	}
	var attempts []providerAttempt

	if isMessagesEndpoint && s.cfg.BedrockAccessToken != "" {
		attempts = append(attempts, providerAttempt{
			name: "bedrock",
			fn: func() (*http.Response, bool, error) {
				return s.doBedrockRequest(req.Context(), rawBody, req.Header, s.cfg.BedrockAccessToken, s.cfg.BedrockRegion)
			},
		})
	}
	if s.cfg.AnthropicAPIKey != "" {
		attempts = append(attempts, providerAttempt{
			name: "anthropic",
			fn: func() (*http.Response, bool, error) {
				return s.doAnthropicRequest(req.Context(), rawBody, req.Header, s.cfg.AnthropicAPIKey, "/"+claudeEndpoint)
			},
		})
	}

	if len(attempts) == 0 {
		errorJSON(w, "No Claude API provider configured (set ANTHROPIC_API_KEY or BEDROCK_ACCESS_TOKEN)", http.StatusServiceUnavailable)
		return
	}

	s.trace("claude_direct_start", map[string]any{
		"requestId":       requestID,
		"callerContainer": caller.Name,
		"method":          req.Method,
		"threadId":        threadContext.ThreadID,
		"endpoint":        claudeEndpoint,
		"providerCount":   len(attempts),
	})
	proxyTag := fmt.Sprintf("proxy:%s:%s", req.Method, proxy.UpstreamPath)
	s.containers.AddProxyRequest(threadContext.ContainerName, proxyTag)

	var resp *http.Response
	var usedProvider string
	var isBedrock bool
	var upstreamErr error

	type directFailure struct {
		status   int
		headers  http.Header
		body     []byte
		provider string
	}
	var lastFailure *directFailure

	for i, attempt := range attempts {
		attemptStart := time.Now()
		resp, isBedrock, upstreamErr = attempt.fn()
		durationMs := time.Since(attemptStart).Milliseconds()

		if upstreamErr != nil {
			s.trace("claude_direct_attempt_error", map[string]any{
				"requestId":  requestID,
				"threadId":   threadContext.ThreadID,
				"provider":   attempt.name,
				"attempt":    i,
				"durationMs": durationMs,
				"error":      upstreamErr.Error(),
			})
			continue
		}
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			usedProvider = attempt.name
			break
		}

		s.trace("claude_direct_attempt_non_2xx", map[string]any{
			"requestId":  requestID,
			"threadId":   threadContext.ThreadID,
			"provider":   attempt.name,
			"attempt":    i,
			"durationMs": durationMs,
			"status":     resp.StatusCode,
		})

		failureBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		_ = resp.Body.Close()
		lastFailure = &directFailure{
			status:   resp.StatusCode,
			headers:  cloneHeaders(resp.Header),
			body:     failureBody,
			provider: attempt.name,
		}
		resp = nil
	}

	totalDurationMs := time.Since(startedAt).Milliseconds()
	if resp == nil {
		s.containers.RemoveProxyRequest(threadContext.ContainerName, proxyTag, 0, totalDurationMs)
		if lastFailure != nil {
			copyHeaders(w.Header(), lastFailure.headers)
			applyStreamingResponseHeaders(w.Header(), w.Header().Get("Content-Type"))
			w.WriteHeader(lastFailure.status)
			if len(lastFailure.body) > 0 {
				_, _ = w.Write(lastFailure.body)
			}
			return
		}
		if upstreamErr != nil {
			log.Printf("[SandboxHost] Claude direct proxy failed endpoint=%s thread=%s container=%s durationMs=%d error=%v",
				claudeEndpoint, threadContext.ThreadID, threadContext.ContainerName, totalDurationMs, upstreamErr)
		}
		errorJSON(w, "Claude API upstream unavailable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	s.trace("claude_direct_complete", map[string]any{
		"requestId":  requestID,
		"threadId":   threadContext.ThreadID,
		"status":     resp.StatusCode,
		"durationMs": totalDurationMs,
		"endpoint":   claudeEndpoint,
		"provider":   usedProvider,
	})
	s.containers.RemoveProxyRequest(threadContext.ContainerName, proxyTag, resp.StatusCode, totalDurationMs)

	// Write response to client and extract usage.
	var usage UsageTokens
	if isBedrock && usedProvider == "bedrock" {
		// Bedrock: parse request body for streaming flag, convert eventstream → SSE.
		var bodyJSON map[string]any
		_ = json.Unmarshal(rawBody, &bodyJSON)
		isStreaming, _ := bodyJSON["stream"].(bool)

		if isStreaming && resp.StatusCode == http.StatusOK {
			w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
			applyStreamingResponseHeaders(w.Header(), "text/event-stream")
			w.WriteHeader(resp.StatusCode)
			usage, err = copyBedrockStreamToSSEWithUsage(w, resp.Body)
		} else {
			copyHeaders(w.Header(), resp.Header)
			applyStreamingResponseHeaders(w.Header(), w.Header().Get("Content-Type"))
			w.WriteHeader(resp.StatusCode)
			usage, err = copyNonStreamingWithUsage(w, resp.Body)
		}
	} else {
		// Anthropic: SSE or JSON response, already in Anthropic format.
		copyHeaders(w.Header(), resp.Header)
		applyStreamingResponseHeaders(w.Header(), w.Header().Get("Content-Type"))
		w.WriteHeader(resp.StatusCode)
		streaming := isStreamingContentType(resp.Header.Get("Content-Type"))
		usage, err = copyResponseBodyWithUsage(w, resp.Body, streaming)
	}

	if err != nil && !errors.Is(err, context.Canceled) {
		s.trace("claude_direct_copy_error", map[string]any{
			"requestId": requestID,
			"threadId":  threadContext.ThreadID,
			"provider":  usedProvider,
			"error":     err.Error(),
		})
	}

	if usage.Model == "" {
		usage.Model = extractModelFromRequestBody(rawBody)
	}

	if isMessagesEndpoint && usage.HasBillableTokens() {
		go s.recordUsage(threadContext, usedProvider, usage, totalDurationMs)
	}
}

// doBedrockRequest builds and executes a Bedrock API request from an Anthropic-format body.
func (s *Server) doBedrockRequest(ctx context.Context, rawBody []byte, srcHeaders http.Header, token, region string) (*http.Response, bool, error) {
	var bodyJSON map[string]any
	if err := json.Unmarshal(rawBody, &bodyJSON); err != nil {
		return nil, true, fmt.Errorf("invalid JSON body: %w", err)
	}

	modelStr, _ := bodyJSON["model"].(string)
	if modelStr == "" {
		return nil, true, fmt.Errorf("missing model in request body")
	}
	bedrockModel := mapToBedrockModel(modelStr)

	isStreaming, _ := bodyJSON["stream"].(bool)
	endpoint := "invoke"
	if isStreaming {
		endpoint = "invoke-with-response-stream"
	}

	if region == "" {
		region = "us-west-2"
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

	if betaHeader := srcHeaders.Get("anthropic-beta"); betaHeader != "" {
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
		return nil, true, fmt.Errorf("marshal bedrock body: %w", err)
	}

	forwardReq, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, bytes.NewReader(payload))
	if err != nil {
		return nil, true, err
	}
	forwardReq.Header.Set("Content-Type", "application/json")
	forwardReq.Header.Set("Authorization", "Bearer "+token)
	applyStreamingRequestHeaders(forwardReq.Header)

	resp, err := s.httpClient.Do(forwardReq)
	return resp, true, err
}

// doAnthropicRequest builds and executes a direct Anthropic API request.
func (s *Server) doAnthropicRequest(ctx context.Context, rawBody []byte, srcHeaders http.Header, apiKey, path string) (*http.Response, bool, error) {
	targetURL := "https://api.anthropic.com" + path

	forwardReq, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, bytes.NewReader(rawBody))
	if err != nil {
		return nil, false, err
	}

	forwardReq.Header = sanitizeGatewayUpstreamHeaders(srcHeaders)
	forwardReq.Header.Set("Content-Type", "application/json")
	forwardReq.Header.Set("x-api-key", apiKey)
	applyStreamingRequestHeaders(forwardReq.Header)

	resp, err := s.httpClient.Do(forwardReq)
	return resp, false, err
}

// checkOrgBudget checks all rolling spend windows for the org.
// Returns true if any window is exceeded.
func (s *Server) checkOrgBudget(orgID string) (exceeded bool, message string) {
	exc, _, err := s.usage.CheckSpendLimits(orgID)
	if err != nil {
		log.Printf("[SandboxHost] budget check failed org=%s error=%v (allowing request)", orgID, err)
		return false, ""
	}
	if exc == nil {
		return false, ""
	}
	return true, fmt.Sprintf(
		"Usage limit exceeded: $%.2f spent in the last %s (limit $%.2f). Please try again later.",
		exc.SpentUSD, exc.Label, exc.LimitUSD,
	)
}

// recordUsage persists token usage and cost to the state store.
func (s *Server) recordUsage(tc *ProxyThreadContext, provider string, usage UsageTokens, durationMs int64) {
	costUSD := usage.CostUSD()

	record := state.UsageRecord{
		OrgID:                    tc.OrgID,
		WorkspaceID:              tc.WorkspaceID,
		UserID:                   tc.UserID,
		ThreadID:                 tc.ThreadID,
		Model:                    usage.Model,
		Provider:                 provider,
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
	targetURL := "https://api.anthropic.com" + strings.Replace(proxy.UpstreamPath, "/api/claude", "", 1)

	forwardReq, err := http.NewRequestWithContext(req.Context(), req.Method, targetURL, req.Body)
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
	_ = copyResponseBody(w, resp.Body)
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
		if err := copyBedrockStreamToSSE(w, resp.Body); err != nil {
			if !errors.Is(err, context.Canceled) {
				s.trace("byok_bedrock_direct_copy_error", map[string]any{
					"requestId":       requestID,
					"callerContainer": caller.Name,
					"threadId":        threadContext.ThreadID,
					"error":           err.Error(),
				})
			}
		}
	} else {
		copyHeaders(w.Header(), resp.Header)
		applyStreamingResponseHeaders(w.Header(), w.Header().Get("Content-Type"))
		w.WriteHeader(resp.StatusCode)
		if err := copyResponseBody(w, resp.Body); err != nil {
			if !errors.Is(err, context.Canceled) {
				s.trace("byok_bedrock_direct_copy_error", map[string]any{
					"requestId":       requestID,
					"callerContainer": caller.Name,
					"threadId":        threadContext.ThreadID,
					"error":           err.Error(),
				})
			}
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
	// Map /api/openai/v1/* -> {gateway}/{provider}/* where provider is "compat" or "openrouter"
	openaiPath := strings.TrimPrefix(proxy.UpstreamPath, "/api/openai")
	normalizedPath, ok := normalizeOpenAIProxyUpstreamPath(openaiPath)
	if !ok {
		errorJSON(w, "Invalid OpenAI proxy path", http.StatusBadRequest)
		return
	}

	// Resolve model and determine gateway provider
	gatewayProvider := "compat"
	var err error
	var rawBody []byte
	var forwardBody io.Reader = req.Body
	if req.Method == http.MethodPost {
		rawBody, err = io.ReadAll(req.Body)
		if err != nil {
			errorJSON(w, "Failed to read request body", http.StatusBadRequest)
			return
		}
		var bodyJSON map[string]any
		if len(rawBody) > 0 {
			if err := json.Unmarshal(rawBody, &bodyJSON); err == nil {
				if model, _ := bodyJSON["model"].(string); model != "" {
					resolved := resolveGatewayModel(model)
					if resolved != model {
						bodyJSON["model"] = resolved
						rawBody, _ = json.Marshal(bodyJSON)
					}
					if isOpenRouterModel(resolved) {
						gatewayProvider = "openrouter"
					}
				}
			}
		}
		forwardBody = bytes.NewReader(rawBody)
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
		provider := "openai"
		if gatewayProvider == "openrouter" {
			provider = "openrouter"
		}
		go s.recordUsage(threadContext, provider, usage, durationMs)
	}
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
	openaiPath := strings.TrimPrefix(proxy.UpstreamPath, "/api/openai")
	normalizedPath, ok := normalizeOpenAIProxyUpstreamPath(openaiPath)
	if !ok {
		errorJSON(w, "Invalid OpenAI proxy path", http.StatusBadRequest)
		return
	}

	targetURL := "https://api.openai.com" + normalizedPath
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
		forwardBody = bytes.NewReader(rawBody)
	}

	forwardReq, err := http.NewRequestWithContext(req.Context(), req.Method, targetURL, forwardBody)
	if err != nil {
		errorJSON(w, "Failed to create OpenAI request", http.StatusInternalServerError)
		return
	}

	headers := sanitizeGatewayUpstreamHeaders(req.Header)
	headers.Set("Authorization", "Bearer "+threadContext.ByokOpenAIKey)
	applyStreamingRequestHeaders(headers)
	forwardReq.Header = headers

	s.trace("byok_openai_direct_start", map[string]any{
		"requestId":       requestID,
		"callerContainer": caller.Name,
		"method":          req.Method,
		"threadId":        threadContext.ThreadID,
		"targetPath":      normalizedPath,
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
		errorJSON(w, "OpenAI upstream unavailable", http.StatusBadGateway)
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
		go s.recordUsage(threadContext, "openai", usage, durationMs)
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

var dynamicModelAliases = map[string]bool{
	"auto":        true,
	"auto_search": true,
	"auto_image":  true,
}

// resolveGatewayModel rewrites model aliases to Cloudflare dynamic routing names
// and passes OpenRouter models through as-is.
//
// Known aliases ("auto", "auto_search", "auto_image") map to "dynamic/{alias}".
// Models already prefixed with "dynamic/" pass through unchanged.
// Everything else is treated as an OpenRouter model and passes through as-is.
func resolveGatewayModel(model string) string {
	trimmed := strings.TrimSpace(model)
	if dynamicModelAliases[trimmed] {
		return "dynamic/" + trimmed
	}
	if trimmed == "" {
		return "dynamic/auto"
	}
	return trimmed
}

// isOpenRouterModel returns true when the resolved model should route through
// the OpenRouter gateway provider endpoint (/openrouter/) rather than the
// Cloudflare compat endpoint (/compat/).
func isOpenRouterModel(resolvedModel string) bool {
	return !strings.HasPrefix(resolvedModel, "dynamic/")
}

func (s *Server) findActiveProxyThreadByThreadID(threadID string, now time.Time) (threadKey string, containerName string, ok bool) {
	if strings.TrimSpace(threadID) == "" {
		return "", "", false
	}

	s.proxyMu.Lock()
	defer s.proxyMu.Unlock()

	var found *ProxyThreadContext
	var foundKey string
	for key, ctx := range s.proxyThreads {
		if ctx == nil || ctx.ThreadID != threadID {
			continue
		}
		if ctx.ClosedAt != nil {
			continue
		}
		if found != nil && foundKey != key {
			// Ambiguous thread mapping; fall back to strict caller-IP flow.
			return "", "", false
		}
		found = ctx
		foundKey = key
	}

	if found == nil {
		return "", "", false
	}
	return foundKey, found.ContainerName, true
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

var workspaceRouteRegex = regexp.MustCompile(`^/v1/workspaces/([^/]+)/([^/]+)(/.*)?$`)
var proxyRouteRegex = regexp.MustCompile(`^/proxy/([^/]+)(/.*)?$`)
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

func (s *Server) streamWebSocket(source *websocket.Conn, target *websocket.Conn, traceEvent string, traceFields map[string]any) error {
	for {
		messageType, reader, err := source.NextReader()
		if err != nil {
			return err
		}

		writer, err := target.NextWriter(messageType)
		if err != nil {
			return err
		}

		written, copyErr := io.Copy(writer, reader)
		closeErr := writer.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}

		fields := make(map[string]any, len(traceFields)+2)
		for key, value := range traceFields {
			fields[key] = value
		}
		fields["bytes"] = written
		fields["type"] = websocketMessageType(messageType)
		s.trace(traceEvent, fields)
	}
}

func randomID() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("req-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}

func websocketMessageType(messageType int) string {
	switch messageType {
	case websocket.TextMessage:
		return "text"
	case websocket.BinaryMessage:
		return "binary"
	case websocket.CloseMessage:
		return "close"
	case websocket.PingMessage:
		return "ping"
	case websocket.PongMessage:
		return "pong"
	default:
		return fmt.Sprintf("type_%d", messageType)
	}
}

func cloneHeaders(headers http.Header) http.Header {
	out := make(http.Header, len(headers))
	for key, values := range headers {
		copied := make([]string, len(values))
		copy(copied, values)
		out[key] = copied
	}
	return out
}

func copyHeaders(dst, src http.Header) {
	for key, values := range src {
		for _, value := range values {
			dst.Add(key, value)
		}
	}
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
