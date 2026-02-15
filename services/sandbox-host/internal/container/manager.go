package container

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/chiridion/sandbox-host/internal/overlay"
	"github.com/chiridion/sandbox-host/internal/state"
	dockercontainer "github.com/docker/docker/api/types/container"
	dockernetwork "github.com/docker/docker/api/types/network"
	dockerclient "github.com/docker/docker/client"
	dockererrdefs "github.com/docker/docker/errdefs"
	"github.com/docker/go-connections/nat"
	dockerunits "github.com/docker/go-units"
)

type EnsureContainerOptions struct {
	OrgID       string
	WorkspaceID string
}

type ContainerRecord struct {
	Name              string
	ContainerID       string
	HostPort          int
	ContainerIP       string
	Status            string
	CreatedAt         int64
	LastAccessedAt    int64
	ActiveWebSockets  int
	InFlightProxyReqs int
	OrgID             string
	WorkspaceID       string
}

type ensureWait struct {
	done chan struct{}
	rec  *ContainerRecord
	err  error
}

type Manager struct {
	overlays *overlay.Manager
	docker   *dockerclient.Client
	state    *state.Store

	workspacesRoot      string
	sandboxImage        string
	containerMemory     string
	containerCPUShares  string
	containerRuntime    string
	controlPlanePort    int
	proxyPort           int
	idleTimeout         time.Duration
	reaperInterval      time.Duration
	r2MountRoot         string
	reclaimIdle         time.Duration
	reclaimInterval     time.Duration
	healthPollInterval  time.Duration
	cfDispatchNamespace string
	traceLifecycle      bool

	mu                    sync.Mutex
	containers            map[string]*ContainerRecord
	containerIPIndex      map[string]string
	pendingWorkspaces     map[string]int
	ensureInFlight        map[string]*ensureWait
	containerTerminatedAt map[string]time.Time
}

func NewManager(overlays *overlay.Manager, stateStore *state.Store) *Manager {
	docker, err := dockerclient.NewClientWithOpts(
		dockerclient.FromEnv,
		dockerclient.WithAPIVersionNegotiation(),
	)
	if err != nil {
		log.Fatalf("[ContainerManager] failed to initialize Docker API client: %v", err)
	}

	m := &Manager{
		overlays:              overlays,
		docker:                docker,
		state:                 stateStore,
		workspacesRoot:        envString("WORKSPACES_ROOT", "/mnt/workspaces"),
		sandboxImage:          envString("SANDBOX_IMAGE", "chiridion-sandbox:latest"),
		containerMemory:       envString("CONTAINER_MEMORY", "16g"),
		containerCPUShares:    envString("CONTAINER_CPU_SHARES", "2048"),
		containerRuntime:      envString("CONTAINER_RUNTIME", "runsc"),
		controlPlanePort:      8080,
		proxyPort:             envInt("SANDBOX_PROXY_PORT", 8081),
		idleTimeout:           time.Duration(envInt("IDLE_TIMEOUT_MS", 30_000)) * time.Millisecond,
		reaperInterval:        10 * time.Second,
		r2MountRoot:           envString("R2_MOUNT_ROOT", "/mnt/r2"),
		reclaimIdle:           time.Duration(envInt("RECLAIM_IDLE_MS", 10*60_000)) * time.Millisecond,
		reclaimInterval:       5 * time.Minute,
		healthPollInterval:    maxDuration(10*time.Millisecond, time.Duration(envInt("HEALTH_POLL_INTERVAL_MS", 50))*time.Millisecond),
		cfDispatchNamespace:   envString("CF_DISPATCH_NAMESPACE", ""),
		traceLifecycle:        envString("TRACE_SANDBOX_LIFECYCLE", "") == "1",
		containers:            make(map[string]*ContainerRecord),
		containerIPIndex:      make(map[string]string),
		pendingWorkspaces:     make(map[string]int),
		ensureInFlight:        make(map[string]*ensureWait),
		containerTerminatedAt: make(map[string]time.Time),
	}

	m.loadPersistedState()

	go m.runIdleReaper()
	go m.runReclaimLoop()

	log.Printf("[ContainerManager] idle reaper started (timeout=%ds, interval=%ds)", int(m.idleTimeout/time.Second), int(m.reaperInterval/time.Second))
	log.Printf("[ContainerManager] NVMe reclaim started (idle=%ds, interval=%ds)", int(m.reclaimIdle/time.Second), int(m.reclaimInterval/time.Second))
	return m
}

func (m *Manager) TouchContainer(name, reason string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec := m.containers[name]
	if rec == nil {
		m.trace("touch_container_miss", map[string]any{"name": name, "reason": reason})
		return
	}
	rec.LastAccessedAt = nowMillis()
	m.trace("touch_container", map[string]any{"reason": reason, "container": rec})
}

