package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"image"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gen2brain/avif"
	"github.com/gen2brain/webp"
)

//go:embed static
var assets embed.FS

const twitterImageOrigin = "https://pbs.twimg.com"

var galleryCSP = strings.Join([]string{
	"default-src 'self'",
	"connect-src 'self' " + twitterImageOrigin,
	"base-uri 'none'",
	"object-src 'none'",
	"frame-ancestors 'none'",
}, "; ")

type server struct {
	images     *os.Root
	data       *os.Root
	listMu     sync.Mutex
	listCache  map[string]cachedItem
	tagsMu     sync.RWMutex
	tags       map[string][]string
	tagsFailed bool
}

type item struct {
	Name     string    `json:"name"`
	URL      string    `json:"url"`
	Width    int       `json:"width"`
	Height   int       `json:"height"`
	Modified time.Time `json:"modified_at"`
	Tags     []string  `json:"tags"`
}

type cachedItem struct {
	item item
	stat os.FileInfo
}

func newServer(dataDir string) (*server, error) {
	root, err := openImages(dataDir)
	if err != nil {
		return nil, err
	}
	data, err := os.OpenRoot(dataDir)
	if err != nil {
		root.Close()
		return nil, err
	}
	tags, err := readTags(data)
	if err != nil {
		root.Close()
		data.Close()
		return nil, fmt.Errorf("invalid tags.json: %w", err)
	}
	return &server{images: root, data: data, tags: tags}, nil
}

func openImages(dataDir string) (*os.Root, error) {
	if err := webp.Dynamic(); err != nil {
		return nil, fmt.Errorf("libwebp and libwebpdemux are required for bounded animated WebP decoding: %w", err)
	}
	path := filepath.Join(dataDir, "images")
	if err := os.MkdirAll(path, 0755); err != nil {
		return nil, err
	}
	stat, err := os.Lstat(path)
	if err != nil || !stat.IsDir() {
		return nil, fmt.Errorf("image directory must be a real directory: %v", err)
	}
	return os.OpenRoot(path)
}

