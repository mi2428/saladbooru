# Saladbooru

Saladbooru—a nod to [サラダボウル](https://ja.wikipedia.org/wiki/%E3%82%B5%E3%83%A9%E3%83%80%E3%83%9C%E3%82%A6%E3%83%AB_(%E6%BC%AB%E7%94%BB))—is a minimal, file-only booru: drop images into the gallery or a folder and they appear there.
No database, URL import, or generated thumbnails to maintain.
JPEG, PNG, GIF, WebP, and AVIF are supported; HEIC/HEIF are not.

![](screenshot.png)

## Getting Started

### Kubernetes (recommended)

`base/` provides a Deployment with health probes, an internal ClusterIP Service, a 32-Gi ReadWriteOnce PVC for `/data`, and a daily duplicate-removal CronJob.
No PV, Ingress, or external authentication is included.
**Keep the service on a trusted network: image POST, tag PUT, and image DELETE are unauthenticated.**

From the repository root, build the supported `linux/amd64` image (replace the example registry and tag):

```console
$ docker buildx build --platform linux/amd64 -t registry.example.com/saladbooru:v1 --push .
```

Replace `saladbooru:latest` in both `base/deployment.yaml` and `base/cronjob.yaml` with that image, or override both with a Kustomize overlay.
Provide a PV or default StorageClass that binds the PVC and lets UID 10001 write to `/data`; adjust the security context if your volume requires a different UID. Then deploy:

```console
$ kubectl create namespace saladbooru --dry-run=client -o yaml | kubectl apply -f -
$ kubectl -n saladbooru kustomize base
$ kubectl -n saladbooru apply --dry-run=server -k base
$ kubectl -n saladbooru apply -k base
$ kubectl -n saladbooru rollout status deployment/saladbooru --timeout=180s
$ kubectl -n saladbooru port-forward svc/saladbooru 18080:8080
```

Open http://127.0.0.1:18080/.
Images can be uploaded there, posted as multipart `file` to `POST /api/posts`, or placed directly in `/data/images/`.

The dedupe CronJob runs every six hours and removes byte-identical images and, by default, visually equivalent JPEG and PNG images.
It requires close pHash and dHash values, then confirms the pair with local SSIM; tags from the removed file are merged into the retained file.
The retained image is chosen by pixel count, format (`PNG > AVIF > WebP > JPEG > GIF`), oldest modification time, then filename.
GIF, WebP, and AVIF files are only deduplicated when their bytes are identical, avoiding false matches between animations that share a first frame.

Tune the conservative defaults in `base/cronjob.yaml` through environment variables:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `SALADBOORU_DEDUPE_SIMILAR` | `false` | Enable visual matching (`base/cronjob.yaml` sets `true`) |
| `SALADBOORU_DEDUPE_PHASH_MAX_DISTANCE` | `4` | Maximum pHash Hamming distance, 0–64 |
| `SALADBOORU_DEDUPE_DHASH_MAX_DISTANCE` | `4` | Maximum dHash Hamming distance, 0–64 |
| `SALADBOORU_DEDUPE_SSIM_MIN` | `0.90` | Minimum local SSIM, 0–1 |

Lower hash distances or raise SSIM to reduce matches.
Invalid values fail the dedupe Job instead of silently changing its behavior.

### Docker

Try Saladbooru locally with Docker Compose:

```sh
docker compose -f docker-compose.dev.yml up --build -d
```

Run `npm ci && npm run check && npm run build`, then `go test ./...`; the Dockerfile runs the UI checks and build automatically.

## License

[MIT](LICENSE)