func (m *Manager) AddWebSocket(name, source string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec := m.containers[name]
	if rec == nil {
		m.trace("ws_open_missing_container", map[string]any{"name": name, "source": source})
		return
	}
	rec.ActiveWebSockets++
	rec.LastAccessedAt = nowMillis()
	m.trace("ws_open", map[string]any{"source": source, "container": rec})
}

func (m *Manager) RemoveWebSocket(name, source string, closeCode int, closeReason string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec := m.containers[name]
	if rec == nil {
		m.trace("ws_close_missing_container", map[string]any{"name": name, "source": source, "closeCode": closeCode, "closeReason": closeReason})
		return
	}
	if rec.ActiveWebSockets > 0 {
		rec.ActiveWebSockets--
	}
	rec.LastAccessedAt = nowMillis()
	m.trace("ws_close", map[string]any{"source": source, "closeCode": closeCode, "closeReason": closeReason, "container": rec})
}

func (m *Manager) AddProxyRequest(name, reason string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec := m.containers[name]
	if rec == nil {
		m.trace("proxy_request_open_missing_container", map[string]any{"name": name, "reason": reason})
		return
	}
	rec.InFlightProxyReqs++
	rec.LastAccessedAt = nowMillis()
	m.trace("proxy_request_open", map[string]any{"reason": reason, "container": rec})
}

func (m *Manager) RemoveProxyRequest(name, reason string, status int, durationMs int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec := m.containers[name]
	if rec == nil {
		m.trace("proxy_request_close_missing_container", map[string]any{"name": name, "reason": reason, "status": status, "durationMs": durationMs})
		return
	}
	if rec.InFlightProxyReqs > 0 {
		rec.InFlightProxyReqs--
	}
	rec.LastAccessedAt = nowMillis()
	m.trace("proxy_request_close", map[string]any{"reason": reason, "status": status, "durationMs": durationMs, "container": rec})
}

func (m *Manager) ResolveContainerBySourceIP(sourceIP string) (*ContainerRecord, error) {
	for _, key := range sourceIPKeys(sourceIP) {
		if rec := m.getContainerBySourceIPCached(key); rec != nil {
			return copyRecord(rec), nil
		}
	}

	m.mu.Lock()
	names := make([]string, 0, len(m.containers))
	for name := range m.containers {
		names = append(names, name)
	}
	m.mu.Unlock()

	for _, name := range names {
		latestIP, _ := m.getContainerIP(name)
		if latestIP == "" {
			continue
		}

		m.mu.Lock()
		rec := m.containers[name]
		if rec == nil {
			m.mu.Unlock()
			continue
		}
		if rec.ContainerIP != "" && rec.ContainerIP != latestIP {
			m.unindexContainerIPLocked(rec.ContainerIP)
		}
		rec.ContainerIP = latestIP
		m.indexContainerIPLocked(latestIP, name)
		m.mu.Unlock()

		latestKeys := make(map[string]struct{})
		for _, key := range sourceIPKeys(latestIP) {
			latestKeys[key] = struct{}{}
		}
		for _, sourceKey := range sourceIPKeys(sourceIP) {
			if _, ok := latestKeys[sourceKey]; ok {
				m.mu.Lock()
				out := copyRecord(m.containers[name])
				m.mu.Unlock()
				if out != nil {
					return out, nil
				}
			}
		}
	}

	return nil, nil
}

func (m *Manager) EnsureContainer(name string, opts EnsureContainerOptions) (*ContainerRecord, error) {
	m.trace("ensure_container_request", map[string]any{"name": name, "opts": opts})

	for {
		m.mu.Lock()
		if inflight := m.ensureInFlight[name]; inflight != nil {
			m.mu.Unlock()
			<-inflight.done
			if inflight.err != nil {
				return nil, inflight.err
			}
			return copyRecord(inflight.rec), nil
		}

		wait := &ensureWait{done: make(chan struct{})}
		m.ensureInFlight[name] = wait
		m.pendingWorkspaces[name] = m.pendingWorkspaces[name] + 1
		delete(m.containerTerminatedAt, name)
		m.mu.Unlock()

		rec, err := m.ensureContainerUnlocked(name, opts)

		m.mu.Lock()
		wait.rec = rec
		wait.err = err
		close(wait.done)
		delete(m.ensureInFlight, name)
		if m.pendingWorkspaces[name] <= 1 {
			delete(m.pendingWorkspaces, name)
		} else {
			m.pendingWorkspaces[name]--
		}
		m.mu.Unlock()

		if err != nil {
			return nil, err
		}
		return copyRecord(rec), nil
	}
}

