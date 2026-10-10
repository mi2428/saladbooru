# Synthetic image fixtures

All files here are generated from a 4x2 FFmpeg test pattern or a solid blue
frame; they are not user photographs. The animated fixtures have two frames.

Regenerate with FFmpeg, WebP tools, and an AV1 encoder (output bytes vary by
encoder version). Regenerated files must pass Go tests on macOS and linux/amd64:

```sh
ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc=size=4x2:rate=1 -frames:v 1 -update 1 testdata/source.png
ffmpeg -hide_banner -loglevel error -f lavfi -i color=c=blue:s=4x2:rate=1 -frames:v 1 -update 1 testdata/second.png
ffmpeg -hide_banner -loglevel error -i testdata/source.png -frames:v 1 -update 1 testdata/source.jpg
ffmpeg -hide_banner -loglevel error -i testdata/source.png -frames:v 1 -update 1 testdata/source.gif
ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc=size=4x2:rate=1 -frames:v 2 -y testdata/two.gif
cwebp -quiet testdata/source.png -o testdata/source.webp
img2webp -d 100 testdata/source.png testdata/second.png -o testdata/two.webp
```

The included AVIF fixtures encode the same synthetic frames with AV1; no
HEIC/HEIF or HEVC fixture is distributed.
