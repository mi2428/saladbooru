package main

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gen2brain/avif"
	"github.com/gen2brain/webp"
)

const testToken = "this-is-a-long-test-only-token-not-a-secret"

func pngImage(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	img := image.NewRGBA(image.Rect(0, 0, 2, 3))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func setup(t *testing.T) (*server, string, http.Handler) {
	t.Helper()
	data := t.TempDir()
	s, err := newServer(data, testToken)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.images.Close() })
	return s, filepath.Join(data, "images"), s.routes()
}

func form(t *testing.T, filename string, raw []byte, extras bool) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	f, err := w.CreateFormFile("file", filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write(raw); err != nil {
		t.Fatal(err)
	}
	if extras {
		if err := w.WriteField("source_url", "https://example.com"); err != nil {
			t.Fatal(err)
		}
	}
	w.Close()
	return &body, w.FormDataContentType()
}

func post(t *testing.T, h http.Handler, filename string, raw []byte, extras bool, auth bool) *httptest.ResponseRecorder {
	t.Helper()
	body, contentType := form(t, filename, raw, extras)
	r := httptest.NewRequest("POST", "/api/posts", body)
	r.Header.Set("Content-Type", contentType)
	if auth {
		r.Header.Set("Authorization", "Bearer "+testToken)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func get(t *testing.T, h http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
	return w
}

func TestUploadAndDirectDrop(t *testing.T) {
	_, images, h := setup(t)
	raw := pngImage(t)
	if status := post(t, h, "valid.png", raw, false, false).Code; status != 401 {
		t.Fatalf("unauthenticated upload: %d", status)
	}
	w := post(t, h, "valid.png", raw, false, true)
	if w.Code != 201 {
		t.Fatalf("upload: %d %s", w.Code, w.Body.String())
	}
	var uploaded struct {
		Item item `json:"item"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &uploaded); err != nil {
		t.Fatal(err)
	}
	if uploaded.Item.Name == "valid.png" || uploaded.Item.Width != 2 || uploaded.Item.Height != 3 || uploaded.Item.URL == "" {
		t.Fatalf("unexpected upload metadata: %+v", uploaded.Item)
	}
	if w := get(t, h, uploaded.Item.URL); w.Code != 200 || w.Header().Get("Content-Type") != "image/png" || !bytes.Equal(w.Body.Bytes(), raw) {
		t.Fatalf("uploaded image not served: %d", w.Code)
	}
	if w := get(t, h, "/health"); w.Code != 200 {
		t.Fatalf("storage health: %d", w.Code)
	}
	manual := filepath.Join(images, "my photo.png")
	if err := os.WriteFile(manual, raw, 0600); err != nil {
		t.Fatal(err)
	}
	newer := time.Now().Add(time.Hour)
	if err := os.Chtimes(manual, newer, newer); err != nil {
		t.Fatal(err)
	}
	var listing struct {
		Items []item `json:"items"`
	}
	result := get(t, h, "/api/posts")
	if result.Code != 200 || json.Unmarshal(result.Body.Bytes(), &listing) != nil {
		t.Fatalf("listing: %d %s", result.Code, result.Body.String())
	}
	if len(listing.Items) != 2 || listing.Items[0].Name != "my photo.png" || listing.Items[1].Name != uploaded.Item.Name || listing.Items[0].URL != "/images/my%20photo.png" {
		t.Fatalf("direct drop/order: %+v", listing.Items)
	}
	if w := get(t, h, "/posts/my%20photo.png"); w.Code != 200 || !strings.Contains(w.Body.String(), "id=\"back\"") {
		t.Fatalf("detail/back: %d", w.Code)
	}
}

func TestExtensionlessShortcutUpload(t *testing.T) {
	for _, tc := range []struct {
		fixture, ext, mime string
		width, height      int
	}{
		{"source.jpg", ".jpg", "image/jpeg", 4, 2},
		{"source.avif", ".avif", "image/avif", 4, 2},
	} {
		t.Run(tc.fixture, func(t *testing.T) {
			_, images, h := setup(t)
			raw, err := os.ReadFile(filepath.Join("testdata", tc.fixture))
			if err != nil {
				t.Fatal(err)
			}
			for _, bad := range []struct {
				name string
				want int
			}{
				{"../Image", 400}, {"", 400},
			} {
				if response := post(t, h, bad.name, raw, false, true); response.Code != bad.want {
					t.Fatalf("unsafe filename %q: %d, want %d", bad.name, response.Code, bad.want)
				}
			}
			response := post(t, h, "Image", raw, false, true)
			if response.Code != 201 {
				t.Fatalf("extensionless upload: %d %s", response.Code, response.Body.String())
			}
			var reply struct {
				Item item `json:"item"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &reply); err != nil {
				t.Fatal(err)
			}
			if !strings.HasSuffix(reply.Item.Name, tc.ext) || reply.Item.Width != tc.width || reply.Item.Height != tc.height {
				t.Fatalf("saved name/dimensions: %+v", reply.Item)
			}
			original := get(t, h, reply.Item.URL)
			if original.Code != 200 || original.Header().Get("Content-Type") != tc.mime || !bytes.Equal(original.Body.Bytes(), raw) {
				t.Fatalf("original bytes/MIME: %d %s", original.Code, original.Header().Get("Content-Type"))
			}
			entries, err := os.ReadDir(images)
			if err != nil || len(entries) != 1 || entries[0].Name() != reply.Item.Name {
				t.Fatalf("unexpected persisted files: %v %v", entries, err)
			}
		})
	}
}