func (m *Manager) ensureContainerUnlocked(name string, opts EnsureContainerOptions) (*ContainerRecord, error) {
	m.mu.Lock()
	cached := m.containers[name]
	m.mu.Unlock()

	if cached != nil {
		if running, _ := m.isRunning(name); running {
			m.mu.Lock()
			if current := m.containers[name]; current != nil {
				current.LastAccessedAt = nowMillis()
				m.mu.Unlock()
				m.trace("ensure_container_cache_hit", map[string]any{"name": name, "container": current})
				return copyRecord(current), nil
			}
			m.mu.Unlock()
		} else {
			m.mu.Lock()
			if existing := m.containers[name]; existing != nil {
				if existing.ContainerIP != "" {
					m.unindexContainerIPLocked(existing.ContainerIP)
				}
				delete(m.containers, name)
			}
			m.mu.Unlock()
			m.deleteContainerState(name)
		}
	}

	if running, _ := m.isRunning(name); running {
		port, containerIP := m.getHostPortAndIP(name)
		if port > 0 {
			rec := &ContainerRecord{
				Name:              name,
				ContainerID:       name,
				HostPort:          port,
				ContainerIP:       containerIP,
				Status:            "running",
				CreatedAt:         nowMillis(),
				LastAccessedAt:    nowMillis(),
				ActiveWebSockets:  0,
				InFlightProxyReqs: 0,
				OrgID:             opts.OrgID,
				WorkspaceID:       opts.WorkspaceID,
			}
			m.mu.Lock()
			m.containers[name] = rec
			if containerIP != "" {
				m.indexContainerIPLocked(containerIP, name)
			}
			m.mu.Unlock()
			log.Printf("[ContainerManager] reconnected to existing container %s (port=%d)", name, port)
			m.trace("ensure_container_reconnected_existing", map[string]any{"name": name, "container": rec})
			m.upsertContainerState(rec)
			return copyRecord(rec), nil
		}
	}

	_ = m.removeContainerIfExists(name, true)

	if _, err := m.overlays.Ensure(name); err != nil {
		return nil, err
	}
	wsPath := m.workspacePath(name)

	log.Printf("[ContainerManager] creating container %s", name)
	m.trace("ensure_container_create_begin", map[string]any{"name": name, "workspacePath": wsPath, "image": m.sandboxImage, "runtime": m.containerRuntime, "opts": opts})

	env := []string{
		"HOME=/home/claude",
		"USER=claude",
	}
	binds := []string{
		wsPath + ":/home/claude",
	}

	if opts.OrgID != "" && opts.WorkspaceID != "" {
		proxyBase := fmt.Sprintf("http://172.17.0.1:%d/proxy", m.proxyPort)
		env = append(env,
			"WORKSPACE_ID="+opts.WorkspaceID,
			"ORG_ID="+opts.OrgID,
			"ANTHROPIC_BASE_URL="+proxyBase+"/api/claude",
			"ANTHROPIC_API_KEY=proxy",
			"CLOUDFLARE_API_BASE_URL="+proxyBase+"/client/v4",
			"CLOUDFLARE_API_TOKEN=proxy",
			"DATA_PROXY_URL="+proxyBase+"/api",
			"DATA_PROXY_TOKEN=proxy",
			"MCP_SERVER_URL="+proxyBase+"/mcp",
			"CLOUDFLARE_ACCOUNT_ID=chiridion",
			"WRANGLER_SEND_METRICS=false",
			"CI=1",
			"CLAUDE_ENV_FILE=/home/claude/.chiridion/integration.env",
			"DEBUG_CLAUDE_AGENT_SDK=1",
		)
		if m.cfDispatchNamespace != "" {
			env = append(env, "CF_DISPATCH_NAMESPACE="+m.cfDispatchNamespace)
		}
		for _, key := range []string{
			"CHIRIDION_TRACE_EVENTS", "CHIRIDION_DEBUG_STARTUP", "CHIRIDION_DEBUG_SDK",
			"CHIRIDION_DEBUG_FS", "CLAUDE_CODE_MAX_TURNS", "CLAUDE_CODE_DISABLE_NONESSENTIAL",
			"CHIRIDION_PREQUEUE_FIRST_MESSAGE", "CHIRIDION_FIRST_MESSAGE_DELAY_MS",
		} {
			if value, ok := os.LookupEnv(key); ok {
				env = append(env, key+"="+value)
			}
		}
	}

	if opts.OrgID != "" && opts.WorkspaceID != "" {
		prefix := opts.OrgID + "/" + opts.WorkspaceID
		uploadsHost := filepath.Join(m.r2MountRoot, prefix, "user-uploads")
		outputsHost := filepath.Join(m.r2MountRoot, prefix, "user-outputs")
		_ = os.MkdirAll(uploadsHost, 0o755)
		_ = os.MkdirAll(outputsHost, 0o755)
		binds = append(binds,
			uploadsHost+":/mnt/user-uploads:ro",
			outputsHost+":/mnt/user-outputs",
		)
		log.Printf("[ContainerManager] R2 bind mounts: %s", prefix)
	}

	memoryBytes := int64(0)
	if parsed, parseErr := dockerunits.RAMInBytes(m.containerMemory); parseErr == nil {
		memoryBytes = parsed
	}
	cpuShares := int64(0)
	if parsed, parseErr := strconv.ParseInt(m.containerCPUShares, 10, 64); parseErr == nil {
		cpuShares = parsed
	}

	controlPlanePort := nat.Port(strconv.Itoa(m.controlPlanePort) + "/tcp")
	createConfig := &dockercontainer.Config{
		Image: m.sandboxImage,
		Cmd:   []string{"bun", "run", "/opt/chiridion/control-plane.mjs"},
		Env:   env,
		ExposedPorts: nat.PortSet{
			controlPlanePort: {},
		},
	}
	hostConfig := &dockercontainer.HostConfig{
		Runtime:     m.containerRuntime,
		Binds:       binds,
		NetworkMode: dockercontainer.NetworkMode("bridge"),
		Resources: dockercontainer.Resources{
			Memory:    memoryBytes,
			CPUShares: cpuShares,
		},
		PortBindings: nat.PortMap{
			controlPlanePort: []nat.PortBinding{{HostIP: "0.0.0.0", HostPort: ""}},
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	createResponse, err := m.docker.ContainerCreate(
		ctx,
		createConfig,
		hostConfig,
		&dockernetwork.NetworkingConfig{},
		nil,
		name,
	)
	cancel()
	if err != nil {
		m.trace("ensure_container_create_failed", map[string]any{"name": name, "error": err.Error()})
		return nil, fmt.Errorf("failed to create container %s: %w", name, err)
	}

	startCtx, startCancel := context.WithTimeout(context.Background(), 30*time.Second)
	startErr := m.docker.ContainerStart(startCtx, createResponse.ID, dockercontainer.StartOptions{})
	startCancel()
	if startErr != nil {
		m.trace("ensure_container_create_failed", map[string]any{"name": name, "error": startErr.Error(), "containerId": createResponse.ID})
		return nil, fmt.Errorf("failed to start container %s: %w", name, startErr)
	}

	containerID := strings.TrimSpace(createResponse.ID)
	if len(containerID) > 12 {
		containerID = containerID[:12]
	}

	port, containerIP := m.getHostPortAndIP(name)
	if port == 0 {
		return nil, fmt.Errorf("container %s created but no port mapping found", name)
	}

	if !m.waitForHealth(port, 30*time.Second) {
		log.Printf("[ContainerManager] container %s health check timed out, proceeding anyway", name)
		m.trace("ensure_container_health_timeout", map[string]any{"name": name, "hostPort": port})
	}

	rec := &ContainerRecord{
		Name:              name,
		ContainerID:       containerID,
		HostPort:          port,
		ContainerIP:       containerIP,
		Status:            "running",
		CreatedAt:         nowMillis(),
		LastAccessedAt:    nowMillis(),
		ActiveWebSockets:  0,
		InFlightProxyReqs: 0,
		OrgID:             opts.OrgID,
		WorkspaceID:       opts.WorkspaceID,
	}

	m.mu.Lock()
	m.containers[name] = rec
	if containerIP != "" {
		m.indexContainerIPLocked(containerIP, name)
	}
	m.mu.Unlock()

	log.Printf("[ContainerManager] created container %s (id=%s, port=%d)", name, containerID, port)
	m.trace("ensure_container_create_success", map[string]any{"name": name, "container": rec})
	m.upsertContainerState(rec)
	return copyRecord(rec), nil
}

func (m *Manager) GetContainer(name string) (*ContainerRecord, error) {
	m.mu.Lock()
	cached := m.containers[name]
	m.mu.Unlock()

	if cached != nil {
		if running, _ := m.isRunning(name); running {
			m.mu.Lock()
			if current := m.containers[name]; current != nil {
				current.LastAccessedAt = nowMillis()
				out := copyRecord(current)
				m.mu.Unlock()
				return out, nil
			}
			m.mu.Unlock()
		} else {
			m.mu.Lock()
			if current := m.containers[name]; current != nil {
				if current.ContainerIP != "" {
					m.unindexContainerIPLocked(current.ContainerIP)
				}
				delete(m.containers, name)
			}
			m.mu.Unlock()
			m.deleteContainerState(name)
		}
	}

	if running, _ := m.isRunning(name); running {
		port, containerIP := m.getHostPortAndIP(name)
		if port > 0 {
			rec := &ContainerRecord{
				Name:              name,
				ContainerID:       name,
				HostPort:          port,
				ContainerIP:       containerIP,
				Status:            "running",
				CreatedAt:         nowMillis(),
				LastAccessedAt:    nowMillis(),
				ActiveWebSockets:  0,
				InFlightProxyReqs: 0,
			}
			m.mu.Lock()
			m.containers[name] = rec
			if containerIP != "" {
				m.indexContainerIPLocked(containerIP, name)
			}
			m.mu.Unlock()
			m.trace("get_container_reconnected", map[string]any{"name": name, "container": rec})
			m.upsertContainerState(rec)
			return copyRecord(rec), nil
		}
	}

	return nil, nil
}

func (m *Manager) TerminateContainer(name, reason string) (bool, error) {
	m.mu.Lock()
	existing := copyRecord(m.containers[name])
	m.mu.Unlock()
	m.trace("terminate_container_request", map[string]any{"name": name, "reason": reason, "container": existing})

	stopCtx, stopCancel := context.WithTimeout(context.Background(), 15*time.Second)
	stopTimeoutSecs := 5
	stopErr := m.docker.ContainerStop(stopCtx, name, dockercontainer.StopOptions{Timeout: &stopTimeoutSecs})
	stopCancel()
	noSuchContainer := stopErr != nil && dockererrdefs.IsNotFound(stopErr)
	if stopErr != nil && !noSuchContainer {
		m.trace("terminate_container_stop_failed", map[string]any{"name": name, "reason": reason, "error": stopErr.Error()})
	}

	removeErr := m.removeContainerIfExists(name, true)
	terminated := removeErr == nil || noSuchContainer
	if !terminated {
		stillRunning, _ := m.isRunning(name)
		terminated = !stillRunning
		m.trace("terminate_container_postcheck", map[string]any{"name": name, "reason": reason, "stillRunning": stillRunning, "error": removeErr.Error()})
	}

	if terminated {
		m.mu.Lock()
		if current := m.containers[name]; current != nil {
			if current.ContainerIP != "" {
				m.unindexContainerIPLocked(current.ContainerIP)
			}
		}
		delete(m.containers, name)
		m.containerTerminatedAt[name] = time.Now().UTC()
		m.mu.Unlock()
		m.deleteContainerState(name)
		m.upsertTerminatedWorkspaceState(name, time.Now().UTC())

		log.Printf("[ContainerManager] terminated container %s", name)
		m.trace("terminate_container_success", map[string]any{"name": name, "reason": reason})
		go func() {
			if err := m.overlays.Sync(name); err != nil {
				log.Printf("[ContainerManager] post-terminate sync failed for %s: %v", name, err)
			}
		}()
		return true, nil
	}

	m.trace("terminate_container_failed", map[string]any{"name": name, "reason": reason})
	if removeErr != nil {
		return false, removeErr
	}
	if stopErr != nil {
		return false, stopErr
	}
	return false, nil
}

func (m *Manager) GetControlPlanePort(name string, opts EnsureContainerOptions) (int, error) {
	m.mu.Lock()
	rec := m.containers[name]
	if rec != nil {
		rec.LastAccessedAt = nowMillis()
		port := rec.HostPort
		m.mu.Unlock()
		return port, nil
	}
	m.mu.Unlock()

	reconnected, err := m.GetContainer(name)
	if err != nil {
		return 0, err
	}
	if reconnected == nil {
		log.Printf("[ContainerManager] control plane port missing for %s; recreating container", name)
		ensured, ensureErr := m.EnsureContainer(name, opts)
		if ensureErr != nil {
			return 0, ensureErr
		}
		return ensured.HostPort, nil
	}
	return reconnected.HostPort, nil
}

func (m *Manager) ListContainers() []ContainerRecord {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]ContainerRecord, 0, len(m.containers))
	for _, rec := range m.containers {
		out = append(out, *copyRecord(rec))
	}
	return out
}

