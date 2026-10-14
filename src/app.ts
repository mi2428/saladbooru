type Tag = string;
type Post = {name: string; url: string; width: number; height: number; tags: Tag[]};
const TWITTER_IMAGE_ORIGIN = new URL('https://pbs.twimg.com');
const key = (tag: Tag) => tag.toLowerCase();
const TAG_COLORS = [
  '#f05a49', '#f58a39', '#92b934', '#31b96b', '#19b9ac', '#4b86f4', '#a568e5', '#e95c9e',
  '#ec665f', '#ed9941', '#b5bb38', '#64bf42', '#34bb82', '#30b8cb', '#4874dc', '#846fe4',
  '#cf639e', '#df6b7a', '#de7f3c', '#c1a446', '#8dbb4d', '#43b3a4', '#538ecf', '#aa70d9',
  '#e978ad', '#e0664c', '#daa542', '#a0bd57', '#62bd82', '#4aabc9', '#657ede', '#c968ca',
];

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

export function tagColor(tag: Tag): string {
  let hash = 2166136261;
  for (const char of key(tag)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return TAG_COLORS[(hash >>> 0) % TAG_COLORS.length];
}

export function tagsByUse(posts: Pick<Post, 'tags'>[]): Tag[] {
  const counts = new Map<string, {tag: Tag; count: number}>();
  for (const post of posts) {
    const seen = new Set<string>();
    for (const tag of post.tags) {
      const id = key(tag);
      if (seen.has(id)) continue;
      seen.add(id);
      const entry = counts.get(id);
      if (entry) entry.count++;
      else counts.set(id, {tag, count: 1});
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)).map(entry => entry.tag);
}

export function adjacentName(posts: Pick<Post, 'name' | 'tags'>[], name: string, step: -1 | 1, filters: string[]): string | undefined {
  const visible = posts.filter(post => filters.every(id => post.tags.some(tag => key(tag) === id)));
  const index = visible.findIndex(post => post.name === name);
  return index < 0 ? undefined : visible[index + step]?.name;
}

export function shouldSubmitTagOnEnter(event: Pick<KeyboardEvent, 'key' | 'isComposing' | 'keyCode'>): boolean {
  return event.key === 'Enter' && !event.isComposing && event.keyCode !== 229;
}

export function clickedOutsideDialog(event: Pick<MouseEvent, 'target' | 'clientX' | 'clientY'>, dialog: HTMLDialogElement): boolean {
  if (event.target !== dialog) return false;
  const {left, right, top, bottom} = dialog.getBoundingClientRect();
  return event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom;
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

export async function uploadFiles(files: readonly File[], onProgress: (file: File, index: number) => void): Promise<File[]> {
  const failed: File[] = [];
  for (const [index, file] of files.entries()) {
    onProgress(file, index);
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      const response = await fetch('/api/posts', {method: 'POST', body: form});
      if (!response.ok) throw new Error(`Upload failed (${response.status})`);
    } catch {
      failed.push(file);
    }
  }
  return failed;
}

export function droppedImageURL(data: Pick<DataTransfer, 'getData'>): string | null {
  const html = data.getData('text/html');
  const fragment = html ? new DOMParser().parseFromString(html, 'text/html') : null;
  const image = fragment?.querySelector('img')?.getAttribute('src');
  if (image) return image;
  const uri = data.getData('text/uri-list').split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith('#'));
  if (uri) return uri;
  const download = data.getData('DownloadURL').match(/^[^:]+:[^:]*:(https:\/\/.+)$/i)?.[1];
  if (download) return download;
  const mozilla = data.getData('application/x-moz-file-promise-url').trim();
  if (mozilla) return mozilla;
  return fragment?.querySelector('a[href]')?.getAttribute('href') || data.getData('text/plain').trim() || null;
}