func TestFormats(t *testing.T) {
	for _, tc := range []struct {
		file   string
		width  int
		height int
		mime   string
	}{
		{"source.jpg", 4, 2, "image/jpeg"},
		{"source.png", 4, 2, "image/png"},
		{"source.gif", 4, 2, "image/gif"},
		{"source.webp", 4, 2, "image/webp"},
		{"source.avif", 4, 2, "image/avif"},
		{"two.gif", 4, 2, "image/gif"},
		{"two.webp", 4, 2, "image/webp"},
		{"two.avif", 4, 2, "image/avif"},
	} {
		t.Run(tc.file, func(t *testing.T) {
			_, images, h := setup(t)
			raw, err := os.ReadFile(filepath.Join("testdata", tc.file))
			if err != nil {
				t.Fatal(err)
			}
			uploaded := post(t, h, tc.file, raw, false, true)
			if uploaded.Code != 201 {
				t.Fatalf("upload: %d %s", uploaded.Code, uploaded.Body.String())
			}
			var reply struct {
				Item item `json:"item"`
			}
			if err := json.Unmarshal(uploaded.Body.Bytes(), &reply); err != nil {
				t.Fatal(err)
			}
			if reply.Item.Width != tc.width || reply.Item.Height != tc.height {
				t.Fatalf("uploaded dimensions: %dx%d, want %dx%d", reply.Item.Width, reply.Item.Height, tc.width, tc.height)
			}
			if result := get(t, h, reply.Item.URL); result.Code != 200 || result.Header().Get("Content-Type") != tc.mime || !bytes.Equal(result.Body.Bytes(), raw) {
				t.Fatalf("uploaded original: %d, %s", result.Code, result.Header().Get("Content-Type"))
			}
			if err := os.WriteFile(filepath.Join(images, tc.file), raw, 0600); err != nil {
				t.Fatal(err)
			}
			var listing struct {
				Items []item `json:"items"`
			}
			if err := json.Unmarshal(get(t, h, "/api/posts").Body.Bytes(), &listing); err != nil {
				t.Fatal(err)
			}
			if len(listing.Items) != 2 {
				t.Fatalf("direct drop omitted: %+v", listing.Items)
			}
			if result := get(t, h, "/images/"+tc.file); result.Code != 200 || result.Header().Get("Content-Type") != tc.mime || !bytes.Equal(result.Body.Bytes(), raw) {
				t.Fatalf("direct original: %d, %s", result.Code, result.Header().Get("Content-Type"))
			}
			if result := get(t, h, "/posts/"+tc.file); result.Code != 200 {
				t.Fatalf("detail: %d", result.Code)
			}
		})
	}
}

