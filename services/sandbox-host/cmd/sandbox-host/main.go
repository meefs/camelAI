package main

import (
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/chiridion/sandbox-host/internal/app"
	"github.com/chiridion/sandbox-host/internal/container"
	"github.com/chiridion/sandbox-host/internal/fsops"
	"github.com/chiridion/sandbox-host/internal/workspace"
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

	r2Cfg := app.LoadR2MountConfig()
	if r2Cfg != nil {
		go func() {
			if err := app.MountR2OnHost(r2Cfg); err != nil {
				log.Printf("[SandboxHost] R2 host mount failed: %v (containers will start without R2)", err)
			}
		}()
	}

	workspaces := workspace.NewManagerFromEnv()
	containers := container.NewManager(workspaces, stateStore)
	fsManager := fsops.NewManager(os.Getenv("WORKSPACES_ROOT"))
	server := app.NewServer(cfg, containers, workspaces, fsManager, stateStore)

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