func (m *Manager) runIdleReaper() {
	ticker := time.NewTicker(m.reaperInterval)
	defer ticker.Stop()
	for range ticker.C {
		if err := m.reapIdleContainers(); err != nil {
			log.Printf("[ContainerManager] reaper error: %v", err)
		}
	}
}

func (m *Manager) reapIdleContainers() error {
	now := nowMillis()

	type reaperCandidate struct {
		name           string
		lastAccessedAt int64
		activeWS       int
		inFlight       int
		pending        int
	}

	candidates := make([]reaperCandidate, 0)
	m.mu.Lock()
	for name, rec := range m.containers {
		pending := m.pendingWorkspaces[name]
		m.trace("reaper_scan", map[string]any{
			"name":                  name,
			"idleMs":                now - rec.LastAccessedAt,
			"activeWebSockets":      rec.ActiveWebSockets,
			"inFlightProxyRequests": rec.InFlightProxyReqs,
			"pendingEnsures":        pending,
		})
		candidates = append(candidates, reaperCandidate{
			name:           name,
			lastAccessedAt: rec.LastAccessedAt,
			activeWS:       rec.ActiveWebSockets,
			inFlight:       rec.InFlightProxyReqs,
			pending:        pending,
		})
	}
	m.mu.Unlock()

	for _, candidate := range candidates {
		if candidate.activeWS > 0 || candidate.inFlight > 0 || candidate.pending > 0 {
			continue
		}
		if now-candidate.lastAccessedAt < m.idleTimeout.Milliseconds() {
			continue
		}

		m.mu.Lock()
		current := m.containers[candidate.name]
		pending := m.pendingWorkspaces[candidate.name]
		currentActiveWS := 0
		currentInFlight := 0
		currentLastAccessed := int64(0)
		currentSnapshot := (*ContainerRecord)(nil)
		if current != nil {
			currentActiveWS = current.ActiveWebSockets
			currentInFlight = current.InFlightProxyReqs
			currentLastAccessed = current.LastAccessedAt
			currentSnapshot = copyRecord(current)
		}
		m.mu.Unlock()

		if current == nil {
			continue
		}
		if currentActiveWS > 0 || currentInFlight > 0 || pending > 0 {
			continue
		}
		if nowMillis()-currentLastAccessed < m.idleTimeout.Milliseconds() {
			continue
		}

		idleSeconds := int((nowMillis() - currentLastAccessed) / 1000)
		log.Printf("[ContainerManager] reaping idle container %s (idle=%ds)", candidate.name, idleSeconds)
		m.trace("reaper_terminate", map[string]any{"name": candidate.name, "idleMs": nowMillis() - currentLastAccessed, "container": currentSnapshot})
		_, _ = m.TerminateContainer(candidate.name, "idle_reaper")
	}

	return nil
}

