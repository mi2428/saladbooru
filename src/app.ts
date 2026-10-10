type Post = {name: string; url: string; width: number; height: number};

export function layoutRows(ratios: number[], width: number, targetHeight: number) {
  const positions: {x: number; y: number; width: number; height: number}[] = [];
  const gap = 8;
  let y = 0;
  for (let start = 0; start < ratios.length;) {
    let end = start + 1;
    let sum = ratios[start];
    while (end < ratios.length && width > gap * (end - start)) {
      const before = (width - gap * (end - start - 1)) / sum;
      const after = (width - gap * (end - start)) / (sum + ratios[end]);
      if (after <= targetHeight) {
        if (Math.abs(before - targetHeight) < Math.abs(after - targetHeight)) break;
        sum += ratios[end++];
        break;
      }
      sum += ratios[end++];
    }
    const count = end - start;
    const fullHeight = (width - gap * (count - 1)) / sum;
    const coverage = (targetHeight * sum + gap * (count - 1)) / width;
    const height = end === ratios.length && coverage < 0.75 ? Math.min(targetHeight, fullHeight) : fullHeight;
    let x = 0;
    for (let i = start; i < end; i++) {
      const imageWidth = height * ratios[i];
      positions.push({x, y, width: imageWidth, height});
      x += imageWidth + gap;
    }
    y += height + gap;
    start = end;
  }
  return {positions, height: positions.length ? y - gap : 0};
}

export function installZoom(relayout: () => void): () => number {
  let pinch: {distance: number; size: number} | null = null;
  let gestureSize: number | null = null;
  let preferredHeight = 220;
  const anchorAt = (x: number, y: number) => {
    const element = document.elementFromPoint(x, y)?.closest('#grid a');
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {element, fraction: (y - rect.top) / rect.height, y};
  };
  const setSize = (value: number, anchor: ReturnType<typeof anchorAt>) => {
    const size = Math.max(100, Math.min(500, value));
    if (!Number.isFinite(size) || size === preferredHeight) return;
    preferredHeight = size;
    relayout();
    if (anchor) {
      const rect = anchor.element.getBoundingClientRect();
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      window.scrollTo(0, Math.max(0, Math.min(maxScroll, window.scrollY + rect.top + rect.height * anchor.fraction - anchor.y)));
    }
  };
  window.addEventListener('wheel', event => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    if (gestureSize !== null) return;
    const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
    setSize(preferredHeight * Math.exp(-event.deltaY * units / 500), anchorAt(event.clientX, event.clientY));
  }, {passive: false});
  window.addEventListener('gesturestart', event => {
    event.preventDefault();
    gestureSize = preferredHeight;
  }, {passive: false});
  window.addEventListener('gesturechange', event => {
    event.preventDefault();
    if (gestureSize !== null) setSize(gestureSize * (event as Event & {scale: number}).scale, null);
  }, {passive: false});
  window.addEventListener('gestureend', event => { event.preventDefault(); gestureSize = null; pinch = null; }, {passive: false});
  const distance = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
  window.addEventListener('touchstart', event => {
    if (event.touches.length === 2) pinch = {distance: distance(event.touches), size: preferredHeight};
  }, {passive: true});
  window.addEventListener('touchmove', event => {
    if (event.touches.length === 2 && pinch) {
      event.preventDefault();
      if (gestureSize === null && pinch.distance) setSize(pinch.size * distance(event.touches) / pinch.distance, null);
    }
  }, {passive: false});
  window.addEventListener('touchend', event => { if (event.touches.length < 2) pinch = null; });
  window.addEventListener('touchcancel', () => { pinch = null; gestureSize = null; });
  return () => preferredHeight;
}

export function imageRatio(post: Pick<Post, 'width' | 'height'>, img: Pick<HTMLImageElement, 'naturalWidth' | 'naturalHeight'>): number {
  return img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : post.width / post.height;
}

export function showImage(img: HTMLImageElement, url: string, onError: () => void): void {
  let fallback = true;
  img.addEventListener('error', () => {
    if (fallback) {
      fallback = false;
      img.src = url.replace(/^\/images\//, '/preview/');
    } else onError();
  });
  img.src = url;
}

if (typeof document !== 'undefined') {
  const grid = document.getElementById('grid');
  const detail = document.getElementById('detail');
  const status = document.getElementById('status');
  if (!grid || !detail || !status) throw new Error('Missing gallery elements');
  const match = location.pathname.match(/^\/posts\/([^/]+)$/);
  if (match) {
    grid.hidden = true;
    detail.hidden = false;
    const full = document.getElementById('full');
    const back = document.getElementById('back');
    if (!(full instanceof HTMLImageElement) || !(back instanceof HTMLAnchorElement)) throw new Error('Missing detail elements');
    full.alt = decodeURIComponent(match[1]);
    showImage(full, `/images/${match[1]}`, () => { status.textContent = 'This image cannot be displayed'; });
  } else {
    const entries: {link: HTMLAnchorElement; ratio: number}[] = [];
    const preferredHeight = installZoom(layout);
    function layout() {
      if (!grid) throw new Error('Missing grid');
      const width = grid.clientWidth;
      if (!width) return;
      const {positions, height} = layoutRows(entries.map(entry => entry.ratio), width, preferredHeight());
      entries.forEach(({link}, index) => {
        const rect = positions[index];
        Object.assign(link.style, {left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px`});
      });
      grid.style.height = `${height}px`;
    }
    let measuredWidth = grid.clientWidth;
    new ResizeObserver(() => {
      if (grid.clientWidth !== measuredWidth) {
        measuredWidth = grid.clientWidth;
        layout();
      }
    }).observe(grid);
    fetch('/api/posts').then(response => {
      if (!response.ok) throw new Error(`Failed to load images (${response.status})`);
      return response.json() as Promise<{items: Post[]}>;
    }).then(({items}) => {
      for (const post of items) {
        const link = document.createElement('a');
        const img = document.createElement('img');
        link.href = `/posts/${encodeURIComponent(post.name)}`;
        img.alt = post.name;
        img.loading = 'lazy';
        const entry = {link, ratio: imageRatio(post, img)};
        img.addEventListener('load', () => {
          entry.ratio = imageRatio(post, img);
          layout();
        });
        link.append(img);
        grid.append(link);
        entries.push(entry);
        showImage(img, post.url, () => { status.textContent = 'Some images cannot be displayed'; });
      }
      layout();
      if (!items.length) status.textContent = 'No images yet';
    }).catch(error => { status.textContent = error instanceof Error ? error.message : String(error); });
  }
}