func TestRejectBrokenFormats(t *testing.T) {
	_, images, h := setup(t)
	for _, file := range []string{"source.jpg", "source.png", "source.gif", "source.webp", "source.avif"} {
		t.Run(file, func(t *testing.T) {
			raw, err := os.ReadFile(filepath.Join("testdata", file))
			if err != nil {
				t.Fatal(err)
			}
			for name, content := range map[string][]byte{
				"broken-" + file: raw[:len(raw)/2],
				"fake-" + file:   []byte("GIF89a"),
			} {
				if err := os.WriteFile(filepath.Join(images, name), content, 0600); err != nil {
					t.Fatal(err)
				}
				if result := get(t, h, "/images/"+name); result.Code != 404 {
					t.Fatalf("invalid direct file %s served: %d", name, result.Code)
				}
				if result := post(t, h, name, content, false, true); result.Code != 422 {
					t.Fatalf("invalid upload %s accepted: %d", name, result.Code)
				}
			}
		})
	}
}

func TestPreviewPreservesOriginals(t *testing.T) {
	for _, tc := range []struct {
		name          string
		mime          string
		width, height int
	}{
		{"source.avif", "image/avif", 4, 2},
		{"two.avif", "image/avif", 4, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, images, h := setup(t)
			raw, err := os.ReadFile(filepath.Join("testdata", tc.name))
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(images, tc.name), raw, 0600); err != nil {
				t.Fatal(err)
			}
			upload := post(t, h, tc.name, raw, false, true)
			if upload.Code != 201 {
				t.Fatalf("upload: %d", upload.Code)
			}
			var response struct {
				Item item `json:"item"`
			}
			if err := json.Unmarshal(upload.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			for _, original := range []string{"/images/" + tc.name, response.Item.URL} {
				native := get(t, h, original)
				if native.Code != 200 || native.Header().Get("Content-Type") != tc.mime || !bytes.Equal(native.Body.Bytes(), raw) {
					t.Fatalf("original changed: %s, %d %s", original, native.Code, native.Header().Get("Content-Type"))
				}
				preview := get(t, h, strings.Replace(original, "/images/", "/preview/", 1))
				if preview.Code != 200 || preview.Header().Get("Content-Type") != "image/jpeg" || preview.Header().Get("X-Content-Type-Options") != "nosniff" || preview.Header().Get("Content-Security-Policy") != "sandbox" {
					t.Fatalf("preview headers: %s, %d %s", original, preview.Code, preview.Header().Get("Content-Type"))
				}
				decoded, err := jpeg.Decode(bytes.NewReader(preview.Body.Bytes()))
				if err != nil || decoded.Bounds().Dx() != tc.width || decoded.Bounds().Dy() != tc.height {
					t.Fatalf("preview decode: %s, %v", original, err)
				}
			}
			entries, err := os.ReadDir(images)
			if err != nil || len(entries) != 2 {
				t.Fatalf("preview persisted derivative: %d %v", len(entries), err)
			}
		})
	}
	_, images, h := setup(t)
	for _, file := range []string{"source.jpg", "source.png", "two.gif", "two.webp"} {
		raw, err := os.ReadFile(filepath.Join("testdata", file))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(images, file), raw, 0600); err != nil {
			t.Fatal(err)
		}
		if response := get(t, h, "/preview/"+file); response.Code != 404 {
			t.Fatalf("unnecessary re-encoding: %s, %d", file, response.Code)
		}
	}
}