func (m *Manager) runReclaimLoop() {
	ticker := time.NewTicker(m.reclaimInterval)
	defer ticker.Stop()
	for range ticker.C {
		if err := m.reclaimIdleOverlays(); err != nil {
			log.Printf("[ContainerManager] reclaim error: %v", err)
		}
	}
}

func (m *Manager) reclaimIdleOverlays() error {
	now := time.Now().UTC()
	mounted, err := m.overlays.ListMountedNames()
	if err != nil {
		return err
	}

	for _, name := range mounted {
		m.mu.Lock()
		_, alreadyTracked := m.containerTerminatedAt[name]
		m.mu.Unlock()
		if alreadyTracked {
			continue
		}
		if m.isWorkspaceActiveForReclaim(name) {
			continue
		}
		m.mu.Lock()
		m.containerTerminatedAt[name] = now
		m.mu.Unlock()
		m.upsertTerminatedWorkspaceState(name, now)
		m.trace("reclaim_track_inactive_overlay", map[string]any{"name": name, "trackedAt": now.UnixMilli()})
	}

	m.mu.Lock()
	tracked := make(map[string]time.Time, len(m.containerTerminatedAt))
	for name, ts := range m.containerTerminatedAt {
		tracked[name] = ts
	}
	m.mu.Unlock()

	for name, terminatedAt := range tracked {
		if m.isWorkspaceActiveForReclaim(name) {
			m.mu.Lock()
			delete(m.containerTerminatedAt, name)
			m.mu.Unlock()
			m.deleteTerminatedWorkspaceState(name)
			continue
		}

		if now.Sub(terminatedAt) < m.reclaimIdle {
			continue
		}

		if !m.overlays.Has(name) {
			m.mu.Lock()
			delete(m.containerTerminatedAt, name)
			m.mu.Unlock()
			m.deleteTerminatedWorkspaceState(name)
			continue
		}

		log.Printf("[ContainerManager] reclaiming NVMe for %s (idle=%ds)", name, int(now.Sub(terminatedAt).Seconds()))
		reclaimed, reclaimErr := m.overlays.Reclaim(name, func() bool {
			return !m.isWorkspaceActiveForReclaim(name)
		})
		if reclaimErr != nil {
			log.Printf("[ContainerManager] reclaim failed for %s: %v", name, reclaimErr)
			continue
		}
		if reclaimed {
			m.mu.Lock()
			delete(m.containerTerminatedAt, name)
			m.mu.Unlock()
			m.deleteTerminatedWorkspaceState(name)
		}
	}

	return nil
}

