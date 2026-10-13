package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func putTags(t *testing.T, h http.Handler, name, body string, auth bool) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest("PUT", "/api/posts/"+name+"/tags", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	if auth {
		r.Header.Set("Authorization", "Bearer "+testToken)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestTagsAPIAndPersistence(t *testing.T) {
	_, images, h := setup(t)
	data := filepath.Dir(images)
	raw := pngImage(t)
	if err := os.WriteFile(filepath.Join(images, "one.png"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	get(t, h, "/api/posts") // Warm the dimension cache.
	get(t, h, "/api/posts")
	url := "/api/posts/one.png/tags"
	if w := get(t, h, url); w.Code != 200 || !strings.Contains(w.Body.String(), `"tags":[]`) {
		t.Fatalf("anonymous read: %d %s", w.Code, w.Body.String())
	}
	body := `{"tags":["作品 ひとつ","nsfw"]}`
	if w := putTags(t, h, "one.png", body, false); w.Code != 401 || strings.Contains(w.Body.String(), testToken) {
		t.Fatalf("unauthenticated write: %d", w.Code)
	}
	if w := putTags(t, h, "one.png", body, true); w.Code != 200 {
		t.Fatalf("write: %d %s", w.Code, w.Body.String())
	}
	var list struct {
		Items []item `json:"items"`
	}
	if w := get(t, h, "/api/posts"); w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &list) != nil || len(list.Items) != 1 || len(list.Items[0].Tags) != 2 {
		t.Fatalf("cached list did not reflect tags: %d %+v", w.Code, list.Items)
	}
	if saved, err := os.ReadFile(filepath.Join(images, "one.png")); err != nil || !bytes.Equal(saved, raw) {
		t.Fatal("tag edit changed original image", err)
	}
	if w := get(t, h, url); w.Code != 200 || !strings.Contains(w.Body.String(), "作品 ひとつ") {
		t.Fatalf("direct tag read: %d %s", w.Code, w.Body.String())
	}
	restarted, err := newServer(data, testToken)
	if err != nil {
		t.Fatal("restart: ", err)
	}
	defer restarted.images.Close()
	defer restarted.data.Close()
	if w := get(t, restarted.routes(), url); w.Code != 200 || !strings.Contains(w.Body.String(), "作品 ひとつ") {
		t.Fatalf("lost tags after restart: %d %s", w.Code, w.Body.String())
	}
	if w := putTags(t, h, "one.png", `{"tags":[]}`, true); w.Code != 200 {
		t.Fatalf("remove tags: %d", w.Code)
	}
	if w := get(t, h, "/api/posts"); w.Code != 200 || strings.Contains(w.Body.String(), "作品 ひとつ") {
		t.Fatalf("tag removal not reflected: %d", w.Code)
	}
}

func TestTagsRejectInvalidAndUnsafeImages(t *testing.T) {
	_, images, h := setup(t)
	if err := os.WriteFile(filepath.Join(images, "one.png"), pngImage(t), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("one.png", filepath.Join(images, "link.png")); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"link.png", "..%2Fone.png", ".hidden.png", "missing.png"} {
		if w := putTags(t, h, name, `{"tags":[]}`, true); w.Code == 200 {
			t.Fatalf("unsafe filename %s accepted", name)
		}
	}
	for _, body := range []string{
		`null`, `{}`, `{"tags":null}`, `{"tags":{}}`, `{"tags":[]}`, `{"tags":[],"extra":1}`, `{"tags":[],"tags":[]}`,
		`{"tags":[""]}`, `{"tags":[" x"]}`, `{"tags":[1]}`, `{"tags":[{"name":"x"}]}`,
		`{"tags":["X","x"]}`, `{"tags":["` + strings.Repeat("x", 81) + `"]}`,
		`{"tags":["x","y","z","a","b","c"]}`,
	} {
		if w := putTags(t, h, "one.png", body, true); w.Code != 400 {
			t.Fatalf("invalid tag payload accepted (%d): %s", w.Code, body)
		}
	}
	if w := get(t, h, "/api/posts/one.png/tags"); w.Code != 200 || !strings.Contains(w.Body.String(), `"tags":[]`) {
		t.Fatalf("invalid writes changed state: %d %s", w.Code, w.Body.String())
	}
}

func TestTagSaveFailureAndCorruptStartup(t *testing.T) {
	s, images, h := setup(t)
	data := filepath.Dir(images)
	if err := os.WriteFile(filepath.Join(images, "one.png"), pngImage(t), 0600); err != nil {
		t.Fatal(err)
	}
	if w := putTags(t, h, "one.png", `{"tags":["before"]}`, true); w.Code != 200 {
		t.Fatalf("initial write: %d", w.Code)
	}
	if err := s.data.Close(); err != nil {
		t.Fatal(err)
	}
	if w := putTags(t, h, "one.png", `{"tags":["after"]}`, true); w.Code != 503 {
		t.Fatalf("failed save: %d", w.Code)
	}
	if w := get(t, h, "/api/posts/one.png/tags"); w.Code != 503 {
		t.Fatalf("failed storage did not close reads: %d", w.Code)
	}
	loaded, err := os.OpenRoot(data)
	if err != nil {
		t.Fatal(err)
	}
	persisted, err := readTags(loaded)
	loaded.Close()
	if err != nil || len(persisted["one.png"]) != 1 || persisted["one.png"][0] != "before" {
		t.Fatalf("failed save changed disk: %+v %v", persisted, err)
	}
	for _, bad := range []string{`{`, `{"one.png":null}`, `{"../oops.png":[]}`, `{"one.png":[],"one.png":[]}`, `{"one.png":[{"name":"x"}]}`} {
		if err := os.WriteFile(filepath.Join(data, "tags.json"), []byte(bad), 0600); err != nil {
			t.Fatal(err)
		}
		if restarted, err := newServer(data, testToken); err == nil {
			restarted.images.Close()
			restarted.data.Close()
			t.Fatalf("corrupt tags accepted: %s", bad)
		}
	}
	if err := os.Remove(filepath.Join(data, "tags.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(images, "one.png"), filepath.Join(data, "tags.json")); err != nil {
		t.Fatal(err)
	}
	if restarted, err := newServer(data, testToken); err == nil {
		restarted.images.Close()
		restarted.data.Close()
		t.Fatal("symlink tag file accepted")
	}
	if err := os.Remove(filepath.Join(data, "tags.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "tags.json"), []byte("{}"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(data, "tags.json"), 0644); err != nil {
		t.Fatal(err)
	}
	if restarted, err := newServer(data, testToken); err == nil {
		restarted.images.Close()
		restarted.data.Close()
		t.Fatal("public tag file accepted")
	}
}

func TestDedupeKeepsTaggedContent(t *testing.T) {
	s, images, h := setup(t)
	raw := pngImage(t)
	for _, name := range []string{"a.png", "b.png", "c.png", "d.png"} {
		if err := os.WriteFile(filepath.Join(images, name), raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"a.png", "b.png"} {
		body := `{"tags":["` + name + `"]}`
		if w := putTags(t, h, name, body, true); w.Code != 200 {
			t.Fatalf("tag %s: %d", name, w.Code)
		}
	}
	if removed, err := dedupe(s.images, s.tags); err != nil || removed != 1 {
		t.Fatalf("dedupe: %d %v", removed, err)
	}
	for _, name := range []string{"a.png", "b.png"} {
		if _, err := os.Stat(filepath.Join(images, name)); err != nil {
			t.Fatalf("tagged image %s deleted: %v", name, err)
		}
	}
	if err := os.WriteFile(filepath.Join(filepath.Dir(images), "tags.json"), []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readTags(s.data); err == nil {
		t.Fatal("dedupe startup would accept corrupted tags")
	}
}

func TestTagLockHelper(t *testing.T) {
	role := os.Getenv("SALADBOORU_LOCK_TEST_ROLE")
	if role == "" {
		return
	}
	data := os.Getenv("SALADBOORU_LOCK_TEST_DIR")
	root, err := os.OpenRoot(data)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if role == "hold" {
		lock, err := lockTags(root)
		if err != nil {
			t.Fatal(err)
		}
		fmt.Fprintln(os.Stdout, "ready")
		io.Copy(io.Discard, os.Stdin)
		lock.Close()
		return
	}
	images, err := os.OpenRoot(filepath.Join(data, "images"))
	if err != nil {
		t.Fatal(err)
	}
	defer images.Close()
	fmt.Fprintln(os.Stdout, "ready")
	if removed, err := dedupeLocked(images, root); err != nil || removed != 0 {
		t.Fatalf("concurrent dedupe: removed=%d err=%v", removed, err)
	}
}

func TestTagLockSerializesPUTAndDedupe(t *testing.T) {
	s, images, h := setup(t)
	data := filepath.Dir(images)
	raw := pngImage(t)
	for _, name := range []string{"first.png", "second.png", "third.png"} {
		if err := os.WriteFile(filepath.Join(images, name), raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	start := func(role string) (*exec.Cmd, io.WriteCloser) {
		t.Helper()
		cmd := exec.Command(os.Args[0], "-test.run=^TestTagLockHelper$")
		cmd.Env = append(os.Environ(), "SALADBOORU_LOCK_TEST_ROLE="+role, "SALADBOORU_LOCK_TEST_DIR="+data)
		stdin, err := cmd.StdinPipe()
		if err != nil {
			t.Fatal(err)
		}
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			t.Fatal(err)
		}
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			stdin.Close()
			if cmd.ProcessState == nil {
				cmd.Process.Kill()
				cmd.Wait()
			}
		})
		if line, err := bufio.NewReader(stdout).ReadString('\n'); err != nil || line != "ready\n" {
			t.Fatalf("lock helper did not start: %q %v", line, err)
		}
		return cmd, stdin
	}
	holder, release := start("hold")
	putDone := make(chan int, 1)
	go func() { putDone <- putTags(t, h, "second.png", `{"tags":["saved"]}`, true).Code }()
	select {
	case code := <-putDone:
		t.Fatalf("PUT bypassed process lock: %d", code)
	case <-time.After(100 * time.Millisecond):
	}
	release.Close()
	if err := holder.Wait(); err != nil {
		t.Fatal(err)
	}
	select {
	case code := <-putDone:
		if code != 200 {
			t.Fatalf("PUT after release: %d", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("PUT did not resume")
	}
	lock, err := lockTags(s.data)
	if err != nil {
		t.Fatal(err)
	}
	worker, _ := start("dedupe")
	finished := make(chan error, 1)
	go func() { finished <- worker.Wait() }()
	select {
	case err := <-finished:
		t.Fatalf("dedupe bypassed process lock: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	s.tagsMu.Lock()
	next := make(map[string][]string, len(s.tags)+1)
	for name, value := range s.tags {
		next[name] = value
	}
	next["third.png"] = []string{"saved during dedupe"}
	err = s.saveTags(next)
	s.tagsMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	lock.Close()
	select {
	case err := <-finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("dedupe did not resume")
	}
	for _, name := range []string{"first.png", "second.png", "third.png"} {
		if _, err := os.Stat(filepath.Join(images, name)); err != nil {
			t.Fatalf("dedupe removed %s: %v", name, err)
		}
	}
	if err := os.Remove(filepath.Join(data, ".tags.lock")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("tags.json", filepath.Join(data, ".tags.lock")); err != nil {
		t.Fatal(err)
	}
	if unsafe, err := lockTags(s.data); err == nil {
		unsafe.Close()
		t.Fatal("symlink lock accepted")
	}
}
