package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/chiridion/sandbox-host/internal/app"
	"github.com/chiridion/sandbox-host/internal/container"
	"github.com/chiridion/sandbox-host/internal/fsops"
	"github.com/chiridion/sandbox-host/internal/state"
	"github.com/chiridion/sandbox-host/internal/workspace"
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

	// Per-org usage databases live alongside the state DB.
	usageDir := filepath.Join(filepath.Dir(cfg.StateDBPath), "usage")
	usageStore, err := state.NewUsageStore(usageDir)
	if err != nil {
		log.Printf("[SandboxHost] usage store unavailable (%s): %v; running without spend tracking", usageDir, err)
	}
	if usageStore != nil {
		defer func() {
			if closeErr := usageStore.Close(); closeErr != nil {
				log.Printf("[SandboxHost] failed to close usage store: %v", closeErr)
			}
		}()
	}

	workspaces := workspace.NewManagerFromEnv()
	containers := container.NewManager(workspaces)
	fsManager := fsops.NewManager(os.Getenv("WORKSPACES_ROOT"))
	server := app.NewServer(cfg, containers, workspaces, fsManager, stateStore, usageStore)

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
	shutdownDone := make(chan struct{})

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

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-sigCh
		log.Printf("[SandboxHost] received %s; draining active Pi turns before shutdown", sig)
		server.BeginDrain("signal:" + sig.String())
		drainCtx, cancelDrain := context.WithTimeout(context.Background(), 30*time.Minute)
		if err := server.WaitForHostPiIdle(drainCtx, 500*time.Millisecond); err != nil {
			log.Printf("[SandboxHost] drain before shutdown timed out with activePiTurns=%d: %v", server.ActiveHostPiTurnCount(), err)
		}
		cancelDrain()

		shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 30*time.Second)
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			log.Printf("[SandboxHost] control listener shutdown failed: %v", err)
		}
		if err := proxyServer.Shutdown(shutdownCtx); err != nil {
			log.Printf("[SandboxHost] proxy listener shutdown failed: %v", err)
		}
		cancelShutdown()
		server.StopHostPiBridges()
		close(shutdownDone)
	}()

	select {
	case err := <-errCh:
		log.Fatalf("sandbox-host stopped: %v", err)
	case <-shutdownDone:
		log.Printf("[SandboxHost] shutdown complete")
	}
}
