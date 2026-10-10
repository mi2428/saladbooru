package main

import (
	"bytes"
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"io"
	"log"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/gen2brain/avif"
	"github.com/gen2brain/webp"
)

//go:embed static
var assets embed.FS

type server struct {
	images *os.Root
	token  string
}

type item struct {
	Name     string    `json:"name"`
	URL      string    `json:"url"`
	Width    int       `json:"width"`
	Height   int       `json:"height"`
	Modified time.Time `json:"modified_at"`
}

func newServer(dataDir, token string) (*server, error) {
	if len(token) < 32 || strings.TrimSpace(token) != token {
		return nil, errors.New("SALADBOORU_TOKEN must be at least 32 characters without surrounding whitespace")
	}
	for _, character := range token {
		if character < 33 || character > 126 {
			return nil, errors.New("SALADBOORU_TOKEN must contain only printable ASCII without spaces")
		}
	}
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
	root, err := os.OpenRoot(path)
	if err != nil {
		return nil, err
	}
	return &server{images: root, token: token}, nil
}

func imageFormat(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".jpg", ".jpeg":
		return "jpeg"
	case ".png":
		return "png"
	case ".gif":
		return "gif"
	case ".webp":
		return "webp"
	case ".avif":
		return "avif"
	}
	return ""
}

func validName(name string) bool {
	if name == "" || strings.HasPrefix(name, ".") || strings.ContainsAny(name, `/\`) || filepath.Base(name) != name {
		return false
	}
	return imageFormat(name) != ""
}

// inspect decodes the first frame; later animation frames remain unvalidated.
func inspect(f *os.File) (string, int, int, image.Image, error) {
	stat, err := f.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() < 1 {
		return "", 0, 0, nil, errors.New("image must be a non-empty regular file")
	}
	config, format, err := image.DecodeConfig(f)
	if err != nil || imageFormat("x."+format) == "" || config.Width < 1 || config.Height < 1 {
		return "", 0, 0, nil, errors.New("unsupported image")
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

func (s *server) openImage(name string) (*os.File, item, string, image.Image, error) {
	if !validName(name) {
		return nil, item{}, "", nil, os.ErrNotExist
	}
	before, err := s.images.Lstat(name)
	if err != nil || !before.Mode().IsRegular() {
		return nil, item{}, "", nil, os.ErrNotExist
	}
	f, err := s.images.Open(name)
	if err != nil {
		return nil, item{}, "", nil, err
	}
	stat, err := f.Stat()
	if err != nil || !os.SameFile(before, stat) {
		f.Close()
		return nil, item{}, "", nil, os.ErrNotExist
	}
	format, width, height, decoded, err := inspect(f)
	if err == nil && imageFormat(name) != format {
		err = errors.New("image extension does not match content")
	}
	if err != nil {
		f.Close()
		return nil, item{}, "", nil, err
	}
	return f, item{Name: name, URL: "/images/" + urlEscape(name), Width: width, Height: height, Modified: stat.ModTime()}, "image/" + format, decoded, nil
}

func urlEscape(name string) string {
	// PathEscape also escapes '?' and '#'; generated URLs remain single path segments.
	return (&url.URL{Path: name}).EscapedPath()
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("GET /api/posts", s.list)
	mux.HandleFunc("POST /api/posts", s.upload)
	mux.HandleFunc("GET /images/{name}", s.media)
	mux.HandleFunc("GET /preview/{name}", s.preview)
	mux.HandleFunc("GET /posts/{name}", s.index)
	mux.HandleFunc("GET /", s.index)
	for _, name := range []string{"app.js", "style.css"} {
		mux.HandleFunc("GET /"+name, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Content-Type-Options", "nosniff")
			http.ServeFileFS(w, r, assets, "static/"+name)
		})
	}
	return mux
}

func (s *server) health(w http.ResponseWriter, _ *http.Request) {
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
	for _, entry := range entries {
		if !validName(entry.Name()) || !entry.Type().IsRegular() {
			continue
		}
		f, image, _, _, err := s.openImage(entry.Name())
		if err == nil {
			f.Close()
			items = append(items, image)
		}
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
	f, _, contentType, _, err := s.openImage(r.PathValue("name"))
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
	if imageFormat(name) != "avif" {
		http.NotFound(w, r)
		return
	}
	f, _, _, decoded, err := s.openImage(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
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
		f, _, _, _, err := s.openImage(r.PathValue("name"))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		f.Close()
	}
	w.Header().Set("Content-Security-Policy", "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'")
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
	scheme, provided, ok := strings.Cut(r.Header.Get("Authorization"), " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") || subtle.ConstantTimeCompare([]byte(provided), []byte(s.token)) != 1 {
		w.Header().Set("WWW-Authenticate", "Bearer")
		http.Error(w, "Bearer token required", http.StatusUnauthorized)
		return
	}
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
	if filepath.Ext(filename) != "" && imageFormat(filename) != format {
		http.Error(w, "Image extension does not match content", http.StatusUnprocessableEntity)
		return
	}
	ext := strings.ToLower(filepath.Ext(filename))
	if ext == "" {
		ext = "." + format
	}
	if ext == ".jpeg" {
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

func main() {
	dataDir := os.Getenv("SALADBOORU_DATA_DIR")
	if dataDir == "" {
		dataDir = "./data"
	}
	s, err := newServer(dataDir, os.Getenv("SALADBOORU_TOKEN"))
	if err != nil {
		log.Fatal(err)
	}
	defer s.images.Close()
	log.Fatal((&http.Server{Addr: ":8080", Handler: s.routes(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 60 * time.Second, WriteTimeout: 120 * time.Second, IdleTimeout: 60 * time.Second}).ListenAndServe())
}