func validName(name string) bool {
	return name != "" && !strings.HasPrefix(name, ".") && !strings.ContainsAny(name, `/\`) && filepath.Base(name) == name
}

func imageHeader(f *os.File) (string, int, int, error) {
	config, format, err := image.DecodeConfig(f)
	if err != nil || config.Width < 1 || config.Height < 1 {
		return "", 0, 0, errors.New("unsupported image")
	}
	switch format {
	case "jpeg", "png", "gif", "webp", "avif":
	default:
		return "", 0, 0, errors.New("unsupported image")
	}
	return format, config.Width, config.Height, nil
}

// inspect decodes the first frame; later animation frames remain unvalidated.
func inspect(f *os.File) (string, int, int, image.Image, error) {
	stat, err := f.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() < 1 {
		return "", 0, 0, nil, errors.New("image must be a non-empty regular file")
	}
	format, _, _, err := imageHeader(f)
	if err != nil {
		return "", 0, 0, nil, err
	}
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		return "", 0, 0, nil, err
	}
	var decoded image.Image
	switch format {
	case "avif":
		decoded, err = avif.Decode(f, avif.Options{AutoRotate: true})
	case "webp":
		decoded, err = webp.Decode(f, webp.Options{AutoRotate: true})
	default:
		var name string
		decoded, name, err = image.Decode(f)
		if name != format {
			err = errors.New("image format changed during decode")
		}
	}
	if err != nil || decoded == nil {
		return "", 0, 0, nil, errors.New("image decode failed")
	}
	width, height := decoded.Bounds().Dx(), decoded.Bounds().Dy()
	if width < 1 || height < 1 {
		return "", 0, 0, nil, errors.New("invalid image dimensions")
	}
	return format, width, height, decoded, nil
}

func (s *server) openImage(name string) (*os.File, item, string, error) {
	if !validName(name) {
		return nil, item{}, "", os.ErrNotExist
	}
	before, err := s.images.Lstat(name)
	if err != nil || !before.Mode().IsRegular() {
		return nil, item{}, "", os.ErrNotExist
	}
	f, err := s.images.Open(name)
	if err != nil {
		return nil, item{}, "", err
	}
	stat, err := f.Stat()
	if err != nil || !os.SameFile(before, stat) {
		f.Close()
		return nil, item{}, "", os.ErrNotExist
	}
	format, width, height, err := imageHeader(f)
	if err != nil {
		f.Close()
		return nil, item{}, "", err
	}
	return f, item{Name: name, URL: "/images/" + urlEscape(name), Width: width, Height: height, Modified: stat.ModTime()}, "image/" + format, nil
}

func urlEscape(name string) string {
	// PathEscape also escapes '?' and '#'; generated URLs remain single path segments.
	return (&url.URL{Path: name}).EscapedPath()
}

type countedBody struct {
	io.ReadCloser
	bytes int64
}

func (b *countedBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	b.bytes += int64(n)
	return n, err
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusWriter) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(p)
}

func (s *server) loggedUpload(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	body := &countedBody{ReadCloser: r.Body}
	r.Body = body
	recorder := &statusWriter{ResponseWriter: w}
	defer func() {
		slog.Info("upload", "status", recorder.status, "bytes_read", body.bytes, "content_length", r.ContentLength, "duration_ms", time.Since(start).Milliseconds())
	}()
	s.upload(recorder, r)
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("GET /api/posts", s.list)
	mux.HandleFunc("POST /api/posts", s.loggedUpload)
	mux.HandleFunc("DELETE /api/posts/{name}", s.deletePost)
	mux.HandleFunc("GET /api/posts/{name}/tags", s.getTags)
	mux.HandleFunc("PUT /api/posts/{name}/tags", s.putTags)
	mux.HandleFunc("GET /images/{name}", s.media)
	mux.HandleFunc("GET /preview/{name}", s.preview)
	mux.HandleFunc("GET /posts/{name}", s.index)
	mux.HandleFunc("GET /", s.index)
	for _, name := range []string{"app.js", "style.css", "manifest.json", "icon.svg", "icon.png", "apple-touch-icon.png"} {
		mux.HandleFunc("GET /"+name, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Content-Type-Options", "nosniff")
			http.ServeFileFS(w, r, assets, "static/"+name)
		})
	}
	return mux
}

func (s *server) health(w http.ResponseWriter, _ *http.Request) {
	s.tagsMu.RLock()
	failed := s.tagsFailed
	s.tagsMu.RUnlock()
	if failed {
		http.Error(w, "Tag storage unavailable", http.StatusServiceUnavailable)
		return
	}
	name, err := randomName()
	if err == nil {
		var f *os.File
		f, err = s.images.OpenFile(".health-"+name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err == nil {
			_, err = f.Write([]byte("ok"))
			if closeErr := f.Close(); err == nil {
				err = closeErr
			}
			if removeErr := s.images.Remove(".health-" + name); err == nil {
				err = removeErr
			}
		}
	}
	if err != nil {
		http.Error(w, "Storage is not writable", http.StatusServiceUnavailable)
		return
	}
	w.Write([]byte("ok\n"))
}

func (s *server) list(w http.ResponseWriter, _ *http.Request) {
	s.tagsMu.RLock()
	if s.tagsFailed {
		s.tagsMu.RUnlock()
		http.Error(w, "Tag storage unavailable", http.StatusServiceUnavailable)
		return
	}
	defer s.tagsMu.RUnlock()
	dir, err := s.images.Open(".")
	if err != nil {
		http.Error(w, "Storage unavailable", http.StatusServiceUnavailable)
		return
	}
	entries, err := dir.ReadDir(-1)
	dir.Close()
	if err != nil {
		http.Error(w, "Storage unavailable", http.StatusServiceUnavailable)
		return
	}
	items := make([]item, 0)
	cache := make(map[string]cachedItem, len(entries))
	s.listMu.Lock()
	for _, entry := range entries {
		name := entry.Name()
		if !validName(name) || !entry.Type().IsRegular() {
			continue
		}
		stat, err := s.images.Lstat(name)
		if err != nil || !stat.Mode().IsRegular() {
			continue
		}
		if previous, ok := s.listCache[name]; ok && os.SameFile(previous.stat, stat) && previous.stat.Size() == stat.Size() && previous.stat.ModTime().Equal(stat.ModTime()) {
			cache[name] = previous
			items = append(items, previous.item)
			continue
		}
		f, image, _, err := s.openImage(name)
		if err == nil {
			stat, err = f.Stat()
			f.Close()
			if err == nil {
				cache[name] = cachedItem{image, stat}
				items = append(items, image)
			}
		}
	}
	s.listCache = cache
	s.listMu.Unlock()
	for i := range items {
		items[i].Tags = append([]string{}, s.tags[items[i].Name]...)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Modified.Equal(items[j].Modified) {
			return items[i].Name > items[j].Name
		}
		return items[i].Modified.After(items[j].Modified)
	})
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(struct {
		Items []item `json:"items"`
	}{items})
}

func (s *server) media(w http.ResponseWriter, r *http.Request) {
	f, _, contentType, err := s.openImage(r.PathValue("name"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		http.Error(w, "Image unavailable", http.StatusServiceUnavailable)
		return
	}
	stat, err := f.Stat()
	if err != nil {
		http.Error(w, "Image unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox")
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, stat.Name(), stat.ModTime(), f)
}

func (s *server) preview(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	f, _, contentType, err := s.openImage(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	if contentType != "image/avif" {
		http.NotFound(w, r)
		return
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		http.Error(w, "Preview unavailable", http.StatusServiceUnavailable)
		return
	}
	decoded, err := avif.Decode(f, avif.Options{AutoRotate: true})
	if err != nil || decoded == nil {
		http.NotFound(w, r)
		return
	}
	var out bytes.Buffer
	if err := jpeg.Encode(&out, decoded, &jpeg.Options{Quality: 85}); err != nil {
		http.Error(w, "Preview unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(out.Bytes())
}

func (s *server) index(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		if r.PathValue("name") == "" {
			http.NotFound(w, r)
			return
		}
		f, _, _, err := s.openImage(r.PathValue("name"))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		f.Close()
	}
	w.Header().Set("Content-Security-Policy", galleryCSP)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeFileFS(w, r, assets, "static/index.html")
}

func randomName() (string, error) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(id[:]), nil
}

func (s *server) upload(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || contentType != "multipart/form-data" {
		http.Error(w, "Expected multipart/form-data", http.StatusUnsupportedMediaType)
		return
	}
	reader, err := r.MultipartReader()
	if err != nil {
		http.Error(w, "Invalid multipart request", http.StatusBadRequest)
		return
	}
	part, err := reader.NextPart()
	if err != nil || part.FormName() != "file" {
		http.Error(w, "Exactly one file field is required", http.StatusBadRequest)
		return
	}
	_, params, err := mime.ParseMediaType(part.Header.Get("Content-Disposition"))
	filename := params["filename"]
	if err != nil || filename == "" || filename == "." || filename == ".." || strings.ContainsAny(filename, `/\`) {
		http.Error(w, "Invalid filename", http.StatusBadRequest)
		return
	}
	id, err := randomName()
	if err != nil {
		http.Error(w, "Storage unavailable", http.StatusServiceUnavailable)
		return
	}
	temp := ".upload-" + id
	f, err := s.images.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		http.Error(w, "Storage unavailable", http.StatusServiceUnavailable)
		return
	}
	defer s.images.Remove(temp)
	_, copyErr := io.Copy(f, part)
	if copyErr == nil {
		_, copyErr = reader.NextPart()
		if copyErr == nil {
			copyErr = errors.New("extra multipart field")
		}
		if errors.Is(copyErr, io.EOF) {
			copyErr = nil
		}
	}
	if copyErr == nil {
		copyErr = f.Sync()
	}
	if closeErr := f.Close(); copyErr == nil {
		copyErr = closeErr
	}
	if copyErr != nil {
		http.Error(w, "Invalid multipart upload", http.StatusBadRequest)
		return
	}
	input, err := s.images.Open(temp)
	if err != nil {
		http.Error(w, "Storage unavailable", http.StatusServiceUnavailable)
		return
	}
	format, width, height, _, decodeErr := inspect(input)
	input.Close()
	if decodeErr != nil {
		http.Error(w, "Unsupported or invalid image", http.StatusUnprocessableEntity)
		return
	}
	ext := "." + format
	if format == "jpeg" {
		ext = ".jpg"
	}
	name := id + ext
	if err := s.images.Rename(temp, name); err != nil {
		http.Error(w, "Storage unavailable", http.StatusServiceUnavailable)
		return
	}
	stat, err := s.images.Stat(name)
	if err != nil {
		http.Error(w, "Storage unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(struct {
		Item item `json:"item"`
	}{item{Name: name, URL: "/images/" + name, Width: width, Height: height, Modified: stat.ModTime()}})
}

func dedupe(images *os.Root, tags map[string][]string) (int, error) {
	dir, err := images.Open(".")
	if err != nil {
		return 0, err
	}
	entries, err := dir.ReadDir(-1)
	dir.Close()
	if err != nil {
		return 0, err
	}
	s := &server{images: images}
	seen := make(map[[sha256.Size]byte]bool)
	removed := 0
	for _, entry := range entries {
		name := entry.Name()
		if !validName(name) || !entry.Type().IsRegular() {
			continue
		}
		f, _, _, err := s.openImage(name)
		if err != nil { // Ignore unreadable or disappearing files.
			continue
		}
		if _, err := f.Seek(0, io.SeekStart); err == nil {
			_, _, _, _, err = inspect(f)
		}
		if err != nil {
			f.Close()
			continue
		}
		stat, err := f.Stat()
		if err == nil {
			_, err = f.Seek(0, io.SeekStart)
		}
		hash := sha256.New()
		if err == nil {
			_, err = io.Copy(hash, f)
		}
		f.Close()
		if err != nil {
			return removed, err
		}
		var digest [sha256.Size]byte
		copy(digest[:], hash.Sum(nil))
		// Keep every tagged copy: removing one would leave stale filename metadata.
		if len(tags[name]) != 0 {
			continue
		}
		if !seen[digest] {
			seen[digest] = true
			continue
		}
		current, err := images.Lstat(name)
		if err != nil {
			return removed, err
		}
		if !os.SameFile(stat, current) || stat.Size() != current.Size() || !stat.ModTime().Equal(current.ModTime()) {
			continue
		}
		if err := images.Remove(name); err != nil {
			return removed, err
		}
		removed++
	}
	return removed, nil
}

func dedupeLocked(images, data *os.Root) (int, error) {
	lock, err := lockTags(data)
	if err != nil {
		return 0, err
	}
	defer lock.Close()
	tags, err := readTags(data)
	if err != nil {
		return 0, err
	}
	return dedupe(images, tags)
}

func main() {
	dedupeMode := flag.Bool("dedupe", false, "delete duplicate images and exit")
	flag.Parse()
	if flag.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "unexpected positional arguments")
		flag.Usage()
		os.Exit(2)
	}
	dataDir := os.Getenv("SALADBOORU_DATA_DIR")
	if dataDir == "" {
		dataDir = "./data"
	}
	if *dedupeMode {
		images, err := openImages(dataDir)
		if err != nil {
			slog.Error("dedupe failed", "error", err)
			os.Exit(1)
		}
		data, err := os.OpenRoot(dataDir)
		if err != nil {
			images.Close()
			slog.Error("dedupe failed", "error", err)
			os.Exit(1)
		}
		removed, err := dedupeLocked(images, data)
		data.Close()
		images.Close()
		if err != nil {
			slog.Error("dedupe failed", "error", err)
			os.Exit(1)
		}
		slog.Info("dedupe complete", "removed", removed)
		return
	}
	s, err := newServer(dataDir)
	if err != nil {
		slog.Error("startup failed", "error", err)
		os.Exit(1)
	}
	defer s.images.Close()
	defer s.data.Close()
	slog.Info("listening", "addr", ":8080")
	if err := (&http.Server{Addr: ":8080", Handler: s.routes(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 60 * time.Second, WriteTimeout: 120 * time.Second, IdleTimeout: 60 * time.Second}).ListenAndServe(); err != nil {
		slog.Error("server stopped", "error", err)
		os.Exit(1)
	}
}
