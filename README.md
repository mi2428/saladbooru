# Saladbooru

Saladbooru—a nod to [サラダボウル](https://ja.wikipedia.org/wiki/%E3%82%B5%E3%83%A9%E3%83%80%E3%83%9C%E3%82%A6%E3%83%AB_(%E6%BC%AB%E7%94%BB))—is a minimal, file-only booru: drop images into the gallery or a folder and they appear there.
No database, URL import, or generated thumbnails to maintain.
JPEG, PNG, GIF, WebP, and AVIF are supported; HEIC/HEIF are not.

![](screenshot.png)

## Getting Started

`base/` is a portable Kustomize Deployment, Service, and PVC.
Before `kubectl apply -k base`, replace `saladbooru:latest` with an image your cluster can pull and provide writable storage for UID 10001.
Post a file with `POST /api/posts` as multipart `file`; placing it in `/data/images/` works without an API.
A daily CronJob removes duplicate images.

### Try it locally

Run with Docker Compose:

```sh
docker compose -f docker-compose.dev.yml up --build -d
```

Open http://127.0.0.1:18080/; the review gallery data is stored in `data/tag-review/` by default.
`src/app.ts` compiles to ignored `static/app.js` for Go's embedded UI.
Run `npm ci && npm run check && npm run build`, then `go test ./...`; the Dockerfile runs the UI checks and build automatically.

## License

[MIT](LICENSE)
