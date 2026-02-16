package main

import (
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/chiridion/sandbox-host/internal/app"
	"github.com/chiridion/sandbox-host/internal/container"
	"github.com/chiridion/sandbox-host/internal/fsops"
	"github.com/chiridion/sandbox-host/internal/overlay"
	"github.com/chiridion/sandbox-host/internal/state"
)

func main() {
	cfg := app.LoadConfig()
	stateStore, err := state.Open(cfg.StateDBPath)
	if err != nil {
		log.Printf("[SandboxHost] state DB unavailable (%s): %v; running without crash-recovery state", cfg.StateDBPath, err)
	}
	if stateStore != nil {
		defer func() {
			if closeErr := stateStore.Close(); closeErr != nil {
				log.Printf("[SandboxHost] failed to close state DB: %v", closeErr)
			}
		}()
	}

	overlays := overlay.NewManagerFromEnv()
	containers := container.NewManager(overlays, stateStore)
	fsManager := fsops.NewManager(os.Getenv("WORKSPACES_ROOT"))
	server := app.NewServer(cfg, containers, overlays, fsManager, stateStore)

	go app.MountR2OnHost()

	httpServer := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           server.Handler(),
		ReadHeaderTimeout: cfg.ReadHeaderTimeout,
		IdleTimeout:       cfg.IdleTimeout,
		WriteTimeout:      cfg.WriteTimeout,
	}
	proxyServer := &http.Server{
		Addr:              cfg.ProxyListenAddr,
		Handler:           server.ProxyHandler(),
		ReadHeaderTimeout: cfg.ReadHeaderTimeout,
		IdleTimeout:       cfg.IdleTimeout,
		WriteTimeout:      cfg.WriteTimeout,
	}

	errCh := make(chan error, 2)

	log.Printf("[SandboxHost] control listener on %s", cfg.ListenAddr)
	go func() {
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- fmt.Errorf("control listener failed: %w", err)
		}
	}()

	log.Printf("[SandboxHost] proxy listener on %s", cfg.ProxyListenAddr)
	go func() {
		if err := proxyServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- fmt.Errorf("proxy listener failed: %w", err)
		}
	}()

	log.Fatalf("sandbox-host stopped: %v", <-errCh)
}
