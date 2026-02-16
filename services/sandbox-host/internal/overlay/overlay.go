package overlay

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

type ManagerConfig struct {
	JFSRoot        string
	NVMERoot       string
	WorkspacesRoot string
	Backend        string
	SyncInterval   time.Duration
	SyncTimeout    time.Duration
	JFSMetaURL     string
}

type Mount struct {
	Name         string
	LowerDir     string
	UpperDir     string
	WorkDir      string
	MergedDir    string
	MountedAt    time.Time
	LastSyncedAt time.Time

	mu      sync.Mutex
	syncing bool
}

type Manager struct {
	cfg              ManagerConfig
	useDirectBackend bool
	mu               sync.RWMutex
	mounts           map[string]*Mount
}

func NewManagerFromEnv() *Manager {
	defaultBackend := "overlay"
	if runtime.GOOS != "linux" {
		defaultBackend = "direct"
	}
	backend := strings.ToLower(strings.TrimSpace(envString("OVERLAY_BACKEND", defaultBackend)))
	if backend != "overlay" && backend != "direct" {
		log.Printf("[Overlay] ignoring unsupported OVERLAY_BACKEND=%q; using %q", backend, defaultBackend)
		backend = defaultBackend
	}

	cfg := ManagerConfig{
		JFSRoot:        envString("JFS_ROOT", defaultJFSRoot()),
		NVMERoot:       envString("NVME_ROOT", defaultNVMERoot()),
		WorkspacesRoot: envString("WORKSPACES_ROOT", defaultWorkspaceRoot()),
		Backend:        backend,
		SyncInterval:   time.Duration(envInt("OVERLAY_SYNC_INTERVAL_MS", 60_000)) * time.Millisecond,
		SyncTimeout:    10 * time.Minute,
	}

	cfg.JFSMetaURL = envString("JFS_META_URL", "")
	if cfg.JFSMetaURL == "" {
		host := strings.TrimSpace(os.Getenv("PG_HOST"))
		password := os.Getenv("PG_PASSWORD")
		if host != "" && password != "" {
			cfg.JFSMetaURL = fmt.Sprintf("postgres://chiridion:%s@%s:5432/juicefs?sslmode=require", password, host)
		}
	}

	if cfg.SyncInterval < 1*time.Second {
		cfg.SyncInterval = 1 * time.Second
	}

	return NewManager(cfg)
}

func NewManager(cfg ManagerConfig) *Manager {
	useDirectBackend := strings.EqualFold(cfg.Backend, "direct")
	m := &Manager{
		cfg:              cfg,
		useDirectBackend: useDirectBackend,
		mounts:           make(map[string]*Mount),
	}
	if useDirectBackend {
		log.Printf("[Overlay] running in direct workspace mode (overlayfs + juicefs sync disabled)")
		return m
	}
	go m.runBackgroundSync()
	log.Printf("[Overlay] background sync started (interval=%ds, engine=%s)", int(cfg.SyncInterval/time.Second), engineName(cfg.JFSMetaURL))
	return m
}

func engineName(metaURL string) string {
	if strings.TrimSpace(metaURL) == "" {
		return "UNCONFIGURED"
	}
	return "juicefs-sync"
}

func (m *Manager) mountRecord(name string) *Mount {
	now := time.Now().UTC()
	return &Mount{
		Name:         name,
		LowerDir:     filepath.Join(m.cfg.JFSRoot, name),
		UpperDir:     filepath.Join(m.cfg.NVMERoot, name),
		WorkDir:      filepath.Join(m.cfg.NVMERoot, ".work", name),
		MergedDir:    filepath.Join(m.cfg.WorkspacesRoot, name),
		MountedAt:    now,
		LastSyncedAt: now,
	}
}

