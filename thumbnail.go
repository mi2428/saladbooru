package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/draw"
	"io"
	"log/slog"
	"math"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/gen2brain/webp"
	xdraw "golang.org/x/image/draw"
)

type cachedThumbnail struct {
	data []byte
	stat os.FileInfo
}

type thumbnailCacheStats struct {
	Since           time.Time `json:"since"`
	CacheEntries    int       `json:"cache_entries"`
	CacheBytes      int       `json:"cache_bytes"`
	CacheLimitBytes int       `json:"cache_limit_bytes"`
	Lookups         uint64    `json:"lookups"`
	Hits            uint64    `json:"hits"`
	Misses          uint64    `json:"misses"`
	HitRate         *float64  `json:"hit_rate"`
	Generated       uint64    `json:"generated"`
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

func (s *server) thumbnailCacheStats(w http.ResponseWriter, _ *http.Request) {
	s.thumbMu.Lock()
	hits, misses := s.thumbHits, s.thumbMisses
	lookups := hits + misses
	var hitRate *float64
	if lookups > 0 {
		rate := float64(hits) / float64(lookups)
		hitRate = &rate
	}
	stats := thumbnailCacheStats{
		Since:           s.thumbStatsSince,
		CacheEntries:    len(s.thumbCache),
		CacheBytes:      s.thumbBytes,
		CacheLimitBytes: s.thumbLimit,
		Lookups:         lookups,
		Hits:            hits,
		Misses:          misses,
		HitRate:         hitRate,
		Generated:       s.thumbGenerated,
	}
	s.thumbMu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	json.NewEncoder(w).Encode(stats)
}

func (s *server) thumbnail(w http.ResponseWriter, r *http.Request) {
	if r.Context().Err() != nil {
		return
	}
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
	data, err := s.thumbnailBytes(r.Context(), r.PathValue("name"), f, stat)
	if err != nil {
		if r.Context().Err() != nil {
			return
		}
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

func (s *server) thumbnailBytes(ctx context.Context, name string, f *os.File, stat os.FileInfo) ([]byte, error) {
	// Serialize first-time decodes to bound peak memory.
	s.thumbMu.Lock()
	defer s.thumbMu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if cached, ok := s.thumbCache[name]; ok && os.SameFile(cached.stat, stat) && cached.stat.Size() == stat.Size() && cached.stat.ModTime().Equal(stat.ModTime()) {
		s.thumbHits++
		return cached.data, nil
	}
	s.thumbMisses++
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	_, _, _, decoded, err := inspect(f)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
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
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var out bytes.Buffer
	if err := webp.Encode(&out, decoded, webp.Options{Quality: 75, Method: 2}); err != nil {
		return nil, err
	}
	s.thumbGenerated++
	if err := ctx.Err(); err != nil {
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
