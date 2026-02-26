package app

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Port                       int
	ListenAddr                 string
	ProxyPort                  int
	ProxyListenAddr            string
	DataProxyUpstreamURL       string
	OpenAIProxyUpstreamURL     string
	OpenAIProxyAuthToken       string
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
	HeaderUserID               string
	HeaderSandboxSecret        string
	StateDBPath                string
}

type DataProxyServiceConfig struct {
	Port              int
	ListenAddr        string
	IdleTimeout       time.Duration
	ReadHeaderTimeout time.Duration
	WriteTimeout      time.Duration
	HandlerConfig     DataProxyHandlerConfig
}

func LoadConfig() Config {
	controlPort := envInt("PORT", defaultByPlatform(80, 4400))
	proxyPort := envInt("SANDBOX_PROXY_PORT", defaultByPlatform(8081, 4401))
	dataProxyPort := envInt("DATA_PROXY_PORT", defaultByPlatform(8090, 8090))
	cfAccountID := strings.TrimSpace(envString("CF_ACCOUNT_ID", ""))
	cfGatewayName := strings.TrimSpace(envString("CF_GATEWAY_NAME", ""))
	defaultOpenAIProxyUpstreamURL := ""
	if cfAccountID != "" && cfGatewayName != "" {
		defaultOpenAIProxyUpstreamURL = fmt.Sprintf(
			"https://gateway.ai.cloudflare.com/v1/%s/%s/compat",
			cfAccountID,
			cfGatewayName,
		)
	}
	idleSecs := maxInt(10, envInt("SANDBOX_HOST_IDLE_TIMEOUT_SECS", 120))
	activeTTLms := maxInt(30_000, envInt("PROXY_SESSION_ACTIVE_TTL_MS", 30*60_000))
	closeGraceMs := maxInt(5_000, envInt("PROXY_SESSION_CLOSE_GRACE_MS", 10*60_000))
	cleanupMs := maxInt(5_000, envInt("PROXY_SESSION_CLEANUP_INTERVAL_MS", 60_000))

	return Config{
		Port:                       controlPort,
		ListenAddr:                 ":" + strconv.Itoa(controlPort),
		ProxyPort:                  proxyPort,
		ProxyListenAddr:            ":" + strconv.Itoa(proxyPort),
		DataProxyUpstreamURL:       envString("DATA_PROXY_UPSTREAM_URL", "http://127.0.0.1:"+strconv.Itoa(dataProxyPort)),
		OpenAIProxyUpstreamURL:     envString("OPENAI_PROXY_UPSTREAM_URL", defaultOpenAIProxyUpstreamURL),
		OpenAIProxyAuthToken:       firstNonEmpty(envString("OPENAI_PROXY_AUTH_TOKEN", ""), envString("CF_GATEWAY_TOKEN", "")),
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
		HeaderUserID:               "x-chiridion-user-id",
		HeaderSandboxSecret:        "x-sandbox-secret",
		StateDBPath:                envString("SANDBOX_HOST_STATE_DB", defaultStateDBPath()),
	}
}

func LoadDataProxyServiceConfig() DataProxyServiceConfig {
	dataProxyPort := envInt("DATA_PROXY_PORT", defaultByPlatform(8090, 8090))
	idleSecs := maxInt(10, envInt("DATA_PROXY_IDLE_TIMEOUT_SECS", 120))
	requestLimit := envInt64("DATA_PROXY_MAX_REQUEST_BYTES", defaultDataProxyRequestLimitBytes)

	return DataProxyServiceConfig{
		Port:              dataProxyPort,
		ListenAddr:        ":" + strconv.Itoa(dataProxyPort),
		IdleTimeout:       time.Duration(idleSecs) * time.Second,
		ReadHeaderTimeout: 15 * time.Second,
		WriteTimeout:      0,
		HandlerConfig: DataProxyHandlerConfig{
			RequestBodyLimitBytes: requestLimit,
		},
	}
}

func defaultByPlatform(linuxValue, otherValue int) int {
	if runtime.GOOS == "linux" {
		return linuxValue
	}
	return otherValue
}

func defaultStateDBPath() string {
	if runtime.GOOS == "linux" {
		return "/srv/sandboxes/.sandbox-host/state.db"
	}
	wd, err := os.Getwd()
	if err != nil || wd == "" {
		return ".sandbox-host/state.db"
	}
	return filepath.Join(wd, ".sandbox-host", "state.db")
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

func envInt64(key string, fallback int64) int64 {
	raw := envString(key, "")
	if raw == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(raw, 10, 64)
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