func (m *Manager) hydrateMountFromFS(name string) *Mount {
	m.mu.RLock()
	existing := m.mounts[name]
	m.mu.RUnlock()
	if existing != nil {
		return existing
	}

	candidate := m.mountRecord(name)
	if !m.isWorkspaceReady(candidate.MergedDir) {
		return nil
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if already := m.mounts[name]; already != nil {
		return already
	}
	m.mounts[name] = candidate
	log.Printf("[Overlay] hydrated mount record for %s", name)
	return candidate
}

func (m *Manager) Ensure(name string) (string, error) {
	m.mu.RLock()
	existing := m.mounts[name]
	m.mu.RUnlock()
	if existing != nil && m.isWorkspaceReady(existing.MergedDir) {
		return existing.MergedDir, nil
	}

	mount := m.mountRecord(name)
	if m.useDirectBackend {
		if err := os.MkdirAll(mount.MergedDir, 0o755); err != nil {
			return "", err
		}
		_ = os.Chown(mount.MergedDir, 1001, 1001)
	} else {
		for _, dir := range []string{mount.LowerDir, mount.UpperDir, mount.WorkDir, mount.MergedDir} {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return "", err
			}
		}

		_ = os.Chown(mount.LowerDir, 1001, 1001)
		_ = os.Chown(mount.UpperDir, 1001, 1001)

		if !isMounted(mount.MergedDir) {
			opts := fmt.Sprintf("lowerdir=%s,upperdir=%s,workdir=%s", mount.LowerDir, mount.UpperDir, mount.WorkDir)
			if _, err := runCommand(30*time.Second, "mount", "-t", "overlay", "overlay", "-o", opts, mount.MergedDir); err != nil {
				return "", err
			}
			log.Printf("[Overlay] mounted %s: lower=%s upper=%s merged=%s", name, mount.LowerDir, mount.UpperDir, mount.MergedDir)
		}
	}

	m.mu.Lock()
	m.mounts[name] = mount
	m.mu.Unlock()

	return mount.MergedDir, nil
}

func (m *Manager) Sync(name string) error {
	if m.useDirectBackend {
		return nil
	}

	mount := m.getMount(name)
	if mount == nil {
		return nil
	}

	mount.mu.Lock()
	if mount.syncing {
		mount.mu.Unlock()
		log.Printf("[Overlay] %s: sync already in progress, skipping", name)
		return nil
	}
	mount.syncing = true
	mount.mu.Unlock()

	defer func() {
		mount.mu.Lock()
		mount.syncing = false
		mount.mu.Unlock()
	}()

	start := time.Now()
	if err := m.runJfsSync(mount.MergedDir, name); err != nil {
		log.Printf("[Overlay] sync failed for %s: %v", name, err)
		return nil
	}

	mount.mu.Lock()
	mount.LastSyncedAt = time.Now().UTC()
	mount.mu.Unlock()
	log.Printf("[Overlay] %s: synced to JuiceFS (%ds)", name, int(time.Since(start).Seconds()))
	return nil
}

func (m *Manager) Has(name string) bool {
	mount := m.getMount(name)
	if mount == nil {
		mount = m.hydrateMountFromFS(name)
	}
	return mount != nil && m.isWorkspaceReady(mount.MergedDir)
}

func (m *Manager) ListMountedNames() ([]string, error) {
	entries, err := os.ReadDir(m.cfg.WorkspacesRoot)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}

	names := make(map[string]struct{})
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		mount := m.getMount(name)
		if mount == nil {
			mount = m.hydrateMountFromFS(name)
		}
		if mount != nil && m.isWorkspaceReady(mount.MergedDir) {
			names[name] = struct{}{}
		}
	}

	m.mu.Lock()
	for name, mount := range m.mounts {
		if !m.isWorkspaceReady(mount.MergedDir) {
			delete(m.mounts, name)
			continue
		}
		names[name] = struct{}{}
	}
	m.mu.Unlock()

	out := make([]string, 0, len(names))
	for name := range names {
		out = append(out, name)
	}
	return out, nil
}

func (m *Manager) Reclaim(name string, isSafe func() bool) (bool, error) {
	if m.useDirectBackend {
		return false, nil
	}

	mount := m.getMount(name)
	if mount == nil {
		mount = m.hydrateMountFromFS(name)
	}
	if mount == nil {
		return false, nil
	}

	mount.mu.Lock()
	if mount.syncing {
		mount.mu.Unlock()
		return false, nil
	}
	mount.syncing = true
	mount.mu.Unlock()
	defer func() {
		mount.mu.Lock()
		mount.syncing = false
		mount.mu.Unlock()
	}()

	if !m.Has(name) {
		log.Printf("[Overlay] %s: reclaim skipped - overlay already removed", name)
		return false, nil
	}

	start := time.Now()
	if err := m.runJfsSync(mount.MergedDir, name); err != nil {
		log.Printf("[Overlay] %s: reclaim final sync failed, continuing: %v", name, err)
	} else {
		mount.mu.Lock()
		mount.LastSyncedAt = time.Now().UTC()
		mount.mu.Unlock()
		log.Printf("[Overlay] %s: reclaim final sync (%ds)", name, int(time.Since(start).Seconds()))
	}

	if !isSafe() {
		log.Printf("[Overlay] %s: reclaim aborted - workspace became active during sync", name)
		return false, nil
	}

	if isMounted(mount.MergedDir) {
		if _, err := runCommand(30*time.Second, "umount", mount.MergedDir); err != nil {
			log.Printf("[Overlay] %s: regular umount failed, using lazy umount", name)
			if _, lazyErr := runCommand(30*time.Second, "umount", "-l", mount.MergedDir); lazyErr != nil {
				return false, lazyErr
			}
		}
	}

	suffix := strconv.FormatInt(time.Now().UnixMilli(), 10)
	oldUpper := mount.UpperDir + ".reclaim-" + suffix
	oldWork := mount.WorkDir + ".reclaim-" + suffix
	_ = os.Rename(mount.UpperDir, oldUpper)
	_ = os.Rename(mount.WorkDir, oldWork)

	m.mu.Lock()
	delete(m.mounts, name)
	m.mu.Unlock()

	go func(upper, work string) {
		_, err := runCommand(5*time.Minute, "rm", "-rf", upper, work)
		if err != nil {
			log.Printf("[Overlay] %s: reclaim cleanup failed: %v", name, err)
		}
	}(oldUpper, oldWork)

	log.Printf("[Overlay] %s: reclaimed NVMe", name)
	return true, nil
}

