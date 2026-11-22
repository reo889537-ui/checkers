package main

// Шашки — настольный клиент для Windows.
// Запускает локальный сервер со встроенным интерфейсом и открывает окно приложения
// (Edge или Chrome в режиме --app). Установка и зависимости не нужны.

import (
	"embed"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"time"
)

//go:embed play
var assets embed.FS

var lastSeen int64

func main() {
	sub, err := fs.Sub(assets, "play")
	if err != nil {
		panic(err)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	url := fmt.Sprintf("http://127.0.0.1:%d/", port)

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(sub)))
	mux.HandleFunc("/hb", func(w http.ResponseWriter, r *http.Request) {
		atomic.StoreInt64(&lastSeen, time.Now().Unix())
		w.Header().Set("Cache-Control", "no-store")
		w.Write([]byte("ok"))
	})
	mux.HandleFunc("/quit", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("bye"))
		go func() { time.Sleep(150 * time.Millisecond); os.Exit(0) }()
	})
	atomic.StoreInt64(&lastSeen, time.Now().Unix())

	go func() {
		if err := http.Serve(ln, mux); err != nil {
			fmt.Println("server:", err)
		}
	}()

	openWindow(url)

	// Приложение живёт, пока страница присылает пульс.
	for {
		time.Sleep(2 * time.Second)
		if time.Now().Unix()-atomic.LoadInt64(&lastSeen) > 20 {
			time.Sleep(20 * time.Second) // шанс восстановиться после сна системы
			if time.Now().Unix()-atomic.LoadInt64(&lastSeen) > 20 {
				return
			}
		}
	}
}

func candidates() []string {
	var out []string
	env := os.Getenv("ProgramFiles(x86)")
	pf := os.Getenv("ProgramFiles")
	la := os.Getenv("LOCALAPPDATA")
	rels := []string{
		filepath.Join("Microsoft", "Edge", "Application", "msedge.exe"),
		filepath.Join("Google", "Chrome", "Application", "chrome.exe"),
	}
	for _, base := range []string{env, pf, la} {
		if base == "" {
			continue
		}
		for _, rel := range rels {
			out = append(out, filepath.Join(base, rel))
		}
	}
	return out
}

func openWindow(url string) {
	for _, exe := range candidates() {
		if _, err := os.Stat(exe); err != nil {
			continue
		}
		cmd := exec.Command(exe,
			"--app="+url,
			"--window-size=1280,880",
			"--user-data-dir="+filepath.Join(os.TempDir(), "checkers-app"),
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-features=Translate",
		)
		if err := cmd.Start(); err == nil {
			return
		}
	}
	exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}
