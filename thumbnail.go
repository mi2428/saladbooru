package main

import (
	"bytes"
	"errors"
	"image"
	"image/draw"
	"io"
	"log/slog"
	"math"
	"net/http"
	"os"
	"strconv"

	"github.com/gen2brain/webp"
	xdraw "golang.org/x/image/draw"
)

type cachedThumbnail struct {
	data []byte
	stat os.FileInfo
}

const mebibyte = 1 << 20
const defaultThumbnailCacheLimit = 64 * mebibyte

func thumbnailCacheLimit() (int, error) {
	const settingName = "SALADBOORU_THUMB_CACHE_MIB"
	setting, configured := os.LookupEnv(settingName)
	if !configured {
		return defaultThumbnailCacheLimit, nil
	}
	mib, err := strconv.Atoi(setting)
	if err != nil || mib < 0 || mib > math.MaxInt/mebibyte {
		return 0, errors.New(settingName + " must be a non-negative number of MiB")
	}
	return mib * mebibyte, nil
}

func (s *server) thumbnail(w http.ResponseWriter, r *http.Request) {
	f, _, contentType, err := s.openImage(r.PathValue("name"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	if contentType != "image/jpeg" && contentType != "image/png" {
		http.NotFound(w, r)
		return
	}
	stat, err := f.Stat()
	if err != nil {
		http.Error(w, "Image unavailable", http.StatusServiceUnavailable)
		return
	}
	data, err := s.thumbnailBytes(r.PathValue("name"), f, stat)
	if err != nil {
		slog.Warn("thumbnail failed", "error", err)
		http.Error(w, "Thumbnail unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "image/webp")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(data)
}

func (s *server) thumbnailBytes(name string, f *os.File, stat os.FileInfo) ([]byte, error) {
	// Serialize first-time decodes to bound peak memory.
	s.thumbMu.Lock()
	defer s.thumbMu.Unlock()
	if cached, ok := s.thumbCache[name]; ok && os.SameFile(cached.stat, stat) && cached.stat.Size() == stat.Size() && cached.stat.ModTime().Equal(stat.ModTime()) {
		return cached.data, nil
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	_, _, _, decoded, err := inspect(f)
	if err != nil {
		return nil, err
	}
	bounds := decoded.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if longest := max(width, height); longest > 1024 {
		width = max(1, width*1024/longest)
		height = max(1, height*1024/longest)
		scaled := image.NewRGBA(image.Rect(0, 0, width, height))
		xdraw.ApproxBiLinear.Scale(scaled, scaled.Bounds(), decoded, bounds, draw.Src, nil)
		decoded = scaled
	}
	var out bytes.Buffer
	if err := webp.Encode(&out, decoded, webp.Options{Quality: 75, Method: 2}); err != nil {
		return nil, err
	}
	// Clear the whole cache at its limit; use LRU if broad galleries cause repeat decoding.
	if s.thumbLimit > 0 && out.Len() <= s.thumbLimit {
		if previous, ok := s.thumbCache[name]; ok {
			s.thumbBytes -= len(previous.data)
		}
		if s.thumbBytes+out.Len() > s.thumbLimit {
			s.thumbCache = nil
			s.thumbBytes = 0
		}
		if s.thumbCache == nil {
			s.thumbCache = make(map[string]cachedThumbnail)
		}
		s.thumbCache[name] = cachedThumbnail{out.Bytes(), stat}
		s.thumbBytes += out.Len()
	}
	return out.Bytes(), nil
}