export async function fetchDroppedImage(value: string): Promise<File> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Dropped URL is invalid');
  }
  if (url.origin !== TWITTER_IMAGE_ORIGIN.origin || url.username || url.password) {
    throw new Error(`Only HTTPS images from ${TWITTER_IMAGE_ORIGIN.hostname} are supported`);
  }
  const response = await fetch(url, {mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error'});
  if (!response.ok) throw new Error(`Image download failed (${response.status})`);
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
  if (!type.startsWith('image/')) throw new Error('Dropped URL did not return an image');
  return new File([await response.blob()], 'dropped-image', {type});
}

if (typeof document !== 'undefined') {
  const gridElement = document.getElementById('grid');
  const detailElement = document.getElementById('detail');
  const statusElement = document.getElementById('status');
  const detailStatusElement = document.getElementById('detail-status');
  const dropOverlayElement = document.getElementById('drop-overlay');
  const fullElement = document.getElementById('full');
  const backElement = document.getElementById('back');
  const refreshElement = document.getElementById('refresh');
  if (!gridElement || !detailElement || !statusElement || !detailStatusElement || !(dropOverlayElement instanceof HTMLDivElement) || !(fullElement instanceof HTMLImageElement) || !(backElement instanceof HTMLAnchorElement) || !(refreshElement instanceof HTMLButtonElement)) {
    throw new Error('Missing gallery elements');
  }
  const grid = gridElement, detail = detailElement, status = statusElement, detailStatus = detailStatusElement, full = fullElement, back = backElement;
  refreshElement.addEventListener('click', () => location.reload());
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const dropOverlay = dropOverlayElement;
  const tagToolbar = element<HTMLElement>('tag-toolbar');
  const tagOptions = element<HTMLDivElement>('tag-options');
  const clearFilters = element<HTMLButtonElement>('clear-filters');
  const tagsOpen = element<HTMLButtonElement>('tags-open');
  const deleteButton = element<HTMLButtonElement>('delete-post');
  const tagsSheet = element<HTMLDialogElement>('tags-sheet');
  const chips = element<HTMLDivElement>('tag-chips');
  const suggestions = element<HTMLDivElement>('tag-suggestions');
  const nameInput = element<HTMLInputElement>('tag-name');
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
  let tagsReady = false;
  let deleting = false;
  let draft: Tag[] = [];
  let saving = false;
  let posts: Post[] = [];
  let suggestionPool: Post[] = [];
  const selected = new Map<string, Tag>();
  const entries: {post: Post; tile: HTMLDivElement; link: HTMLAnchorElement; ratio: number; dots: HTMLDivElement; dotLimit: number; renderedTags?: Tag[]; renderedFilter?: string}[] = [];
  const pendingUploads: File[] = [];
  let uploading = false;
  let preferredHeight = () => 220;
  function createEntry(post: Post): typeof entries[number] {
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
    showImage(img, post.url, () => { status.textContent = 'Some images cannot be displayed'; });
    return entry;
  }
  function option(tag: Tag, active: boolean, action: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `tag-option ${active ? 'chosen' : ''}`;
    button.setAttribute('aria-pressed', String(active));
    button.title = tag;
    button.style.setProperty('--tag-color', tagColor(tag));
    button.textContent = tag;
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
    const tags = tagsByUse(posts);
    for (const tag of selected.values()) if (!tags.some(other => key(other) === key(tag))) tags.push(tag);
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
    focused?.scrollIntoView({block: 'nearest', inline: 'nearest'});
  }
  function syncGallery(items: Post[]) {
    const existing = new Map(entries.map(entry => [entry.post.name, entry] as const));
    const updated = items.map(post => {
      const entry = existing.get(post.name);
      if (entry) {
        existing.delete(post.name);
        entry.post = post;
        return entry;
      }
      const added = createEntry(post);
      grid.append(added.tile);
      return added;
    });
    for (const entry of existing.values()) entry.tile.remove();
    entries.splice(0, entries.length, ...updated);
    posts = items;
    const scrollLeft = tagOptions.scrollLeft;
    renderTagBar();
    tagOptions.scrollLeft = scrollLeft;
    layout();
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
  function validateDraft(tag: Tag): string {
    if (!tag || tag.trim() !== tag || Array.from(tag).length > 80 || /[\p{Cc}\p{Cf}]/u.test(tag)) return 'Name must be 1–80 characters without outer spaces';
    if (draft.length >= 10) return 'Maximum 10 tags per image';
    if (draft.some(current => key(current) === key(tag))) return 'This tag is already added';
    return '';
  }
  function renderSuggestions() {
    suggestions.replaceChildren();
    if (draft.length >= 10) { suggestions.hidden = true; return; }
    const query = nameInput.value.trim().toLowerCase();
    const matches = tagsByUse(suggestionPool).filter(tag => !draft.some(current => key(tag) === key(current)) && (!query || key(tag).includes(query))).slice(0, query ? 8 : 6);
    suggestions.hidden = matches.length === 0;
    for (const tag of matches) {
      suggestions.append(option(tag, false, () => addTag(tag)));
    }
  }
  function renderChips() {
    chips.replaceChildren();
    for (const tag of draft) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.style.setProperty('--tag-color', tagColor(tag));
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
  nameInput.addEventListener('input', renderSuggestions);
  nameInput.addEventListener('keydown', event => {
    if (!shouldSubmitTagOnEnter(event)) return;
    event.preventDefault();
    addTag(nameInput.value);
  });
  tagsSheet.addEventListener('click', event => {
    if (!saving && clickedOutsideDialog(event, tagsSheet)) tagsSheet.close();
  });
  tagsSheet.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  tagsSheet.addEventListener('close', () => sheetFocus?.focus({preventScroll: true}));
  tagsOpen.addEventListener('click', () => {
    sheetFocus = tagsOpen;
    draft = currentTags.slice();
    saveButton.disabled = !galleryLoaded;
    tagError.classList.toggle('loading', !galleryLoaded);
    tagError.textContent = galleryLoaded ? '' : 'Loading existing tags…';
    nameInput.value = '';
    suggestionPool = posts;
    renderChips();
    renderSuggestions();
    tagsSheet.showModal();
    tagsSheet.scrollTop = 0;
    tagsTitle.focus({preventScroll: true});
    if (!galleryLoaded) fetchPosts().then(items => {
      if (tagsSheet.open) {
        suggestionPool = items;
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
    if (nameInput.value) {
      addTag(nameInput.value);
      if (tagError.textContent) return;
    }
    saving = true;
    tagError.textContent = '';
    tagsSheet.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach(control => { control.disabled = true; });
    try {
      const response = await fetch(`/api/posts/${encodeURIComponent(currentName)}/tags`, {
        method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({tags: draft}),
      });
      if (!response.ok) throw new Error(`Could not save tags (${response.status})`);
      const result = await response.json() as {tags: Tag[]};
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
      tagsSheet.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach(control => { control.disabled = false; });
    }
  });
  deleteButton.addEventListener('click', async () => {
    if (deleting || detail.hidden || tagsSheet.open || !window.confirm('Delete this image permanently?')) return;
    const name = currentName;
    deleting = true;
    deleteButton.disabled = true;
    tagsOpen.disabled = true;
    detailStatus.textContent = 'Deleting image…';
    try {
      const response = await fetch(`/api/posts/${encodeURIComponent(name)}`, {method: 'DELETE'});
      if (!response.ok) throw new Error(`Could not delete image (${response.status})`);
      if (galleryLoaded) {
        syncGallery(posts.filter(post => post.name !== name));
        previousFocus = grid.querySelector<HTMLAnchorElement>('.gallery-tile:not([hidden]) .gallery-link') ?? refreshElement;
      }
      if (!detail.hidden && currentName === name) back.click();
    } catch (error) {
      if (!detail.hidden && currentName === name) detailStatus.textContent = error instanceof Error ? error.message : 'Could not delete image';
    } finally {
      deleting = false;
      if (!detail.hidden) {
        deleteButton.disabled = false;
        tagsOpen.disabled = !tagsReady;
      }
    }
  });

  async function fetchPosts(): Promise<Post[]> {
    const response = await fetch('/api/posts');
    if (!response.ok) throw new Error(`Failed to load images (${response.status})`);
    const data = await response.json() as {items: Post[]};
    return data.items;
  }

  async function processUploads() {
    if (uploading) return;
    uploading = true;
    let uploaded = 0;
    const failed: File[] = [];
    try {
      while (pendingUploads.length) {
        const batch = pendingUploads.splice(0);
        const batchFailed = await uploadFiles(batch, (file, index) => {
          status.textContent = `Uploading ${index + 1} of ${batch.length}: ${file.name}`;
        });
        uploaded += batch.length - batchFailed.length;
        failed.push(...batchFailed);
      }
      if (uploaded) {
        try {
          syncGallery(await fetchPosts());
        } catch {
          status.textContent = `Uploaded ${uploaded} ${uploaded === 1 ? 'image' : 'images'}, but could not refresh the gallery.`;
          return;
        }
      }
      if (failed.length) {
        const names = failed.slice(0, 3).map(file => file.name).join(', ');
        const more = failed.length > 3 ? `, and ${failed.length - 3} more` : '';
        status.textContent = `Uploaded ${uploaded} ${uploaded === 1 ? 'image' : 'images'}; ${failed.length} failed: ${names}${more}.`;
      } else {
        status.textContent = `Uploaded ${uploaded} ${uploaded === 1 ? 'image' : 'images'}.`;
      }
    } finally {
      uploading = false;
      if (pendingUploads.length) void processUploads();
    }
  }
  function queueUploads(files: File[]) {
    pendingUploads.push(...files);
    void processUploads();
  }
  async function queueDroppedImage(value: string) {
    status.textContent = 'Fetching dropped image…';
    try {
      queueUploads([await fetchDroppedImage(value)]);
    } catch (error) {
      status.textContent = error instanceof TypeError
        ? 'Could not fetch image. The source may block cross-origin access.'
        : error instanceof Error ? error.message : 'Could not fetch dropped image';
    }
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
    const openedName = decodeURIComponent(name);
    currentName = openedName;
    grid.inert = true;
    tagToolbar.inert = true;
    detail.hidden = false;
    document.documentElement.style.overflow = 'hidden';
    scale = 1;
    panX = panY = 0;
    renderImage();
    detailStatus.textContent = '';
    full.alt = currentName;
    showImage(full, `/images/${name}`, () => {
      if (currentName === openedName && !detail.hidden) detailStatus.textContent = 'This image cannot be displayed';
    });
    tagsReady = false;
    tagsOpen.disabled = true;
    deleteButton.disabled = deleting;
    fetch(`/api/posts/${encodeURIComponent(currentName)}/tags`).then(response => {
      if (!response.ok) throw new Error(`Failed to load tags (${response.status})`);
      return response.json() as Promise<{tags: Tag[]}>;
    }).then(({tags}) => {
      if (currentName !== openedName || detail.hidden) return;
      currentTags = tags;
      const post = posts.find(post => post.name === currentName);
      if (post) { post.tags = tags; renderTagBar(); layout(); }
      tagsReady = true;
      tagsOpen.disabled = deleting;
    }).catch(error => {
      if (currentName === openedName && !detail.hidden) detailStatus.textContent = error instanceof Error ? error.message : 'Failed to load tags';
    });
    back.focus({preventScroll: true});
  }
  async function moveDetail(step: -1 | 1) {
    try {
      if (!posts.length) posts = await fetchPosts();
      if (detail.hidden || tagsSheet.open || deleting) return;
      const name = adjacentName(posts, currentName, step, [...selected.keys()]);
      if (!name) return;
      const path = `/posts/${encodeURIComponent(name)}`;
      history.replaceState(null, '', path);
      openDetail(path.slice('/posts/'.length));
    } catch (error) {
      if (!detail.hidden) detailStatus.textContent = error instanceof Error ? error.message : 'Failed to load images';
    }
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
    if (event.key === 'Escape' && !detail.hidden && !tagsSheet.open) back.click();
    if (detail.hidden || tagsSheet.open || deleting || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    void moveDetail(event.key === 'ArrowLeft' ? -1 : 1);
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
    fetchPosts().then(syncGallery).catch(error => { status.textContent = error instanceof Error ? error.message : String(error); });
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
  const acceptsFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
  const acceptsURL = (event: DragEvent) => {
    const types = event.dataTransfer?.types;
    return !!types && ['text/uri-list', 'text/html', 'text/plain', 'DownloadURL', 'application/x-moz-file-promise-url'].some(type => types.includes(type));
  };
  const acceptsDrop = (event: DragEvent) => acceptsFiles(event) || acceptsURL(event);
  const galleryAcceptsDrops = () => location.pathname === '/' && detail.hidden && !tagsSheet.open;
  let dragDepth = 0;
  const clearDropOverlay = () => { dragDepth = 0; dropOverlay.hidden = true; };
  document.addEventListener('dragenter', event => {
    if (!galleryAcceptsDrops() || !acceptsDrop(event)) return;
    event.preventDefault();
    dragDepth++;
    dropOverlay.hidden = false;
  });
  document.addEventListener('dragover', event => {
    if (!galleryAcceptsDrops()) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', event => {
    if (!galleryAcceptsDrops() || !acceptsDrop(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropOverlay.hidden = true;
  });
  document.addEventListener('drop', event => {
    if (!galleryAcceptsDrops()) return;
    event.preventDefault();
    clearDropOverlay();
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length) {
      queueUploads(files);
    } else if (event.dataTransfer) {
      const url = droppedImageURL(event.dataTransfer);
      if (url) void queueDroppedImage(url);
      else status.textContent = 'Drop an image file or a supported Twitter image URL.';
    }
  });
  window.addEventListener('blur', clearDropOverlay);
  const match = location.pathname.match(/^\/posts\/([^/]+)$/);
  if (match) openDetail(match[1]);
  else loadGallery();
}
