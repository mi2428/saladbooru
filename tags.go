package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"mime"
	"net/http"
	"os"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

func lockTags(data *os.Root) (*os.File, error) {
	dir, err := data.Open(".")
	if err != nil {
		return nil, err
	}
	fd, err := unix.Openat(int(dir.Fd()), ".tags.lock", unix.O_CREAT|unix.O_RDWR|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	dir.Close()
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), ".tags.lock")
	valid := func() bool {
		stat, err := f.Stat()
		if err != nil || !stat.Mode().IsRegular() {
			return false
		}
		path, err := data.Lstat(".tags.lock")
		return err == nil && os.SameFile(stat, path)
	}
	if !valid() {
		f.Close()
		return nil, errors.New("tag lock must be a private regular file")
	}
	if err := unix.Flock(fd, unix.LOCK_EX); err != nil {
		f.Close()
		return nil, err
	}
	if !valid() {
		f.Close()
		return nil, errors.New("tag lock changed while waiting")
	}
	return f, nil
}

func validateTags(tags []string) error {
	if tags == nil {
		return errors.New("Tags must be an array")
	}
	seen := map[string]bool{}
	for _, name := range tags {
		if name == "" || strings.TrimSpace(name) != name || utf8.RuneCountInString(name) > 80 || strings.IndexFunc(name, func(r rune) bool { return unicode.IsControl(r) || unicode.In(r, unicode.Cf) }) >= 0 {
			return errors.New("Tag names must be 1–80 characters without surrounding whitespace or control characters")
		}
		key := strings.ToLower(name)
		if seen[key] {
			return errors.New("Duplicate tag")
		}
		seen[key] = true
	}
	return nil
}

func decodeTagList(raw []byte) ([]string, error) {
	if !utf8.Valid(raw) {
		return nil, errors.New("Invalid UTF-8")
	}
	var tags []string
	if err := json.Unmarshal(raw, &tags); err != nil {
		return nil, err
	}
	if err := validateTags(tags); err != nil {
		return nil, err
	}
	return tags, nil
}

