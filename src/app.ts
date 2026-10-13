type Tag = string;
type Post = {name: string; url: string; width: number; height: number; tags: Tag[]};

export function layoutRows(ratios: number[], width: number, targetHeight: number) {
  const positions: {x: number; y: number; width: number; height: number}[] = [];
  const gap = 2;
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
  const galleryBlocked = () => document.querySelector('dialog[open]') || document.getElementById('detail')?.hidden === false;
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
    if (galleryBlocked()) return;
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    if (gestureSize !== null) return;
    const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
    setSize(preferredHeight * Math.exp(-event.deltaY * units / 500), anchorAt(event.clientX, event.clientY));
  }, {passive: false});
  window.addEventListener('gesturestart', event => {
    if (galleryBlocked()) return;
    event.preventDefault();
    gestureSize = preferredHeight;
  }, {passive: false});
  window.addEventListener('gesturechange', event => {
    if (galleryBlocked()) return;
    event.preventDefault();
    if (gestureSize !== null) setSize(gestureSize * (event as Event & {scale: number}).scale, null);
  }, {passive: false});
  window.addEventListener('gestureend', event => { if (!galleryBlocked()) event.preventDefault(); gestureSize = null; pinch = null; }, {passive: false});
  const distance = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
  window.addEventListener('touchstart', event => {
    if (galleryBlocked()) return;
    if (event.touches.length === 2) pinch = {distance: distance(event.touches), size: preferredHeight};
  }, {passive: true});
  window.addEventListener('touchmove', event => {
    if (galleryBlocked()) return;
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
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const tagToolbar = element<HTMLElement>('tag-toolbar');
  const tagOptions = element<HTMLDivElement>('tag-options');
  const clearFilters = element<HTMLButtonElement>('clear-filters');
  const tileTagsSheet = element<HTMLDialogElement>('tile-tags-sheet');
  const tileTagsOptions = element<HTMLDivElement>('tile-tags-options');
  const tileTagsTitle = element<HTMLHeadingElement>('tile-tags-title');
  const tagsOpen = element<HTMLButtonElement>('tags-open');
  const tagsSheet = element<HTMLDialogElement>('tags-sheet');
  const chips = element<HTMLDivElement>('tag-chips');
  const suggestions = element<HTMLDivElement>('tag-suggestions');
  const nameInput = element<HTMLInputElement>('tag-name');
  const tokenInput = element<HTMLInputElement>('tag-token');
  const tagError = element<HTMLParagraphElement>('tag-error');
  const saveButton = element<HTMLButtonElement>('tag-save');
  const tagsTitle = element<HTMLHeadingElement>('tags-title');

  let galleryLoaded = false;
  let openedFromGallery = false;
  let savedScroll = 0;
  let previousFocus: HTMLElement | null = null;
  let sheetFocus: HTMLElement | null = null;
  let currentName = '';
  let currentTags: Tag[] = [];
  let draft: Tag[] = [];
  let token = '';
  let saving = false;
  let posts: Post[] = [];
  let suggestionPool: Tag[] = [];
  const selected = new Map<string, Tag>();
  const entries: {post: Post; tile: HTMLDivElement; link: HTMLAnchorElement; ratio: number; dots: HTMLDivElement; dotLimit: number; renderedTags?: Tag[]; renderedFilter?: string}[] = [];
  let preferredHeight = () => 220;
  const key = (tag: Tag) => tag.toLowerCase();
  const uniqueTags = (tags: Tag[]) => Array.from(new Map(tags.map(tag => [key(tag), tag])).values()).sort((a, b) => a.localeCompare(b));
  const tagColor = (tag: Tag) => {
    let hash = 2166136261;
    for (const char of key(tag)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return `hsl(${(hash >>> 0) % 360} 66% 42%)`;
  };

  function option(tag: Tag, active: boolean, action: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `tag-option ${active ? 'chosen' : ''}`;
    button.setAttribute('aria-pressed', String(active));
    button.title = tag;
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.setProperty('--tag-color', tagColor(tag));
    const label = document.createElement('span');
    label.textContent = tag;
    button.append(dot, label);
    button.addEventListener('click', action);
    return button;
  }

  function renderDots(entry: typeof entries[number], width: number) {
    const limit = width < 92 ? 1 : width < 140 ? 3 : 5;
    const filter = [...selected.keys()].join('\0');
    if (entry.dotLimit === limit && entry.renderedTags === entry.post.tags && entry.renderedFilter === filter) return;
    entry.dotLimit = limit;
    entry.renderedTags = entry.post.tags;
    entry.renderedFilter = filter;
    entry.dots.replaceChildren();
    const shown = entry.post.tags.slice(0, limit);
    for (const tag of shown) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tag-dot-button';
      button.title = `Filter by ${tag}`;
      button.setAttribute('aria-label', `Filter by tag ${tag}`);
      button.setAttribute('aria-pressed', String(selected.has(key(tag))));
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.setProperty('--tag-color', tagColor(tag));
      button.append(dot);
      button.addEventListener('click', () => toggleFilter(tag));
      entry.dots.append(button);
    }
    if (entry.post.tags.length > limit) {
      const hiddenTags = entry.post.tags.slice(limit);
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'tag-more';
      more.textContent = `+${entry.post.tags.length - limit}`;
      more.setAttribute('aria-label', `Show ${hiddenTags.length} more tags`);
      more.addEventListener('click', () => {
        sheetFocus = more;
        tileTagsOptions.replaceChildren(...hiddenTags.map(tag => option(tag, selected.has(key(tag)), () => { toggleFilter(tag); tileTagsSheet.close(); })));
        tileTagsSheet.showModal();
        tileTagsTitle.focus({preventScroll: true});
      });
      entry.dots.append(more);
    }
    entry.link.setAttribute('aria-label', `${entry.post.name}${entry.post.tags.length ? ', tags: ' + entry.post.tags.join(', ') : ''}`);
  }

  function layout() {
    const width = grid.clientWidth;
    if (!width) return;
    const selectedKeys = [...selected.keys()];
    const visible = entries.filter(({post}) => selectedKeys.every(id => post.tags.some(tag => key(tag) === id)));
    const {positions, height} = layoutRows(visible.map(entry => entry.ratio), width, preferredHeight());
    const visibleSet = new Set(visible);
    for (const entry of entries) entry.tile.hidden = !visibleSet.has(entry);
    visible.forEach((entry, index) => {
      const rect = positions[index];
      Object.assign(entry.tile.style, {left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px`});
      renderDots(entry, rect.width);
    });
    grid.style.height = `${height}px`;
    status.textContent = selected.size && visible.length === 0 ? 'No images match these filters' : entries.length ? '' : 'No images yet';
  }
  let scheduled = false;
  function scheduleLayout() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; layout(); });
  }

  function renderTagBar(focus?: string) {
    tagOptions.replaceChildren();
    const all = uniqueTags(posts.flatMap(post => post.tags));
    const tags = [...selected.values(), ...all.filter(tag => !selected.has(key(tag)))];
    let focused: HTMLButtonElement | undefined;
    for (const tag of tags) {
      const id = key(tag);
      const button = option(tag, selected.has(id), () => toggleFilter(tag));
      button.classList.add('tag-filter');
      tagOptions.append(button);
      if (id === focus) focused = button;
    }
    clearFilters.hidden = selected.size === 0;
    tagOptions.scrollLeft = 0;
    focused?.focus({preventScroll: true});
  }
  function toggleFilter(tag: Tag) {
    const id = key(tag);
    if (selected.has(id)) selected.delete(id);
    else selected.set(id, tag);
    renderTagBar(id);
    layout();
  }
  clearFilters.addEventListener('click', () => {
    selected.clear();
    renderTagBar();
    layout();
    tagOptions.querySelector<HTMLButtonElement>('button')?.focus({preventScroll: true});
  });
  element<HTMLButtonElement>('tile-tags-done').addEventListener('click', () => tileTagsSheet.close());
  tileTagsSheet.addEventListener('close', () => {
    if (sheetFocus && !sheetFocus.closest('.gallery-tile[hidden]')) sheetFocus.focus({preventScroll: true});
    else tagOptions.querySelector<HTMLButtonElement>('button')?.focus({preventScroll: true});
  });

  function validateDraft(tag: Tag): string {
    if (!tag || tag.trim() !== tag || Array.from(tag).length > 80 || /[\p{Cc}\p{Cf}]/u.test(tag)) return 'Name must be 1–80 characters without outer spaces';
    if (draft.length >= 5) return 'Maximum 5 tags per image';
    if (draft.some(current => key(current) === key(tag))) return 'This tag is already added';
    return '';
  }
  function renderSuggestions() {
    suggestions.replaceChildren();
    const query = nameInput.value.trim().toLowerCase();
    for (const tag of uniqueTags(suggestionPool).filter(tag => !draft.some(current => key(tag) === key(current)) && (!query || tag.toLowerCase().includes(query))).slice(0, 24)) {
      suggestions.append(option(tag, false, () => addTag(tag)));
    }
  }
  function renderChips() {
    chips.replaceChildren();
    for (const tag of draft) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      const label = document.createElement('span');
      label.textContent = tag;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${tag}`);
      remove.addEventListener('click', () => { draft = draft.filter(current => current !== tag); renderChips(); renderSuggestions(); });
      chip.append(label, remove);
      chips.append(chip);
    }
    if (!draft.length) chips.textContent = 'No tags';
  }
  function addTag(tag: Tag) {
    if (saveButton.disabled) return;
    tagError.textContent = validateDraft(tag);
    if (tagError.textContent) return;
    draft.push(tag);
    nameInput.value = '';
    renderChips();
    renderSuggestions();
    nameInput.focus();
  }
  element<HTMLButtonElement>('tag-add').addEventListener('click', () => addTag(nameInput.value));
  nameInput.addEventListener('input', renderSuggestions);
  nameInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); addTag(nameInput.value); }
  });
  element<HTMLButtonElement>('tag-cancel').addEventListener('click', () => tagsSheet.close());
  tagsSheet.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  tagsSheet.addEventListener('close', () => { tokenInput.value = ''; sheetFocus?.focus({preventScroll: true}); });
  tagsOpen.addEventListener('click', () => {
    sheetFocus = tagsOpen;
    draft = currentTags.slice();
    saveButton.disabled = !galleryLoaded;
    tagError.classList.toggle('loading', !galleryLoaded);
    tagError.textContent = galleryLoaded ? '' : 'Loading existing tags…';
    nameInput.value = '';
    suggestionPool = posts.flatMap(post => post.tags);
    renderChips();
    renderSuggestions();
    tagsSheet.showModal();
    tagsSheet.scrollTop = 0;
    tagsTitle.focus({preventScroll: true});
    if (!galleryLoaded) fetchPosts().then(items => {
      if (tagsSheet.open) {
        suggestionPool = items.flatMap(post => post.tags);
        renderSuggestions();
        tagError.classList.remove('loading');
        tagError.textContent = '';
        saveButton.disabled = false;
      }
    }).catch(error => {
      if (tagsSheet.open) {
        tagError.classList.remove('loading');
        tagError.textContent = `Could not load existing tags: ${error instanceof Error ? error.message : String(error)}`;
      }
    });
  });
  saveButton.addEventListener('click', async () => {
    if (saving) return;
    const provided = tokenInput.value || token;
    if (!provided) { tagError.textContent = 'Enter the development token'; tokenInput.focus(); return; }
    saving = true;
    tagError.textContent = '';
    tagsSheet.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input, button, select').forEach(control => { control.disabled = true; });
    try {
      const response = await fetch(`/api/posts/${encodeURIComponent(currentName)}/tags`, {
        method: 'PUT', headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${provided}`}, body: JSON.stringify({tags: draft}),
      });
      if (!response.ok) {
        if (response.status === 401) token = '';
        throw new Error(response.status === 401 ? 'Invalid token; enter it again' : `Could not save tags (${response.status})`);
      }
      const result = await response.json() as {tags: Tag[]};
      token = provided;
      currentTags = result.tags;
      const post = posts.find(post => post.name === currentName);
      if (post) post.tags = result.tags;
      renderTagBar();
      if (galleryLoaded) layout();
      tagsSheet.close();
    } catch (error) {
      tagError.textContent = error instanceof Error ? error.message : 'Could not save tags';
    } finally {
      saving = false;
      tagsSheet.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input, button, select').forEach(control => { control.disabled = false; });
    }
  });

  async function fetchPosts(): Promise<Post[]> {
    const response = await fetch('/api/posts');
    if (!response.ok) throw new Error(`Failed to load images (${response.status})`);
    const data = await response.json() as {items: Post[]};
    return data.items;
  }

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
    currentName = decodeURIComponent(name);
    grid.inert = true;
    tagToolbar.inert = true;
    detail.hidden = false;
    document.documentElement.style.overflow = 'hidden';
    scale = 1;
    panX = panY = 0;
    renderImage();
    detailStatus.textContent = '';
    full.alt = currentName;
    showImage(full, `/images/${name}`, () => { detailStatus.textContent = 'This image cannot be displayed'; });
    tagsOpen.disabled = true;
    fetch(`/api/posts/${encodeURIComponent(currentName)}/tags`).then(response => {
      if (!response.ok) throw new Error(`Failed to load tags (${response.status})`);
      return response.json() as Promise<{tags: Tag[]}>;
    }).then(({tags}) => {
      if (currentName !== decodeURIComponent(name) || detail.hidden) return;
      currentTags = tags;
      const post = posts.find(post => post.name === currentName);
      if (post) { post.tags = tags; renderTagBar(); layout(); }
      tagsOpen.disabled = false;
    }).catch(error => { detailStatus.textContent = error instanceof Error ? error.message : 'Failed to load tags'; });
    back.focus({preventScroll: true});
  }
  function closeDetail() {
    if (detail.hidden) return;
    detail.hidden = true;
    grid.inert = false;
    tagToolbar.inert = false;
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
    if (event.key === 'Escape' && !detail.hidden && !tagsSheet.open && !tileTagsSheet.open) back.click();
  });
  detail.addEventListener('wheel', event => {
    event.preventDefault();
    event.stopPropagation();
    if (event.target !== full) return;
    const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? detail.clientHeight : 1;
    zoom(scale * Math.exp(-event.deltaY * units / 500), event.clientX, event.clientY);
  }, {passive: false});
  detail.addEventListener('dblclick', event => {
    if (event.target !== full) return;
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
    if (event.target !== full) return;
    event.stopPropagation();
    if (event.touches.length === 2) pinch = {distance: distance(event.touches), scale, ...center(event.touches), panX, panY};
    else if (event.touches.length === 1) touch = {x: event.touches[0].clientX, y: event.touches[0].clientY};
  });
  detail.addEventListener('touchmove', event => {
    if (!pinch && !touch) return;
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
  detail.addEventListener('gesturestart', event => { if (event.target !== full) return; event.preventDefault(); event.stopPropagation(); gestureScale = scale; }, {passive: false});
  detail.addEventListener('gesturechange', event => {
    if (event.target !== full) return;
    event.preventDefault();
    event.stopPropagation();
    zoom(gestureScale * (event as Event & {scale: number}).scale, detail.clientWidth / 2, detail.clientHeight / 2);
  }, {passive: false});
  detail.addEventListener('gestureend', event => { if (event.target === full) { event.preventDefault(); event.stopPropagation(); } }, {passive: false});

  function loadGallery() {
    if (galleryLoaded) return;
    galleryLoaded = true;
    preferredHeight = installZoom(layout);
    let measuredWidth = grid.clientWidth;
    new ResizeObserver(() => {
      if (grid.clientWidth !== measuredWidth) {
        measuredWidth = grid.clientWidth;
        layout();
      }
    }).observe(grid);
    fetchPosts().then(items => {
      posts = items;
      for (const post of posts) {
        const tile = document.createElement('div');
        const link = document.createElement('a');
        const img = document.createElement('img');
        const dots = document.createElement('div');
        dots.className = 'tag-dots';
        tile.className = 'gallery-tile';
        link.className = 'gallery-link';
        link.href = `/posts/${encodeURIComponent(post.name)}`;
        img.alt = post.name;
        img.loading = 'lazy';
        const entry = {post, tile, link, ratio: imageRatio(post, img), dots, dotLimit: 0};
        img.addEventListener('load', () => {
          entry.ratio = imageRatio(post, img);
          scheduleLayout();
        });
        link.append(img);
        tile.append(link, dots);
        grid.append(tile);
        entries.push(entry);
        showImage(img, post.url, () => { status.textContent = 'Some images cannot be displayed'; });
      }
      layout();
      renderTagBar();
    }).catch(error => { status.textContent = error instanceof Error ? error.message : String(error); });
  }
  grid.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest('a') : null;
    if (event.target instanceof Element && event.target.closest('button')) return;
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