func (m *Manager) getMount(name string) *Mount {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.mounts[name]
}

func (m *Manager) runBackgroundSync() {
	if m.useDirectBackend {
		return
	}

	ticker := time.NewTicker(m.cfg.SyncInterval)
	defer ticker.Stop()

	for range ticker.C {
		now := time.Now()

		m.mu.RLock()
		mounts := make([]*Mount, 0, len(m.mounts))
		for _, mount := range m.mounts {
			mounts = append(mounts, mount)
		}
		m.mu.RUnlock()

		for _, mount := range mounts {
			if !m.isWorkspaceReady(mount.MergedDir) {
				m.mu.Lock()
				delete(m.mounts, mount.Name)
				m.mu.Unlock()
				continue
			}

			mount.mu.Lock()
			since := now.Sub(mount.LastSyncedAt)
			mount.mu.Unlock()

			if since >= m.cfg.SyncInterval {
				_ = m.Sync(mount.Name)
			}
		}
	}
}

func (m *Manager) runJfsSync(srcDir, dstSubPath string) error {
	if strings.TrimSpace(m.cfg.JFSMetaURL) == "" {
		return errors.New("JFS_META_URL not configured (need PG_HOST + PG_PASSWORD or JFS_META_URL)")
	}

	ctx, cancel := context.WithTimeout(context.Background(), m.cfg.SyncTimeout)
	defer cancel()

	cmd := exec.CommandContext(
		ctx,
		"juicefs",
		"sync",
		srcDir+"/",
		"jfs://VOL/"+dstSubPath+"/",
		"--delete-dst",
		"--perms",
		"--links",
		"--dirs",
		"--threads",
		"4",
		"--no-https",
	)
	cmd.Env = append(os.Environ(), "VOL="+m.cfg.JFSMetaURL)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("juicefs sync failed: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func (m *Manager) isWorkspaceReady(path string) bool {
	if m.useDirectBackend {
		info, err := os.Stat(path)
		return err == nil && info.IsDir()
	}
	return isMounted(path)
}

func isMounted(path string) bool {
	_, err := runCommand(30*time.Second, "mountpoint", "-q", path)
	return err == nil
}

func runCommand(timeout time.Duration, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	out, err := cmd.CombinedOutput()
	output := strings.TrimSpace(string(out))
	if err != nil {
		return output, fmt.Errorf("%s %s failed: %w: %s", name, strings.Join(args, " "), err, output)
	}
	return output, nil
}

func envString(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) int {
	raw := envString(key, "")
	if raw == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return parsed
}

func defaultLocalRoot() string {
	wd, err := os.Getwd()
	if err != nil || wd == "" {
		return ".sandbox-host"
	}
	return filepath.Join(wd, ".sandbox-host")
}

func defaultJFSRoot() string {
	if runtime.GOOS == "linux" {
		return "/mnt/juicefs"
	}
	return filepath.Join(defaultLocalRoot(), "juicefs")
}

func defaultNVMERoot() string {
	if runtime.GOOS == "linux" {
		return "/mnt/nvme"
	}
	return filepath.Join(defaultLocalRoot(), "nvme")
}

func defaultWorkspaceRoot() string {
	if runtime.GOOS == "linux" {
		return "/mnt/workspaces"
	}
	return filepath.Join(defaultLocalRoot(), "workspaces")
}