func readTags(data *os.Root) (map[string][]string, error) {
	tags := map[string][]string{}
	before, err := data.Lstat("tags.json")
	if errors.Is(err, os.ErrNotExist) {
		return tags, nil
	}
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() || before.Mode().Perm()&0077 != 0 || before.Size() > 16<<20 {
		return nil, errors.New("tags.json must be a private regular file of at most 16 MiB")
	}
	f, err := data.Open("tags.json")
	if err != nil {
		return nil, err
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil || !os.SameFile(before, stat) {
		return nil, errors.New("tags.json changed while opening")
	}
	raw, err := io.ReadAll(io.LimitReader(f, 16<<20+1))
	if err != nil || len(raw) > 16<<20 || !utf8.Valid(raw) {
		return nil, errors.New("tags.json is unreadable, oversized or invalid UTF-8")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	if start, err := dec.Token(); err != nil || start != json.Delim('{') {
		return nil, errors.New("tags.json must contain a filename map")
	}
	for dec.More() {
		key, err := dec.Token()
		if err != nil {
			return nil, err
		}
		name, ok := key.(string)
		if !ok || !validName(name) {
			return nil, errors.New("Invalid filename in tags.json")
		}
		if _, exists := tags[name]; exists {
			return nil, errors.New("Duplicate filename in tags.json")
		}
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, err
		}
		list, err := decodeTagList(value)
		if err != nil {
			return nil, fmt.Errorf("invalid tags for %q: %w", name, err)
		}
		tags[name] = list
	}
	if end, err := dec.Token(); err != nil || end != json.Delim('}') {
		return nil, errors.New("Invalid tags.json map")
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("Unexpected JSON after tags.json map")
	}
	return tags, nil
}

func (s *server) getTags(w http.ResponseWriter, r *http.Request) {
	s.tagsMu.RLock()
	defer s.tagsMu.RUnlock()
	if s.tagsFailed {
		http.Error(w, "Tag storage unavailable", http.StatusServiceUnavailable)
		return
	}
	tags, err := readTags(s.data)
	if err != nil {
		http.Error(w, "Tag storage unavailable", http.StatusServiceUnavailable)
		return
	}
	name := r.PathValue("name")
	f, _, _, err := s.openImage(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	f.Close()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(struct {
		Tags []string `json:"tags"`
	}{append([]string{}, tags[name]...)})
}

func (s *server) putTags(w http.ResponseWriter, r *http.Request) {
	contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || contentType != "application/json" {
		http.Error(w, "Expected application/json", http.StatusUnsupportedMediaType)
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 16<<20+1))
	if err != nil || len(raw) > 16<<20 {
		http.Error(w, "Tag request too large", http.StatusRequestEntityTooLarge)
		return
	}
	if !utf8.Valid(raw) {
		http.Error(w, "Invalid UTF-8", http.StatusBadRequest)
		return
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	start, err := dec.Token()
	if err != nil || start != json.Delim('{') {
		http.Error(w, "Invalid tag request", http.StatusBadRequest)
		return
	}
	var payload json.RawMessage
	for dec.More() {
		field, err := dec.Token()
		if err != nil || field != "tags" || payload != nil || dec.Decode(&payload) != nil {
			http.Error(w, "Tag request must contain only one tags field", http.StatusBadRequest)
			return
		}
	}
	if end, err := dec.Token(); err != nil || end != json.Delim('}') {
		http.Error(w, "Invalid tag request", http.StatusBadRequest)
		return
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		http.Error(w, "Unexpected JSON after tag request", http.StatusBadRequest)
		return
	}
	tags, err := decodeTagList(payload)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.tagsMu.Lock()
	defer s.tagsMu.Unlock()
	if s.tagsFailed {
		http.Error(w, "Tag storage unavailable", http.StatusServiceUnavailable)
		return
	}
	lock, err := lockTags(s.data)
	if err != nil {
		s.tagsFailed = true
		http.Error(w, "Tag storage unavailable", http.StatusServiceUnavailable)
		return
	}
	defer lock.Close()
	previous, err := readTags(s.data)
	if err != nil {
		http.Error(w, "Tag storage unavailable", http.StatusServiceUnavailable)
		return
	}
	name := r.PathValue("name")
	f, _, _, err := s.openImage(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	f.Close()
	next := maps.Clone(previous)
	if len(tags) == 0 {
		delete(next, name)
	} else {
		next[name] = tags
	}
	if err := s.saveTags(next); err != nil {
		http.Error(w, "Tag storage unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(struct {
		Tags []string `json:"tags"`
	}{tags})
}

func (s *server) deletePost(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !validName(name) {
		http.NotFound(w, r)
		return
	}
	s.tagsMu.Lock()
	defer s.tagsMu.Unlock()
	if s.tagsFailed {
		http.Error(w, "Tag storage unavailable", http.StatusServiceUnavailable)
		return
	}
	lock, err := lockTags(s.data)
	if err != nil {
		s.tagsFailed = true
		http.Error(w, "Tag storage unavailable", http.StatusServiceUnavailable)
		return
	}
	defer lock.Close()
	previous, err := readTags(s.data)
	if err != nil {
		http.Error(w, "Tag storage unavailable", http.StatusServiceUnavailable)
		return
	}
	f, _, _, err := s.openImage(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	f.Close()
	id, err := randomName()
	if err != nil {
		http.Error(w, "Storage unavailable", http.StatusServiceUnavailable)
		return
	}
	hidden := ".delete-" + id
	if err := s.images.Rename(name, hidden); err != nil {
		http.Error(w, "Storage unavailable", http.StatusServiceUnavailable)
		return
	}
	_, tagged := previous[name]
	if tagged {
		next := maps.Clone(previous)
		delete(next, name)
		if err := s.saveTags(next); err != nil {
			if s.images.Rename(hidden, name) != nil {
				s.tagsFailed = true
			}
			http.Error(w, "Tag storage unavailable", http.StatusServiceUnavailable)
			return
		}
	}
	if err := s.images.Remove(hidden); err != nil {
		if s.images.Rename(hidden, name) != nil {
			s.tagsFailed = true
		} else if tagged && s.saveTags(previous) != nil {
			s.tagsFailed = true
		}
		http.Error(w, "Storage unavailable", http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// saveTags is called under the file lock (and tagsMu for HTTP writes).
// A post-rename sync failure closes the store to writes and reads.
func (s *server) saveTags(next map[string][]string) error {
	previous, err := s.data.Lstat("tags.json")
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		s.tagsFailed = true
		return err
	}
	if err == nil && (!previous.Mode().IsRegular() || previous.Mode().Perm()&0077 != 0) {
		s.tagsFailed = true
		return errors.New("tags.json is not a private regular file")
	}
	raw, err := json.Marshal(next)
	if err != nil || len(raw) > 16<<20 {
		return errors.New("Tag map too large")
	}
	id, err := randomName()
	if err != nil {
		return err
	}
	temp := ".tags-" + id
	f, err := s.data.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer s.data.Remove(temp)
	_, err = f.Write(raw)
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = s.data.Rename(temp, "tags.json"); err != nil {
		return err
	}
	dir, err := s.data.Open(".")
	if err == nil {
		err = dir.Sync()
		if closeErr := dir.Close(); err == nil {
			err = closeErr
		}
	}
	if err != nil {
		s.tagsFailed = true
		return err
	}
	return nil
}
