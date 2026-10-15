FROM --platform=$BUILDPLATFORM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS web
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY tests ./tests
RUN npm run check && npm run build

FROM --platform=$BUILDPLATFORM golang:1.26.9-alpine3.23@sha256:6750308561953d451210ed1a8086d36c8c8bdcbf672d38d9d0d424b8a7a0216c AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go tags.go thumbnail.go ./
COPY static ./static
COPY --from=web /src/static/app.js ./static/app.js
ARG TARGETOS=linux
ARG TARGETARCH=amd64
RUN test "${TARGETARCH}" = amd64 && CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -ldflags='-s -w' -o /saladbooru .

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends \
    libwebp7 libwebpdemux2 perl-base \
 && ln -s libwebp.so.7 /usr/lib/x86_64-linux-gnu/libwebp.so \
 && ln -s libwebpdemux.so.2 /usr/lib/x86_64-linux-gnu/libwebpdemux.so \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 10001 saladbooru && useradd -u 10001 -g 10001 -M -s /usr/sbin/nologin saladbooru
COPY --from=build /saladbooru /saladbooru
USER 10001:10001
EXPOSE 8080
CMD ["/saladbooru"]