func (m *Manager) isWorkspaceActive(name string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.containers[name] != nil {
		return true
	}
	return m.pendingWorkspaces[name] > 0
}

func (m *Manager) isWorkspaceActiveForReclaim(name string) bool {
	if m.isWorkspaceActive(name) {
		return true
	}
	running, _ := m.isRunning(name)
	return running
}

func (m *Manager) getContainerBySourceIPCached(sourceIP string) *ContainerRecord {
	m.mu.Lock()
	defer m.mu.Unlock()

	if indexedName, ok := m.containerIPIndex[sourceIP]; ok {
		if rec := m.containers[indexedName]; rec != nil {
			return rec
		}
		delete(m.containerIPIndex, sourceIP)
	}

	for name, rec := range m.containers {
		if rec.ContainerIP == "" {
			continue
		}
		for _, key := range sourceIPKeys(rec.ContainerIP) {
			if key == sourceIP {
				m.containerIPIndex[sourceIP] = name
				return rec
			}
		}
	}

	return nil
}

func (m *Manager) indexContainerIPLocked(ip, name string) {
	for _, key := range sourceIPKeys(ip) {
		m.containerIPIndex[key] = name
	}
}

func (m *Manager) unindexContainerIPLocked(ip string) {
	for _, key := range sourceIPKeys(ip) {
		delete(m.containerIPIndex, key)
	}
}

