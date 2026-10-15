package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func putTags(t *testing.T, h http.Handler, name, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest("PUT", "/api/posts/"+name+"/tags", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func patchBatchTags(t *testing.T, h http.Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest("PATCH", "/api/batch/tags", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func removePost(t *testing.T, h http.Handler, name string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("DELETE", "/api/posts/"+name, nil))
	return w
}

func taggedPost(t *testing.T, h http.Handler, tags string, extra ...string) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	file, err := form.CreateFormFile("file", "pasted.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(pngImage(t)); err != nil {
		t.Fatal(err)
	}
	if err := form.WriteField("tags", tags); err != nil {
		t.Fatal(err)
	}
	if len(extra) > 0 {
		if err := form.WriteField("extra", extra[0]); err != nil {
			t.Fatal(err)
		}
	}
	if err := form.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("POST", "/api/posts", &body)
	request.Header.Set("Content-Type", form.FormDataContentType())
	w := httptest.NewRecorder()
	h.ServeHTTP(w, request)
	return w
}

func TestTaggedUploadIsSavedWithImage(t *testing.T) {
	s, images, h := setup(t)
	response := taggedPost(t, h, `["Blue","赤"]`)
	if response.Code != 201 {
		t.Fatalf("tagged upload: %d %s", response.Code, response.Body.String())
	}
	var result struct {
		Item item `json:"item"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(result.Item.Tags, []string{"Blue", "赤"}) {
		t.Fatalf("upload response lost tags: %+v", result.Item)
	}
	stored, err := readTags(s.data)
	if err != nil || !slices.Equal(stored[result.Item.Name], []string{"Blue", "赤"}) {
		t.Fatalf("uploaded tags: %v %v", stored, err)
	}
	if image := get(t, h, result.Item.URL); image.Code != 200 || !bytes.Equal(image.Body.Bytes(), pngImage(t)) {
		t.Fatal("tagged upload altered image")
	}
	for _, tags := range []string{`null`, `["blue","Blue"]`, `{"tags":[]}`} {
		if failed := taggedPost(t, h, tags); failed.Code != 400 {
			t.Fatalf("invalid tags accepted (%s): %d", tags, failed.Code)
		}
	}
	if failed := taggedPost(t, h, `["Blue"]`, "unexpected"); failed.Code != 400 {
		t.Fatalf("extra multipart field accepted: %d", failed.Code)
	}
	if entries, err := os.ReadDir(images); err != nil || len(entries) != 1 {
		t.Fatalf("invalid upload left files: %v %v", entries, err)
	}
}

func TestTaggedUploadFailsWithoutTagStorage(t *testing.T) {
	s, images, h := setup(t)
	if err := s.data.Close(); err != nil {
		t.Fatal(err)
	}
	if response := taggedPost(t, h, `["Blue"]`); response.Code != 503 {
		t.Fatalf("upload without tag storage: %d", response.Code)
	}
	if entries, err := os.ReadDir(images); err != nil || len(entries) != 0 {
		t.Fatalf("failed upload left files: %v %v", entries, err)
	}
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
	if w := putTags(t, h, "one.png", body); w.Code != 200 {
		t.Fatalf("anonymous write: %d %s", w.Code, w.Body.String())
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
	restarted, err := newServer(data, defaultThumbnailCacheLimit)
	if err != nil {
		t.Fatal("restart: ", err)
	}
	defer restarted.images.Close()
	defer restarted.data.Close()
	if w := get(t, restarted.routes(), url); w.Code != 200 || !strings.Contains(w.Body.String(), "作品 ひとつ") {
		t.Fatalf("lost tags after restart: %d %s", w.Code, w.Body.String())
	}
	if w := putTags(t, h, "one.png", `{"tags":[]}`); w.Code != 200 {
		t.Fatalf("remove tags: %d", w.Code)
	}
	if w := get(t, h, "/api/posts"); w.Code != 200 || strings.Contains(w.Body.String(), "作品 ひとつ") {
		t.Fatalf("tag removal not reflected: %d", w.Code)
	}
}

func TestBatchTagsAddAndRemove(t *testing.T) {
	s, images, h := setup(t)
	raw := pngImage(t)
	for _, name := range []string{"one.png", "two.png", "untouched.png"} {
		if err := os.WriteFile(filepath.Join(images, name), raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if w := putTags(t, h, "one.png", `{"tags":["Blue","Keep"]}`); w.Code != 200 {
		t.Fatalf("first tags: %d", w.Code)
	}
	if w := putTags(t, h, "two.png", `{"tags":["Red"]}`); w.Code != 200 {
		t.Fatalf("second tags: %d", w.Code)
	}
	if w := patchBatchTags(t, h, `{"names":["one.png","two.png"],"add":["BLUE","New"]}`); w.Code != 204 {
		t.Fatalf("batch add: %d %s", w.Code, w.Body.String())
	}
	stored, err := readTags(s.data)
	if err != nil || !slices.Equal(stored["one.png"], []string{"Blue", "Keep", "New"}) || !slices.Equal(stored["two.png"], []string{"Red", "BLUE", "New"}) {
		t.Fatalf("batch add changed existing tags: %v %v", stored, err)
	}
	if w := patchBatchTags(t, h, `{"names":["one.png","two.png"],"remove":["blue","RED"]}`); w.Code != 204 {
		t.Fatalf("batch remove: %d %s", w.Code, w.Body.String())
	}
	stored, err = readTags(s.data)
	if err != nil || !slices.Equal(stored["one.png"], []string{"Keep", "New"}) || !slices.Equal(stored["two.png"], []string{"New"}) || len(stored["untouched.png"]) != 0 {
		t.Fatalf("batch remove: %v %v", stored, err)
	}
	for _, name := range []string{"one.png", "two.png", "untouched.png"} {
		if file, err := os.ReadFile(filepath.Join(images, name)); err != nil || !bytes.Equal(file, raw) {
			t.Fatalf("batch tags changed image %s: %v", name, err)
		}
	}
	restarted, err := newServer(filepath.Dir(images), defaultThumbnailCacheLimit)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.images.Close()
	defer restarted.data.Close()
	if w := get(t, restarted.routes(), "/api/posts/two.png/tags"); w.Code != 200 || !strings.Contains(w.Body.String(), `"New"`) {
		t.Fatalf("batch tags not persisted: %d %s", w.Code, w.Body.String())
	}
}

func TestBatchTagsRejectsUnsafeOrPartialChanges(t *testing.T) {
	s, images, h := setup(t)
	for _, name := range []string{"one.png", "two.png"} {
		if err := os.WriteFile(filepath.Join(images, name), pngImage(t), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if w := putTags(t, h, "one.png", `{"tags":["Keep"]}`); w.Code != 200 {
		t.Fatalf("initial tags: %d", w.Code)
	}
	for _, body := range []string{
		`{}`, `{"names":[],"add":["New"]}`, `{"names":["one.png","one.png"],"add":["New"]}`,
		`{"names":["../one.png"],"remove":["Keep"]}`, `{"names":["one.png"],"add":["New"],"remove":["Keep"]}`,
		`{"names":["one.png"],"add":[]}`, `{"names":["one.png"],"add":["New","new"]}`,
		`{"names":["one.png"],"add":["New"],"extra":true}`, `{"names":["one.png"],"names":["two.png"],"add":["New"]}`,
		`{"names":["one.png"],"add":["New"]} true`,
	} {
		if w := patchBatchTags(t, h, body); w.Code != 400 {
			t.Fatalf("invalid batch accepted (%d): %s", w.Code, body)
		}
	}
	if w := patchBatchTags(t, h, `{"names":["one.png","missing.png"],"add":["New"]}`); w.Code != 404 {
		t.Fatalf("partial batch changed state: %d", w.Code)
	}
	stored, err := readTags(s.data)
	if err != nil || !slices.Equal(stored["one.png"], []string{"Keep"}) || len(stored["two.png"]) != 0 {
		t.Fatalf("invalid batch changed tags: %v %v", stored, err)
	}
	if err := os.Symlink("one.png", filepath.Join(images, "alias.png")); err != nil {
		t.Fatal(err)
	}
	if w := patchBatchTags(t, h, `{"names":["one.png","alias.png"],"remove":["Keep"]}`); w.Code != 404 {
		t.Fatalf("symlink accepted in batch: %d", w.Code)
	}
	stored, err = readTags(s.data)
	if err != nil || !slices.Equal(stored["one.png"], []string{"Keep"}) {
		t.Fatalf("unsafe batch changed tags: %v %v", stored, err)
	}
}

func TestManyTagsPerImage(t *testing.T) {
	_, images, h := setup(t)
	if err := os.WriteFile(filepath.Join(images, "one.png"), pngImage(t), 0600); err != nil {
		t.Fatal(err)
	}
	tags := make([]string, 300)
	for i := range tags {
		tags[i] = fmt.Sprintf("Tag %03d extra", i)
	}
	request := func(values []string) string {
		raw, err := json.Marshal(map[string][]string{"tags": values})
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}
	if len(request(tags)) <= 4096 {
		t.Fatal("test payload must exceed the old request size limit")
	}
	if w := putTags(t, h, "one.png", request(tags)); w.Code != 200 {
		t.Fatalf("many tags rejected: %d %s", w.Code, w.Body.String())
	}
	if w := get(t, h, "/api/posts"); w.Code != 200 || !strings.Contains(w.Body.String(), `"Tag 299 extra"`) {
		t.Fatalf("tags missing from list: %d %s", w.Code, w.Body.String())
	}
	restarted, err := newServer(filepath.Dir(images), defaultThumbnailCacheLimit)
	if err != nil {
		t.Fatal("restart with many tags: ", err)
	}
	defer restarted.images.Close()
	defer restarted.data.Close()
	if w := get(t, restarted.routes(), "/api/posts/one.png/tags"); w.Code != 200 || !strings.Contains(w.Body.String(), `"Tag 299 extra"`) {
		t.Fatalf("tags lost after restart: %d %s", w.Code, w.Body.String())
	}
}

func TestDeletePostRemovesImageAndTags(t *testing.T) {
	s, images, h := setup(t)
	data := filepath.Dir(images)
	for _, name := range []string{"one.png", "other.png"} {
		if err := os.WriteFile(filepath.Join(images, name), pngImage(t), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if w := putTags(t, h, "one.png", `{"tags":["Tag1"]}`); w.Code != 200 {
		t.Fatalf("tag: %d", w.Code)
	}
	get(t, h, "/api/posts") // Prime the listing cache.
	if w := removePost(t, h, "missing.png"); w.Code != 404 {
		t.Fatalf("missing image: %d", w.Code)
	}
	if err := os.Symlink("other.png", filepath.Join(images, "link.png")); err != nil {
		t.Fatal(err)
	}
	if w := removePost(t, h, "link.png"); w.Code != 404 {
		t.Fatalf("symlink: %d", w.Code)
	}
	if w := removePost(t, h, "..%2Fother.png"); w.Code == 204 {
		t.Fatal("unsafe path accepted")
	}
	if w := removePost(t, h, "one.png"); w.Code != 204 {
		t.Fatalf("delete tagged image: %d %s", w.Code, w.Body.String())
	}
	if w := get(t, h, "/images/one.png"); w.Code != 404 {
		t.Fatalf("deleted image still served: %d", w.Code)
	}
	if w := get(t, h, "/api/posts/one.png/tags"); w.Code != 404 {
		t.Fatalf("deleted tags still served: %d", w.Code)
	}
	if w := get(t, h, "/api/posts"); w.Code != 200 || strings.Contains(w.Body.String(), `"one.png"`) || !strings.Contains(w.Body.String(), `"other.png"`) {
		t.Fatalf("stale listing: %d %s", w.Code, w.Body.String())
	}
	if w := removePost(t, h, "one.png"); w.Code != 404 {
		t.Fatalf("repeat delete: %d", w.Code)
	}
	if w := removePost(t, h, "other.png"); w.Code != 204 {
		t.Fatalf("delete untagged image: %d", w.Code)
	}
	restarted, err := newServer(data, defaultThumbnailCacheLimit)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.images.Close()
	defer restarted.data.Close()
	if w := get(t, restarted.routes(), "/api/posts"); w.Code != 200 || !strings.Contains(w.Body.String(), `"items":[]`) {
		t.Fatalf("restart listing: %d %s", w.Code, w.Body.String())
	}
	tags, err := readTags(s.data)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := tags["one.png"]; ok {
		t.Fatal("deleted tag metadata remains")
	}
}

func TestDeletePostRestoresImageWhenTagsCannotBeSaved(t *testing.T) {
	_, images, h := setup(t)
	name := filepath.Join(images, "one.png")
	raw := pngImage(t)
	if err := os.WriteFile(name, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if w := putTags(t, h, "one.png", `{"tags":["Tag1"]}`); w.Code != 200 {
		t.Fatalf("tag: %d", w.Code)
	}
	stored := filepath.Join(filepath.Dir(images), "tags.json")
	if err := os.Chmod(stored, 0644); err != nil {
		t.Fatal(err)
	}
	if w := removePost(t, h, "one.png"); w.Code != 503 {
		t.Fatalf("failed tag save must reject deletion: %d", w.Code)
	}
	if image, err := os.ReadFile(name); err != nil || !bytes.Equal(image, raw) {
		t.Fatalf("failed deletion lost the image: %v", err)
	}
	if entries, err := os.ReadDir(images); err != nil || len(entries) != 1 || entries[0].Name() != "one.png" {
		t.Fatalf("failed deletion left hidden files: %v, %v", entries, err)
	}
	if err := os.Chmod(stored, 0600); err != nil {
		t.Fatal(err)
	}
	restarted, err := newServer(filepath.Dir(images), defaultThumbnailCacheLimit)
	if err != nil {
		t.Fatal("restart after failed deletion: ", err)
	}
	defer restarted.images.Close()
	defer restarted.data.Close()
	if w := get(t, restarted.routes(), "/api/posts/one.png/tags"); w.Code != 200 || !strings.Contains(w.Body.String(), "Tag1") {
		t.Fatalf("failed deletion lost tags after restart: %d %s", w.Code, w.Body.String())
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
		if w := putTags(t, h, name, `{"tags":[]}`); w.Code == 200 {
			t.Fatalf("unsafe filename %s accepted", name)
		}
	}
	for _, body := range []string{
		`null`, `{}`, `{"tags":null}`, `{"tags":{}}`, `{"tags":[]}`, `{"tags":[],"extra":1}`, `{"tags":[],"tags":[]}`,
		`{"tags":[""]}`, `{"tags":[" x"]}`, `{"tags":[1]}`, `{"tags":[{"name":"x"}]}`,
		`{"tags":["X","x"]}`, `{"tags":["` + strings.Repeat("x", 81) + `"]}`,
	} {
		if w := putTags(t, h, "one.png", body); w.Code != 400 {
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
	if w := putTags(t, h, "one.png", `{"tags":["before"]}`); w.Code != 200 {
		t.Fatalf("initial write: %d", w.Code)
	}
	if err := s.data.Close(); err != nil {
		t.Fatal(err)
	}
	if w := putTags(t, h, "one.png", `{"tags":["after"]}`); w.Code != 503 {
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
		if restarted, err := newServer(data, defaultThumbnailCacheLimit); err == nil {
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
	if restarted, err := newServer(data, defaultThumbnailCacheLimit); err == nil {
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
	if restarted, err := newServer(data, defaultThumbnailCacheLimit); err == nil {
		restarted.images.Close()
		restarted.data.Close()
		t.Fatal("public tag file accepted")
	}
}

func TestDedupeMergesTaggedContent(t *testing.T) {
	s, images, h := setup(t)
	raw := pngImage(t)
	for _, name := range []string{"a.png", "b.png", "c.png", "d.png"} {
		if err := os.WriteFile(filepath.Join(images, name), raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	for name, values := range map[string][]string{
		"a.png": {"shared", "a"},
		"b.png": {"SHARED", "b"},
		"d.png": {"d", "Tag 00", "Tag 01", "Tag 02", "Tag 03", "Tag 04", "Tag 05", "Tag 06", "Tag 07", "Tag 08", "Tag 09"},
	} {
		body, err := json.Marshal(map[string][]string{"tags": values})
		if err != nil {
			t.Fatal(err)
		}
		if w := putTags(t, h, name, string(body)); w.Code != 200 {
			t.Fatalf("tag %s: %d %s", name, w.Code, w.Body.String())
		}
	}
	if removed, err := dedupe(s.images, s.data); err != nil || removed != 3 {
		t.Fatalf("dedupe: %d %v", removed, err)
	}
	entries, err := os.ReadDir(images)
	if err != nil || len(entries) != 1 {
		t.Fatalf("expected one surviving image: %v %v", entries, err)
	}
	kept := entries[0].Name()
	tags, err := readTags(s.data)
	if err != nil || len(tags) != 1 || len(tags[kept]) != 14 {
		t.Fatalf("merged tags: %+v %v", tags, err)
	}
	want := map[string]bool{"shared": true, "a": true, "b": true, "d": true}
	for i := 0; i < 10; i++ {
		want[fmt.Sprintf("tag %02d", i)] = true
	}
	for _, tag := range tags[kept] {
		key := strings.ToLower(tag)
		if !want[key] {
			t.Fatalf("unexpected or duplicate tag: %s", tag)
		}
		delete(want, key)
	}
	if len(want) != 0 {
		t.Fatalf("lost tags: %v", want)
	}
	if w := get(t, h, "/api/posts/"+kept+"/tags"); w.Code != 200 || !strings.Contains(w.Body.String(), `"Tag 09"`) {
		t.Fatalf("running server missed migrated tags: %d %s", w.Code, w.Body.String())
	}
	if w := get(t, h, "/api/posts"); w.Code != 200 || !strings.Contains(w.Body.String(), `"Tag 09"`) {
		t.Fatalf("running list missed migrated tags: %d %s", w.Code, w.Body.String())
	}
	updated := append(tags[kept], "after")
	body, err := json.Marshal(map[string][]string{"tags": updated})
	if err != nil {
		t.Fatal(err)
	}
	if w := putTags(t, h, kept, string(body)); w.Code != 200 {
		t.Fatalf("update after dedupe: %d %s", w.Code, w.Body.String())
	}
	if again, err := readTags(s.data); err != nil || len(again) != 1 || len(again[kept]) != 15 {
		t.Fatalf("later update lost merged tags: %+v %v", again, err)
	}
	if removed, err := dedupe(s.images, s.data); err != nil || removed != 0 {
		t.Fatalf("dedupe must be idempotent: %d %v", removed, err)
	}
	restarted, err := newServer(filepath.Dir(images), defaultThumbnailCacheLimit)
	if err != nil {
		t.Fatal("restart after dedupe: ", err)
	}
	defer restarted.images.Close()
	defer restarted.data.Close()
	if w := get(t, restarted.routes(), "/api/posts/"+kept+"/tags"); w.Code != 200 || !strings.Contains(w.Body.String(), `"after"`) {
		t.Fatalf("restart lost merged tags: %d %s", w.Code, w.Body.String())
	}
}

func TestDedupeDoesNotDeleteWhenTagStoreFails(t *testing.T) {
	s, images, h := setup(t)
	for _, name := range []string{"one.png", "two.png"} {
		if err := os.WriteFile(filepath.Join(images, name), pngImage(t), 0600); err != nil {
			t.Fatal(err)
		}
		if w := putTags(t, h, name, `{"tags":["`+name+`"]}`); w.Code != 200 {
			t.Fatalf("tag %s: %d", name, w.Code)
		}
	}
	path := filepath.Join(filepath.Dir(images), "tags.json")
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(path, 0600)
	if removed, err := dedupe(s.images, s.data); err == nil || removed != 0 {
		t.Fatalf("unreadable metadata must block deletion: %d %v", removed, err)
	}
	entries, err := os.ReadDir(images)
	if err != nil || len(entries) != 2 {
		t.Fatalf("tag storage failure deleted images: %v %v", entries, err)
	}
}

func TestDedupeDoesNotDeleteWhenTagSaveFails(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses directory permissions")
	}
	s, images, h := setup(t)
	for _, name := range []string{"one.png", "two.png"} {
		if err := os.WriteFile(filepath.Join(images, name), pngImage(t), 0600); err != nil {
			t.Fatal(err)
		}
		if w := putTags(t, h, name, `{"tags":["`+name+`"]}`); w.Code != 200 {
			t.Fatalf("tag %s: %d", name, w.Code)
		}
	}
	data := filepath.Dir(images)
	if err := os.Chmod(data, 0500); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(data, 0700)
	if removed, err := dedupe(s.images, s.data); err == nil || removed != 0 {
		t.Fatalf("failed tag save must block deletion: %d %v", removed, err)
	}
	entries, err := os.ReadDir(images)
	if err != nil || len(entries) != 2 {
		t.Fatalf("failed save deleted images: %v %v", entries, err)
	}
	tags, err := readTags(s.data)
	if err != nil || len(tags) != 2 {
		t.Fatalf("failed save changed stored tags: %+v %v", tags, err)
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
	if removed, err := dedupe(images, root); err != nil || removed != 2 {
		t.Fatalf("concurrent dedupe: removed=%d err=%v", removed, err)
	}
}

func TestTagLockWithGroupWritableMode(t *testing.T) {
	_, images, h := setup(t)
	if err := os.WriteFile(filepath.Join(images, "one.png"), pngImage(t), 0600); err != nil {
		t.Fatal(err)
	}
	if w := putTags(t, h, "one.png", `{"tags":["before"]}`); w.Code != 200 {
		t.Fatalf("initial tags: %d", w.Code)
	}
	if err := os.Chmod(filepath.Join(filepath.Dir(images), ".tags.lock"), 0660); err != nil {
		t.Fatal(err)
	}
	if w := putTags(t, h, "one.png", `{"tags":["after"]}`); w.Code != 200 {
		t.Fatalf("tag update after lock chmod: %d", w.Code)
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
	go func() { putDone <- putTags(t, h, "second.png", `{"tags":["saved"]}`).Code }()
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
	next, err := readTags(s.data)
	if err != nil {
		t.Fatal(err)
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
	entries, err := os.ReadDir(images)
	if err != nil || len(entries) != 1 {
		t.Fatalf("dedupe must leave one copy: %v %v", entries, err)
	}
	merged, err := readTags(s.data)
	if err != nil || len(merged) != 1 || len(merged[entries[0].Name()]) != 2 {
		t.Fatalf("dedupe missed tags written under lock: %+v %v", merged, err)
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