func TestAnimatedFixturesHaveTwoFrames(t *testing.T) {
	for _, tc := range []struct {
		name   string
		decode func(*bytes.Reader) (int, error)
	}{
		{"two.gif", func(r *bytes.Reader) (int, error) {
			g, err := gif.DecodeAll(r)
			if err != nil {
				return 0, err
			}
			return len(g.Image), nil
		}},
		{"two.webp", func(r *bytes.Reader) (int, error) {
			w, err := webp.DecodeAll(r)
			if err != nil {
				return 0, err
			}
			return len(w.Image), nil
		}},
		{"two.avif", func(r *bytes.Reader) (int, error) {
			a, err := avif.DecodeAll(r)
			if err != nil {
				return 0, err
			}
			return len(a.Image), nil
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := os.ReadFile(filepath.Join("testdata", tc.name))
			if err != nil {
				t.Fatal(err)
			}
			frames, err := tc.decode(bytes.NewReader(raw))
			if err != nil || frames != 2 {
				t.Fatalf("frames: %d: %v", frames, err)
			}
		})
	}
}

func TestRejectBadUploads(t *testing.T) {
	_, images, h := setup(t)
	raw := pngImage(t)
	for _, tc := range []struct {
		name  string
		file  string
		data  []byte
		extra bool
		want  int
	}{
		{"html", "x.html", []byte("<svg onload=alert(1)></svg>"), false, 422},
		{"truncated", "x.png", raw[:len(raw)/2], false, 422},
		{"extra field", "x.png", raw, true, 400},
		{"traversal filename", "../escape.png", raw, false, 400},
		{"large invalid file", "big.png", bytes.Repeat([]byte("x"), (12<<20)+1), false, 422},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if w := post(t, h, tc.file, tc.data, tc.extra, true); w.Code != tc.want {
				t.Fatalf("got %d, want %d", w.Code, tc.want)
			}
		})
	}
	entries, err := os.ReadDir(images)
	if err != nil || len(entries) != 0 {
		t.Fatalf("failed uploads left files: %v, %v", entries, err)
	}
	r := httptest.NewRequest("POST", "/api/posts", strings.NewReader(`{"url":"https://example.com"}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+testToken)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 415 {
		t.Fatalf("URL import accepted: %d", w.Code)
	}
}

func TestOnlySafeDirectFiles(t *testing.T) {
	s, images, h := setup(t)
	raw := pngImage(t)
	outside := filepath.Join(t.TempDir(), "outside.png")
	if err := os.WriteFile(outside, raw, 0600); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string][]byte{
		"good.png": raw, "fake.png": []byte("<html>bad</html>"), ".upload-hidden.png": raw,
	} {
		if err := os.WriteFile(filepath.Join(images, name), content, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(outside, filepath.Join(images, "escape.png")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("good.png", filepath.Join(images, "alias.png")); err != nil {
		t.Fatal(err)
	}
	var listing struct {
		Items []item `json:"items"`
	}
	if err := json.Unmarshal(get(t, h, "/api/posts").Body.Bytes(), &listing); err != nil {
		t.Fatal(err)
	}
	if len(listing.Items) != 1 || listing.Items[0].Name != "good.png" {
		t.Fatalf("unsafe files listed: %+v", listing.Items)
	}
	for _, path := range []string{"/images/escape.png", "/images/alias.png", "/images/fake.png", "/images/..%2Foutside.png"} {
		if result := get(t, h, path); result.Code == 200 {
			t.Fatalf("unsafe path served: %s", path)
		}
	}
	if _, _, _, _, err := s.openImage("../outside.png"); err == nil {
		t.Fatal("traversal opened")
	}
	if err := s.images.Close(); err != nil {
		t.Fatal(err)
	}
	if w := get(t, h, "/health"); w.Code != 503 {
		t.Fatalf("closed storage was healthy: %d", w.Code)
	}
}

func TestStartupRejectsMissingTokenAndSymlinkDirectory(t *testing.T) {
	if _, err := newServer(t.TempDir(), "short"); err == nil {
		t.Fatal("short token accepted")
	}
	data := t.TempDir()
	if err := os.Symlink(t.TempDir(), filepath.Join(data, "images")); err != nil {
		t.Fatal(err)
	}
	if _, err := newServer(data, testToken); err == nil {
		t.Fatal("symlink image directory accepted")
	}
}