func sourceIPKeys(ip string) []string {
	normalized := normalizeSourceIP(ip)
	if normalized == "" {
		return nil
	}
	keys := map[string]struct{}{normalized: {}}
	if ipv4Regex.MatchString(normalized) {
		keys["::ffff:"+normalized] = struct{}{}
	}
	out := make([]string, 0, len(keys))
	for key := range keys {
		out = append(out, key)
	}
	return out
}

var ipv4Regex = regexp.MustCompile(`^\d{1,3}(?:\.\d{1,3}){3}$`)

func normalizeSourceIP(ip string) string {
	trimmed := strings.TrimSpace(ip)
	return strings.TrimPrefix(trimmed, "::ffff:")
}

func (m *Manager) workspacePath(name string) string {
	return filepath.Join(m.workspacesRoot, name)
}

func (m *Manager) getHostPort(name string) (int, error) {
	inspect, err := m.inspectContainer(name, 30*time.Second)
	if err != nil {
		return 0, err
	}
	return hostPortFromInspect(inspect, m.controlPlanePort), nil
}

func (m *Manager) getContainerIP(name string) (string, error) {
	inspect, err := m.inspectContainer(name, 30*time.Second)
	if err != nil {
		return "", err
	}
	return containerIPFromInspect(inspect), nil
}

func (m *Manager) getHostPortAndIP(name string) (int, string) {
	inspect, err := m.inspectContainer(name, 30*time.Second)
	if err != nil {
		return 0, ""
	}
	return hostPortFromInspect(inspect, m.controlPlanePort), containerIPFromInspect(inspect)
}

func (m *Manager) isRunning(name string) (bool, error) {
	inspect, err := m.inspectContainer(name, 30*time.Second)
	if err != nil {
		if dockererrdefs.IsNotFound(err) {
			return false, nil
		}
		return false, err
	}
	return inspect.State != nil && inspect.State.Running, nil
}

func (m *Manager) waitForHealth(port int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	client := &http.Client{}

	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/health", port), nil)
		resp, err := client.Do(req)
		cancel()
		if err == nil && resp != nil {
			_ = resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				return true
			}
		}
		time.Sleep(m.healthPollInterval)
	}
	return false
}

func (m *Manager) inspectContainer(name string, timeout time.Duration) (dockercontainer.InspectResponse, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return m.docker.ContainerInspect(ctx, name)
}

func (m *Manager) removeContainerIfExists(name string, force bool) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	err := m.docker.ContainerRemove(ctx, name, dockercontainer.RemoveOptions{
		Force: force,
	})
	if err != nil && dockererrdefs.IsNotFound(err) {
		return nil
	}
	return err
}

