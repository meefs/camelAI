package app

import (
	"os"
	"strconv"
	"time"
)

type Config struct {
	Port                       int
	ListenAddr                 string
	ProxyPort                  int
	ProxyListenAddr            string
	IdleTimeout                time.Duration
	ReadHeaderTimeout          time.Duration
	WriteTimeout               time.Duration
	WorkerBaseURL              string
	SandboxProxySecret         string
	ProxyThreadActiveTTL       time.Duration
	ProxyThreadCloseGrace      time.Duration
	ProxyThreadCleanupInterval time.Duration
	TraceSandboxHost           bool
	HeaderWorkerBaseURL        string
	HeaderThreadID             string
	HeaderSandboxSecret        string
	StateDBPath                string
}

func LoadConfig() Config {
	controlPort := envInt("PORT", 80)
	proxyPort := envInt("SANDBOX_PROXY_PORT", 8081)
	idleSecs := maxInt(10, envInt("SANDBOX_HOST_IDLE_TIMEOUT_SECS", 120))
	activeTTLms := maxInt(30_000, envInt("PROXY_SESSION_ACTIVE_TTL_MS", 30*60_000))
	closeGraceMs := maxInt(5_000, envInt("PROXY_SESSION_CLOSE_GRACE_MS", 10*60_000))
	cleanupMs := maxInt(5_000, envInt("PROXY_SESSION_CLEANUP_INTERVAL_MS", 60_000))

	return Config{
		Port:                       controlPort,
		ListenAddr:                 ":" + strconv.Itoa(controlPort),
		ProxyPort:                  proxyPort,
		ProxyListenAddr:            ":" + strconv.Itoa(proxyPort),
		IdleTimeout:                time.Duration(idleSecs) * time.Second,
		ReadHeaderTimeout:          15 * time.Second,
		WriteTimeout:               0,
		WorkerBaseURL:              envString("WORKER_BASE_URL", ""),
		SandboxProxySecret:         envString("SANDBOX_PROXY_SECRET", ""),
		ProxyThreadActiveTTL:       time.Duration(activeTTLms) * time.Millisecond,
		ProxyThreadCloseGrace:      time.Duration(closeGraceMs) * time.Millisecond,
		ProxyThreadCleanupInterval: time.Duration(cleanupMs) * time.Millisecond,
		TraceSandboxHost:           envString("TRACE_SANDBOX_HOST", "") == "1",
		HeaderWorkerBaseURL:        "x-chiridion-worker-base-url",
		HeaderThreadID:             "x-chiridion-thread-id",
		HeaderSandboxSecret:        "x-sandbox-secret",
		StateDBPath:                envString("SANDBOX_HOST_STATE_DB", "/mnt/nvme/.sandbox-host/state.db"),
	}
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

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
