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
  img.onerror = () => {
    if (fallback) {
      fallback = false;
      img.src = url.replace(/^\/images\//, '/preview/');
    } else onError();
  };
  img.src = url;
}

if (typeof document !== 'undefined') {
  const gridElement = document.getElementById('grid');
  const detailElement = document.getElementById('detail');
  const statusElement = document.getElementById('status');
  const detailStatusElement = document.getElementById('detail-status');
  const fullElement = document.getElementById('full');
  const backElement = document.getElementById('back');
  const refreshElement = document.getElementById('refresh');
  if (!gridElement || !detailElement || !statusElement || !detailStatusElement || !(fullElement instanceof HTMLImageElement) || !(backElement instanceof HTMLAnchorElement) || !(refreshElement instanceof HTMLButtonElement)) {
    throw new Error('Missing gallery elements');
  }
  const grid = gridElement, detail = detailElement, status = statusElement, detailStatus = detailStatusElement, full = fullElement, back = backElement;
  refreshElement.addEventListener('click', () => location.reload());

  let galleryLoaded = false;
  let openedFromGallery = false;
  let savedScroll = 0;
  let previousFocus: HTMLElement | null = null;
  let scale = 1;
  let panX = 0;
  let panY = 0;
  let drag: {x: number; y: number} | null = null;
  let touch: {x: number; y: number} | null = null;
  let pinch: {distance: number; scale: number; x: number; y: number; panX: number; panY: number} | null = null;
  let gestureScale = 1;

  function renderImage() {
    const maxX = Math.max(0, (full.offsetWidth * scale - detail.clientWidth) / 2);
    const maxY = Math.max(0, (full.offsetHeight * scale - detail.clientHeight) / 2);
    panX = Math.max(-maxX, Math.min(maxX, panX));
    panY = Math.max(-maxY, Math.min(maxY, panY));
    full.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  }
  function zoom(value: number, x: number, y: number) {
    const next = Math.max(1, Math.min(8, value));
    if (!Number.isFinite(next)) return;
    const factor = next / scale;
    panX = x - detail.clientWidth / 2 - (x - detail.clientWidth / 2 - panX) * factor;
    panY = y - detail.clientHeight / 2 - (y - detail.clientHeight / 2 - panY) * factor;
    scale = next;
    renderImage();
  }
  function openDetail(name: string) {
    if (detail.hidden) savedScroll = window.scrollY;
    openedFromGallery = galleryLoaded;
    grid.inert = true;
    detail.hidden = false;
    document.documentElement.style.overflow = 'hidden';
    scale = 1;
    panX = panY = 0;
    renderImage();
    detailStatus.textContent = '';
    full.alt = decodeURIComponent(name);
    showImage(full, `/images/${name}`, () => { detailStatus.textContent = 'This image cannot be displayed'; });
    back.focus({preventScroll: true});
  }
  function closeDetail() {
    if (detail.hidden) return;
    detail.hidden = true;
    grid.inert = false;
    document.documentElement.style.overflow = '';
    window.scrollTo(0, savedScroll);
    previousFocus?.focus({preventScroll: true});
  }
  back.addEventListener('click', event => {
    if (!openedFromGallery) return;
    event.preventDefault();
    history.back();
  });
  window.addEventListener('popstate', () => {
    const match = location.pathname.match(/^\/posts\/([^/]+)$/);
    if (match) openDetail(match[1]);
    else {
      closeDetail();
      loadGallery();
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !detail.hidden) back.click();
  });
  detail.addEventListener('wheel', event => {
    event.preventDefault();
    event.stopPropagation();
    const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? detail.clientHeight : 1;
    zoom(scale * Math.exp(-event.deltaY * units / 500), event.clientX, event.clientY);
  }, {passive: false});
  detail.addEventListener('dblclick', event => {
    if (event.target === back || back.contains(event.target as Node)) return;
    zoom(scale === 1 ? 2 : 1, event.clientX, event.clientY);
  });
  detail.addEventListener('pointerdown', event => {
    if (event.pointerType === 'touch' || event.target !== full || scale === 1) return;
    drag = {x: event.clientX, y: event.clientY};
    detail.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  detail.addEventListener('pointermove', event => {
    if (!drag) return;
    panX += event.clientX - drag.x;
    panY += event.clientY - drag.y;
    drag = {x: event.clientX, y: event.clientY};
    renderImage();
  });
  detail.addEventListener('pointerup', () => { drag = null; });
  detail.addEventListener('pointercancel', () => { drag = null; });
  const center = (touches: TouchList) => ({x: (touches[0].clientX + touches[1].clientX) / 2, y: (touches[0].clientY + touches[1].clientY) / 2});
  const distance = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
  detail.addEventListener('touchstart', event => {
    event.stopPropagation();
    if (event.touches.length === 2) pinch = {distance: distance(event.touches), scale, ...center(event.touches), panX, panY};
    else if (event.touches.length === 1) touch = {x: event.touches[0].clientX, y: event.touches[0].clientY};
  });
  detail.addEventListener('touchmove', event => {
    event.preventDefault();
    event.stopPropagation();
    if (event.touches.length === 2 && pinch?.distance) {
      const point = center(event.touches);
      scale = Math.max(1, Math.min(8, pinch.scale * distance(event.touches) / pinch.distance));
      panX = point.x - detail.clientWidth / 2 - (pinch.x - detail.clientWidth / 2 - pinch.panX) * scale / pinch.scale;
      panY = point.y - detail.clientHeight / 2 - (pinch.y - detail.clientHeight / 2 - pinch.panY) * scale / pinch.scale;
      renderImage();
    } else if (event.touches.length === 1 && touch) {
      panX += event.touches[0].clientX - touch.x;
      panY += event.touches[0].clientY - touch.y;
      touch = {x: event.touches[0].clientX, y: event.touches[0].clientY};
      renderImage();
    }
  }, {passive: false});
  detail.addEventListener('touchend', event => { event.stopPropagation(); pinch = null; touch = event.touches.length === 1 ? {x: event.touches[0].clientX, y: event.touches[0].clientY} : null; });
  detail.addEventListener('touchcancel', event => { event.stopPropagation(); pinch = touch = null; });
  detail.addEventListener('gesturestart', event => { event.preventDefault(); event.stopPropagation(); gestureScale = scale; }, {passive: false});
  detail.addEventListener('gesturechange', event => {
    event.preventDefault();
    event.stopPropagation();
    zoom(gestureScale * (event as Event & {scale: number}).scale, detail.clientWidth / 2, detail.clientHeight / 2);
  }, {passive: false});
  detail.addEventListener('gestureend', event => { event.preventDefault(); event.stopPropagation(); }, {passive: false});

  function loadGallery() {
    if (galleryLoaded) return;
    galleryLoaded = true;
    const entries: {link: HTMLAnchorElement; ratio: number}[] = [];
    const preferredHeight = installZoom(layout);
    function layout() {
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
  grid.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest('a') : null;
    if (!(link instanceof HTMLAnchorElement) || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    previousFocus = link;
    history.pushState(null, '', link.href);
    openDetail(link.pathname.slice('/posts/'.length));
  });
  const match = location.pathname.match(/^\/posts\/([^/]+)$/);
  if (match) openDetail(match[1]);
  else loadGallery();
}