func (m *Manager) loadPersistedState() {
	if m.state == nil {
		return
	}

	containers, err := m.state.LoadContainers()
	if err != nil {
		log.Printf("[ContainerManager] failed to load persisted containers: %v", err)
	} else {
		m.mu.Lock()
		for _, persisted := range containers {
			rec := &ContainerRecord{
				Name:              persisted.Name,
				ContainerID:       persisted.ContainerID,
				HostPort:          persisted.HostPort,
				ContainerIP:       persisted.ContainerIP,
				Status:            persisted.Status,
				CreatedAt:         persisted.CreatedAt.UnixMilli(),
				LastAccessedAt:    persisted.LastAccessedAt.UnixMilli(),
				ActiveWebSockets:  0, // cannot survive process crash safely
				InFlightProxyReqs: 0, // cannot survive process crash safely
				OrgID:             persisted.OrgID,
				WorkspaceID:       persisted.WorkspaceID,
			}
			m.containers[rec.Name] = rec
			if rec.ContainerIP != "" {
				m.indexContainerIPLocked(rec.ContainerIP, rec.Name)
			}
		}
		m.mu.Unlock()
		if len(containers) > 0 {
			log.Printf("[ContainerManager] restored %d persisted container record(s)", len(containers))
		}
	}

	terminated, err := m.state.LoadTerminatedWorkspaces()
	if err != nil {
		log.Printf("[ContainerManager] failed to load persisted terminated workspaces: %v", err)
		return
	}
	m.mu.Lock()
	for _, persisted := range terminated {
		m.containerTerminatedAt[persisted.Name] = persisted.TerminatedAt
	}
	m.mu.Unlock()
	if len(terminated) > 0 {
		log.Printf("[ContainerManager] restored %d reclaim-tracked workspace(s)", len(terminated))
	}
}

func (m *Manager) upsertContainerState(rec *ContainerRecord) {
	if m.state == nil || rec == nil {
		return
	}
	if err := m.state.UpsertContainer(state.ContainerRecord{
		Name:              rec.Name,
		ContainerID:       rec.ContainerID,
		HostPort:          rec.HostPort,
		ContainerIP:       rec.ContainerIP,
		Status:            rec.Status,
		CreatedAt:         time.UnixMilli(rec.CreatedAt).UTC(),
		LastAccessedAt:    time.UnixMilli(rec.LastAccessedAt).UTC(),
		ActiveWebSockets:  rec.ActiveWebSockets,
		InFlightProxyReqs: rec.InFlightProxyReqs,
		OrgID:             rec.OrgID,
		WorkspaceID:       rec.WorkspaceID,
	}); err != nil {
		log.Printf("[ContainerManager] failed to persist container %s: %v", rec.Name, err)
	}
}

func (m *Manager) deleteContainerState(name string) {
	if m.state == nil || strings.TrimSpace(name) == "" {
		return
	}
	if err := m.state.DeleteContainer(name); err != nil {
		log.Printf("[ContainerManager] failed to delete container state for %s: %v", name, err)
	}
}

func (m *Manager) upsertTerminatedWorkspaceState(name string, terminatedAt time.Time) {
	if m.state == nil || strings.TrimSpace(name) == "" {
		return
	}
	if err := m.state.UpsertTerminatedWorkspace(state.TerminatedWorkspaceRecord{
		Name:         name,
		TerminatedAt: terminatedAt.UTC(),
	}); err != nil {
		log.Printf("[ContainerManager] failed to persist terminated workspace %s: %v", name, err)
	}
}

func (m *Manager) deleteTerminatedWorkspaceState(name string) {
	if m.state == nil || strings.TrimSpace(name) == "" {
		return
	}
	if err := m.state.DeleteTerminatedWorkspace(name); err != nil {
		log.Printf("[ContainerManager] failed to delete terminated workspace state for %s: %v", name, err)
	}
}

func hostPortFromInspect(inspect dockercontainer.InspectResponse, controlPlanePort int) int {
	portKey := nat.Port(strconv.Itoa(controlPlanePort) + "/tcp")
	if inspect.NetworkSettings == nil || inspect.NetworkSettings.Ports == nil {
		return 0
	}
	bindings, ok := inspect.NetworkSettings.Ports[portKey]
	if !ok || len(bindings) == 0 {
		return 0
	}
	hostPort := strings.TrimSpace(bindings[0].HostPort)
	if hostPort == "" {
		return 0
	}
	parsed, err := strconv.Atoi(hostPort)
	if err != nil {
		return 0
	}
	return parsed
}

func containerIPFromInspect(inspect dockercontainer.InspectResponse) string {
	if inspect.NetworkSettings == nil || inspect.NetworkSettings.Networks == nil {
		return ""
	}
	for _, endpoint := range inspect.NetworkSettings.Networks {
		if endpoint == nil {
			continue
		}
		ip := strings.TrimSpace(endpoint.IPAddress)
		if ip != "" {
			return ip
		}
	}
	return ""
}

func copyRecord(rec *ContainerRecord) *ContainerRecord {
	if rec == nil {
		return nil
	}
	copied := *rec
	return &copied
}

func nowMillis() int64 {
	return time.Now().UTC().UnixMilli()
}

func (m *Manager) trace(event string, details map[string]any) {
	if !m.traceLifecycle {
		return
	}
	log.Printf("[ContainerManager][trace] %s %+v", event, details)
}

func envString(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) int {
	raw := envString(key, "")
	if strings.TrimSpace(raw) == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return parsed
}

func maxDuration(a, b time.Duration) time.Duration {
	if a > b {
		return a
	}
	return b
}
