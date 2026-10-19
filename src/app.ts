type Tag = string;
type Post = {name: string; url: string; format: string; width: number; height: number; tags: Tag[]};
type TileRect = {x: number; y: number; width: number; height: number};
type ViewAnchor = {element: Element; fraction: number; y: number};
type GalleryEntry = {
  post: Post;
  tile?: HTMLDivElement;
  link?: HTMLAnchorElement;
  ratio: number;
  dots?: HTMLDivElement;
  rect?: TileRect;
  applied?: TileRect;
  dotLimit: number;
  renderedTags?: Tag[];
  renderedFilter?: string;
};
const TWITTER_IMAGE_ORIGIN = new URL('https://pbs.twimg.com');
const PULL_THRESHOLD = 80;
const PULL_LOCK_DISTANCE = 10;
const NSFW_TAG = 'NSFW';
const UNTAGGED_TAG = 'Untagged';
const key = (tag: Tag) => tag.toLowerCase();
const UNTAGGED_KEY = key(UNTAGGED_TAG);
const TAG_COLORS = [
  '#f05a49', '#f58a39', '#92b934', '#31b96b', '#19b9ac', '#4b86f4', '#a568e5', '#e95c9e',
  '#ec665f', '#ed9941', '#b5bb38', '#64bf42', '#34bb82', '#30b8cb', '#4874dc', '#846fe4',
  '#cf639e', '#df6b7a', '#de7f3c', '#c1a446', '#8dbb4d', '#43b3a4', '#538ecf', '#aa70d9',
  '#e978ad', '#e0664c', '#daa542', '#a0bd57', '#62bd82', '#4aabc9', '#657ede', '#c968ca',
];

export function layoutRows(ratios: number[], width: number, targetHeight: number) {
  const positions: TileRect[] = [];
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

export function windowRange(positions: readonly TileRect[], top: number, bottom: number): [number, number] {
  let low = 0, high = positions.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (positions[middle].y + positions[middle].height < top) low = middle + 1;
    else high = middle;
  }
  const start = low;
  while (low < positions.length && positions[low].y <= bottom) low++;
  return [start, low];
}

export function installZoom(relayout: (anchor?: ViewAnchor) => void): () => number {
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
  const setSize = (value: number, anchor: ViewAnchor | null) => {
    const size = Math.max(100, Math.min(500, value));
    if (!Number.isFinite(size) || size === preferredHeight) return;
    preferredHeight = size;
    relayout(anchor ?? undefined);
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

export function isNSFW(post: Pick<Post, 'tags'>): boolean {
  return post.tags.some(tag => key(tag) === key(NSFW_TAG));
}

export function allowedPosts<T extends Pick<Post, 'tags'>>(posts: readonly T[], showNSFW: boolean): T[] {
  return posts.filter(post => showNSFW || !isNSFW(post));
}

export function tagSuggestions(posts: Pick<Post, 'tags'>[], draft: readonly Tag[], query: string, includeDefault = true): Tag[] {
  const tags = tagsByUse(posts).filter(tag => key(tag) !== UNTAGGED_KEY);
  const candidates = includeDefault ? [NSFW_TAG, ...tags.filter(tag => key(tag) !== key(NSFW_TAG))] : tags;
  const existing = new Set(draft.map(key));
  const search = key(query.trim());
  return candidates.filter(tag => !existing.has(key(tag)) && (!search || key(tag).includes(search))).slice(0, 30);
}

export function filterTags(posts: Pick<Post, 'tags'>[], selected: ReadonlyMap<string, Tag>): Tag[] {
  const tags = tagsByUse(posts).filter(tag => key(tag) !== UNTAGGED_KEY);
  for (const [id, tag] of selected) if (id !== UNTAGGED_KEY && !tags.some(other => key(other) === id)) tags.push(tag);
  tags.sort((a, b) => Number(selected.has(key(b))) - Number(selected.has(key(a))));
  return [...tags, UNTAGGED_TAG];
}

export function matchesFilters(post: Pick<Post, 'tags'>, filters: readonly string[]): boolean {
  return filters.every(id => id === UNTAGGED_KEY ? post.tags.length === 0 : post.tags.some(tag => key(tag) === id));
}

export function adjacentName(posts: Pick<Post, 'name' | 'tags'>[], name: string, step: -1 | 1, filters: string[]): string | undefined {
  const visible = posts.filter(post => matchesFilters(post, filters));
  const index = visible.findIndex(post => post.name === name);
  return index < 0 ? undefined : visible[index + step]?.name;
}

export function selectionRange(names: readonly string[], anchor: string, target: string): [number, number] | null {
  const start = names.indexOf(anchor), end = names.indexOf(target);
  return start < 0 || end < 0 ? null : [Math.min(start, end), Math.max(start, end)];
}

export function shouldRefreshPull(distance: number, atTop: boolean): boolean {
  return atTop && distance >= PULL_THRESHOLD;
}

export function pullIntent(deltaX: number, deltaY: number, pulling: boolean): 'pending' | 'pull' | 'cancel' {
  if (pulling) return deltaY > 0 ? 'pull' : 'cancel';
  if (Math.hypot(deltaX, deltaY) < PULL_LOCK_DISTANCE) return 'pending';
  return deltaY > Math.abs(deltaX) * 1.25 ? 'pull' : 'cancel';
}

export function pullOffset(distance: number): number {
  return Math.min(64, Math.max(0, distance) / 2);
}

export function detailTapStep(event: Pick<MouseEvent, 'target' | 'clientX' | 'button'>, detail: HTMLElement, image: HTMLElement): -1 | 1 | null {
  if (event.button !== 0 || (event.target !== detail && event.target !== image)) return null;
  const {left, width} = detail.getBoundingClientRect();
  return event.clientX < left + width / 2 ? -1 : 1;
}

export function shouldSubmitTagOnEnter(event: Pick<KeyboardEvent, 'key' | 'isComposing' | 'keyCode'>): boolean {
  return event.key === 'Enter' && !event.isComposing && event.keyCode !== 229;
}

export function shouldExitSelectionOnEscape(event: Pick<KeyboardEvent, 'key' | 'isComposing'>, selectionMode: boolean, detailHidden: boolean, dialogOpen: boolean): boolean {
  return event.key === 'Escape' && !event.isComposing && selectionMode && detailHidden && !dialogOpen;
}

export function clickedOutsideDialog(event: Pick<MouseEvent, 'target' | 'clientX' | 'clientY'>, dialog: HTMLDialogElement): boolean {
  if (event.target !== dialog) return false;
  const {left, right, top, bottom} = dialog.getBoundingClientRect();
  return event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom;
}

type ImageSource = {url: string; original?: string; format?: string};

export function showImage(img: HTMLImageElement, {url, original = url, format}: ImageSource, onError: () => void): void {
  const sources = url === original ? [url] : [url, original];
  const preview = original.replace(/^\/images\//, '/preview/');
  if (format === 'avif' || (!format && /\.avif(?:$|[?#])/i.test(original))) sources.push(preview);
  else {
    sources.push(`${original}${original.includes('?') ? '&' : '?'}retry=${Date.now()}`);
    if (!format) sources.push(preview); // Direct detail URLs have no format metadata.
  }
  let next = 0;
  img.onerror = () => {
    if (++next < sources.length) img.src = sources[next];
    else onError();
  };
  img.src = url;
}

export async function uploadFiles(files: readonly File[], tags: readonly Tag[] = []): Promise<File[]> {
  const failed: File[] = [];
  const uploadTags = tags.filter(tag => key(tag) !== UNTAGGED_KEY);
  for (const file of files) {
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      if (uploadTags.length) form.append('tags', JSON.stringify(uploadTags));
      const response = await fetch('/api/posts', {method: 'POST', body: form});
      if (!response.ok) throw new Error(`Upload failed (${response.status})`);
      console.info('Image upload succeeded', {name: file.name, type: file.type, size: file.size, tags: uploadTags});
    } catch (error) {
      console.error('Image upload failed', {name: file.name, type: file.type, size: file.size, tags: uploadTags}, error);
      failed.push(file);
    }
  }
  return failed;
}

export function clipboardImages(data: Pick<DataTransfer, 'files' | 'items'>): File[] {
  const files = Array.from(data.files).filter(file => file.type.startsWith('image/'));
  if (!files.length) {
    for (const item of Array.from(data.items ?? [])) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
  }
  return files.map(file => file.name ? file : new File([file], 'pasted-image', {type: file.type}));
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
  const pullRefreshElement = document.getElementById('pull-refresh');
  const mainElement = document.querySelector('main');
  if (!gridElement || !detailElement || !statusElement || !detailStatusElement || !(dropOverlayElement instanceof HTMLDivElement) || !(fullElement instanceof HTMLImageElement) || !(backElement instanceof HTMLAnchorElement) || !(pullRefreshElement instanceof HTMLDivElement) || !(mainElement instanceof HTMLElement)) {
    throw new Error('Missing gallery elements');
  }
  const grid = gridElement, detail = detailElement, status = statusElement, detailStatus = detailStatusElement, full = fullElement, back = backElement;
  const pullRefresh = pullRefreshElement, main = mainElement;
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const dropOverlay = dropOverlayElement;
  const tagToolbar = element<HTMLElement>('tag-toolbar');
  const galleryActions = element<HTMLDivElement>('gallery-actions');
  const selectModeButton = element<HTMLButtonElement>('select-mode');
  const nsfwToggle = element<HTMLButtonElement>('nsfw-toggle');
  const hiddenEye = nsfwToggle.querySelector<SVGSVGElement>('.eye-hidden')!;
  const visibleEye = nsfwToggle.querySelector<SVGSVGElement>('.eye-visible')!;
  const nsfwReveal = element<HTMLButtonElement>('nsfw-reveal');
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
  const tagLabel = tagsSheet.querySelector<HTMLLabelElement>('label[for="tag-name"]')!;
  const batchActions = element<HTMLDivElement>('batch-actions');
  const selectedCount = element<HTMLSpanElement>('selected-count');
  const batchAdd = element<HTMLButtonElement>('batch-add');
  const batchRemove = element<HTMLButtonElement>('batch-remove');
  const batchDelete = element<HTMLButtonElement>('batch-delete');
  const batchClear = element<HTMLButtonElement>('batch-clear');

  let galleryLoaded = false;
  let openedFromGallery = false;
  let savedScroll = 0;
  let previousFocus: HTMLElement | null = null;
  let sheetFocus: HTMLElement | null = null;
  let currentName = '';
  let detailTags: Tag[] = [];
  let tagsReady = false;
  let deleting = false;
  let batchDeleting = false;
  let batchFeedbackTimer = 0;
  let draftTags: Tag[] = [];
  let batchMode: 'add' | 'remove' | null = null;
  let batchNames: string[] = [];
  let saving = false;
  let posts: Post[] = [];
  let showNSFW = false;
  let suggestionPool: Post[] = [];
  const selectedTags = new Map<string, Tag>();
  const selectedImages = new Set<string>();
  const entries: GalleryEntry[] = [];
  const mounted = new Map<string, GalleryEntry>();
  let visibleEntries: GalleryEntry[] = [];
  let visibleRects: TileRect[] = [];
  const entryByTile = new WeakMap<HTMLDivElement, GalleryEntry>();
  let revealAnchor: {name: string; top: number; scroll: number} | null = null;
  let selectionMode = false;
  let rangeAnchor: string | null = null;
  const pendingUploads: {files: File[]; tags: Tag[]}[] = [];
  let uploading = false;
  let preferredHeight = () => 220;
  function createEntry(post: Post): GalleryEntry {
    return {post, ratio: post.width / post.height, dotLimit: 0};
  }
  function mountEntry(entry: GalleryEntry, before: Node | null): HTMLDivElement {
    const tile = document.createElement('div');
    const link = document.createElement('a');
    const img = document.createElement('img');
    const dots = document.createElement('div');
    dots.className = 'tag-dots';
    dots.inert = selectionMode;
    tile.className = 'gallery-tile';
    tile.setAttribute('role', 'listitem');
    link.className = 'gallery-link';
    link.href = `/posts/${encodeURIComponent(entry.post.name)}`;
    img.alt = entry.post.name;
    img.loading = 'lazy';
    entry.tile = tile;
    entry.link = link;
    entry.dots = dots;
    entryByTile.set(tile, entry);
    renderSelection(entry);
    img.addEventListener('load', () => {
      if (entry.tile !== tile) return;
      const ratio = imageRatio(entry.post, img);
      if (Math.abs(ratio - entry.ratio) > 0.005) { entry.ratio = ratio; scheduleLayout(); }
    });
    link.append(img);
    tile.append(link, dots);
    grid.insertBefore(tile, before);
    mounted.set(entry.post.name, entry);
    // Keep potentially animated formats moving in the gallery.
    const {post} = entry;
    const tileURL = post.format === 'jpeg' || post.format === 'png' ? post.url.replace(/^\/images\//, '/thumbs/') : post.url;
    showImage(img, {url: tileURL, original: post.url, format: post.format}, () => { status.textContent = 'Some images cannot be displayed'; });
    return tile;
  }
  function unmountEntry(entry: GalleryEntry) {
    if (!entry.tile) return;
    const img = entry.link?.querySelector('img');
    if (img) { img.onerror = null; img.removeAttribute('src'); }
    entry.tile.remove();
    entry.tile = undefined;
    entry.link = undefined;
    entry.dots = undefined;
    entry.applied = undefined;
    entry.dotLimit = 0;
    entry.renderedTags = undefined;
    entry.renderedFilter = undefined;
    mounted.delete(entry.post.name);
  }
  function renderSelection(entry: GalleryEntry) {
    if (!entry.tile || !entry.link) return;
    const active = selectedImages.has(entry.post.name);
    entry.tile.classList.toggle('is-selected', active);
    const description = `${entry.post.name}${entry.post.tags.length ? ', tags: ' + entry.post.tags.join(', ') : ''}`;
    entry.link.setAttribute('aria-label', selectionMode ? `${active ? 'Deselect' : 'Select'} image ${description}` : description);
    if (selectionMode) {
      entry.link.setAttribute('role', 'button');
      entry.link.setAttribute('aria-pressed', String(active));
    } else {
      entry.link.removeAttribute('role');
      entry.link.removeAttribute('aria-pressed');
    }
  }
  function updateSelectionCount() {
    selectedCount.textContent = batchActions.classList.contains('is-success') ? 'Succeeded!'
      : batchActions.classList.contains('is-failure') ? 'Failed!'
      : `${selectedImages.size} selected`;
    batchActions.hidden = !selectionMode || !detail.hidden;
    galleryActions.hidden = selectionMode || !detail.hidden;
    for (const button of [batchAdd, batchRemove, batchDelete]) button.disabled = !selectedImages.size || batchDeleting;
    batchClear.disabled = batchDeleting;
    nsfwToggle.disabled = batchDeleting;
  }
  function showBatchFeedback(success: boolean) {
    window.clearTimeout(batchFeedbackTimer);
    batchActions.classList.toggle('is-success', success);
    batchActions.classList.toggle('is-failure', !success);
    updateSelectionCount();
    batchFeedbackTimer = window.setTimeout(() => {
      batchActions.classList.remove('is-success', 'is-failure');
      updateSelectionCount();
    }, 1000);
  }
  function selectImage(entry: GalleryEntry, shift: boolean) {
    if (!selectionMode || deleting || batchDeleting) return;
    const name = entry.post.name;
    if (shift && rangeAnchor) {
      const visible = visibleEntries;
      const range = selectionRange(visible.map(item => item.post.name), rangeAnchor, name);
      if (range) {
        for (const item of visible.slice(range[0], range[1] + 1)) {
          selectedImages.add(item.post.name);
          renderSelection(item);
        }
        updateSelectionCount();
        return;
      }
    }
    if (selectedImages.has(name)) selectedImages.delete(name);
    else selectedImages.add(name);
    rangeAnchor = name;
    renderSelection(entry);
    updateSelectionCount();
  }
  function clearSelection() {
    rangeAnchor = null;
    if (!selectedImages.size) return;
    const selected = [...selectedImages];
    selectedImages.clear();
    for (const name of selected) {
      const entry = mounted.get(name);
      if (entry) renderSelection(entry);
    }
    updateSelectionCount();
  }
  function setSelectionMode(active: boolean) {
    if (batchDeleting || tagsSheet.open) return;
    selectionMode = active;
    selectModeButton.setAttribute('aria-pressed', String(selectionMode));
    selectModeButton.setAttribute('aria-label', selectionMode ? 'Done selecting' : 'Select images');
    selectModeButton.title = selectionMode ? 'Done selecting' : 'Select images';
    if (!selectionMode) clearSelection();
    for (const entry of mounted.values()) { if (entry.dots) entry.dots.inert = selectionMode; renderSelection(entry); }
    updateSelectionCount();
  }
  selectModeButton.addEventListener('click', () => setSelectionMode(!selectionMode));
  batchClear.addEventListener('click', () => setSelectionMode(false));
  batchDelete.addEventListener('click', async () => {
    if (batchDeleting || !detail.hidden || !selectedImages.size) return;
    const names = [...selectedImages];
    if (!window.confirm(`Delete ${names.length} selected ${names.length === 1 ? 'image' : 'images'} permanently?`)) return;
    batchDeleting = true;
    updateSelectionCount();
    const removed: string[] = [];
    let failed = 0;
    try {
      for (const name of names) {
        try {
          const response = await fetch(`/api/posts/${encodeURIComponent(name)}`, {method: 'DELETE'});
          if (!response.ok) throw new Error(`Deletion failed (${response.status})`);
          removed.push(name);
          console.info('Image deletion succeeded', {name});
        } catch (error) {
          failed++;
          console.error('Image deletion failed', {name}, error);
        }
      }
      for (const name of removed) selectedImages.delete(name);
      if (removed.length) {
        try {
          syncGallery(await fetchPosts());
        } catch (error) {
          const completed = new Set(removed);
          for (const entry of entries) if (completed.has(entry.post.name)) renderSelection(entry);
          updateSelectionCount();
          console.error('Gallery refresh after deletion failed', {deleted: removed, failed}, error);
        }
      }
      updateSelectionCount();
      if (!selectedImages.size) batchClear.focus({preventScroll: true});
      showBatchFeedback(failed === 0);
    } finally {
      batchDeleting = false;
      updateSelectionCount();
    }
  });
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

  function renderDots(entry: GalleryEntry, width: number) {
    if (!entry.dots) return;
    const dots = entry.dots;
    const limit = width < 92 ? 1 : width < 140 ? 3 : 5;
    const filter = [...selectedTags.keys()].join('\0');
    if (entry.dotLimit === limit && entry.renderedTags === entry.post.tags && entry.renderedFilter === filter) return;
    entry.dotLimit = limit;
    entry.renderedTags = entry.post.tags;
    entry.renderedFilter = filter;
    dots.replaceChildren();
    const shown = entry.post.tags.slice(0, limit);
    for (const tag of shown) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tag-dot-button';
      button.title = `Filter by ${tag}`;
      button.setAttribute('aria-label', `Filter by tag ${tag}`);
      button.setAttribute('aria-pressed', String(selectedTags.has(key(tag))));
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.setProperty('--tag-color', tagColor(tag));
      button.append(dot);
      button.addEventListener('click', () => { if (!selectionMode) toggleFilter(tag); });
      dots.append(button);
    }
    renderSelection(entry);
  }

  let windowScheduled = false;
  function renderWindow() {
    const top = -grid.getBoundingClientRect().top;
    const overscan = window.innerHeight * 1.5;
    const [start, end] = windowRange(visibleRects, top - overscan, top + window.innerHeight + overscan);
    const needed = new Set<string>();
    let before: Node | null = null;
    for (let i = end - 1; i >= start; i--) {
      const entry = visibleEntries[i], rect = visibleRects[i];
      const tile: HTMLDivElement = entry.tile ?? mountEntry(entry, before);
      if (entry.applied !== rect) {
        Object.assign(tile.style, {left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px`});
        tile.setAttribute('aria-posinset', String(i + 1));
        tile.setAttribute('aria-setsize', String(visibleEntries.length));
        entry.applied = rect;
        renderDots(entry, rect.width);
      }
      before = tile;
      needed.add(entry.post.name);
    }
    for (const entry of mounted.values()) if (!needed.has(entry.post.name)) unmountEntry(entry);
  }
  function scheduleWindow() {
    if (windowScheduled) return;
    windowScheduled = true;
    requestAnimationFrame(() => { windowScheduled = false; renderWindow(); });
  }
  window.addEventListener('scroll', scheduleWindow, {passive: true});
  window.addEventListener('resize', scheduleWindow);

  function layout(anchor?: ViewAnchor) {
    const width = grid.clientWidth;
    if (!width) return;
    const selectedKeys = [...selectedTags.keys()];
    visibleEntries = entries.filter(({post}) => matchesFilters(post, selectedKeys));
    const {positions, height} = layoutRows(visibleEntries.map(entry => entry.ratio), width, preferredHeight());
    visibleRects = positions;
    visibleEntries.forEach((entry, index) => { entry.rect = positions[index]; });
    grid.style.height = `${height}px`;
    if (anchor) {
      const tile = anchor.element.closest<HTMLDivElement>('.gallery-tile');
      const entry = tile && entryByTile.get(tile);
      if (entry?.rect) {
        const top = grid.getBoundingClientRect().top + entry.rect.y;
        const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        window.scrollTo(0, Math.max(0, Math.min(maxScroll, window.scrollY + top + entry.rect.height * anchor.fraction - anchor.y)));
      }
    }
    renderWindow();
    const hiddenByNSFW = !showNSFW && (selectedTags.has(key(NSFW_TAG)) || (!entries.length && posts.some(isNSFW)));
    if (hiddenByNSFW) status.textContent = 'NSFW images hidden';
    else if (selectedTags.size && !visibleEntries.length) status.textContent = 'No images match these filters';
    else status.textContent = entries.length ? '' : 'No images yet';
  }
  let scheduled = false;
  function scheduleLayout() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; layout(); });
  }

  function renderTagBar(focus?: string) {
    tagOptions.replaceChildren();
    let focused: HTMLButtonElement | undefined;
    for (const tag of filterTags(allowedPosts(posts, showNSFW), selectedTags)) {
      const id = key(tag);
      const button = option(tag, selectedTags.has(id), () => toggleFilter(tag));
      button.classList.add('tag-filter');
      tagOptions.append(button);
      if (id === focus) focused = button;
    }
    clearFilters.hidden = selectedTags.size === 0;
    tagOptions.scrollLeft = 0;
    focused?.focus({preventScroll: true});
    focused?.scrollIntoView({block: 'nearest', inline: 'nearest'});
  }
  function syncGallery(items: Post[]) {
    const existing = new Map(entries.map(entry => [entry.post.name, entry] as const));
    const updated = allowedPosts(items, showNSFW).map(post => {
      const entry = existing.get(post.name);
      if (entry) {
        existing.delete(post.name);
        entry.post = post;
        return entry;
      }
      const added = createEntry(post);
      return added;
    });
    for (const entry of existing.values()) { unmountEntry(entry); selectedImages.delete(entry.post.name); }
    entries.splice(0, entries.length, ...updated);
    updateSelectionCount();
    posts = items;
    const scrollLeft = tagOptions.scrollLeft;
    renderTagBar();
    tagOptions.scrollLeft = scrollLeft;
    layout();
  }
  function setShowNSFW(value: boolean) {
    if (batchDeleting || showNSFW === value) return;
    const toolbarBottom = tagToolbar.getBoundingClientRect().bottom;
    const gridTop = grid.getBoundingClientRect().top;
    let anchor = detail.hidden ? visibleEntries.find(entry => entry.rect && !isNSFW(entry.post) && gridTop + entry.rect.y + entry.rect.height > toolbarBottom) : undefined;
    let top = anchor?.rect ? gridTop + anchor.rect.y : undefined;
    if (!value && revealAnchor && Math.abs(window.scrollY - revealAnchor.scroll) < 2) {
      const previous = entries.find(entry => entry.post.name === revealAnchor?.name);
      if (previous?.rect && visibleEntries.includes(previous)) { anchor = previous; top = revealAnchor.top; }
    }
    showNSFW = value;
    hiddenEye.toggleAttribute('hidden', value);
    visibleEye.toggleAttribute('hidden', !value);
    nsfwToggle.setAttribute('aria-pressed', String(value));
    nsfwToggle.setAttribute('aria-label', value ? 'Hide NSFW images' : 'Show NSFW images');
    nsfwToggle.title = value ? 'Hide NSFW images' : 'Show NSFW images';
    clearSelection();
    syncGallery(posts);
    if (anchor && top !== undefined) {
      const moved = entries.find(entry => entry.post.name === anchor.post.name);
      if (moved?.rect) {
        window.scrollBy(0, grid.getBoundingClientRect().top + moved.rect.y - top);
        renderWindow();
      }
    }
    revealAnchor = value && anchor && top !== undefined ? {name: anchor.post.name, top, scroll: window.scrollY} : null;
    if (!value && !detail.hidden && isNSFW({tags: detailTags})) hideNSFWImage();
  }
  nsfwToggle.addEventListener('click', () => setShowNSFW(!showNSFW));
  function toggleFilter(tag: Tag) {
    if (batchDeleting) return;
    clearSelection();
    const id = key(tag);
    if (selectedTags.has(id)) selectedTags.delete(id);
    else selectedTags.set(id, tag);
    renderTagBar(id);
    layout();
  }
  clearFilters.addEventListener('click', () => {
    if (batchDeleting) return;
    clearSelection();
    selectedTags.clear();
    renderTagBar();
    layout();
    tagOptions.querySelector<HTMLButtonElement>('button')?.focus({preventScroll: true});
  });
  function validateDraft(tag: Tag): string {
    if (!tag || tag.trim() !== tag || Array.from(tag).length > 80 || /[\p{Cc}\p{Cf}]/u.test(tag)) return 'Name must be 1–80 characters without outer spaces';
    if (key(tag) === UNTAGGED_KEY) return 'Untagged is reserved for images without tags';
    if (draftTags.some(current => key(current) === key(tag))) return batchMode === 'remove' ? 'This tag is already selected' : 'This tag is already added';
    return '';
  }
  function renderSuggestions() {
    suggestions.replaceChildren();
    const matches = tagSuggestions(suggestionPool, draftTags, nameInput.value, batchMode !== 'remove');
    suggestions.hidden = matches.length === 0;
    for (const tag of matches) {
      suggestions.append(option(tag, false, () => addTag(tag)));
    }
  }
  function renderChips() {
    chips.replaceChildren();
    for (const tag of draftTags) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.style.setProperty('--tag-color', tagColor(tag));
      const label = document.createElement('span');
      label.textContent = tag;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${tag}`);
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('aria-hidden', 'true');
      const cross = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      cross.setAttribute('d', 'm5 5 14 14M19 5 5 19');
      icon.append(cross);
      remove.append(icon);
      remove.addEventListener('click', () => { draftTags = draftTags.filter(current => current !== tag); renderChips(); renderSuggestions(); });
      chip.append(label, remove);
      chips.append(chip);
    }
    if (!draftTags.length) chips.textContent = 'No tags';
  }
  function addTag(tag: Tag) {
    if (saveButton.disabled) return;
    tagError.textContent = validateDraft(tag);
    if (tagError.textContent) return;
    draftTags.push(tag);
    nameInput.value = '';
    renderChips();
    renderSuggestions();
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
  tagsSheet.addEventListener('close', () => {
    sheetFocus?.focus({preventScroll: true});
    batchMode = null;
    batchNames = [];
  });
  function openBatchTags(mode: 'add' | 'remove', trigger: HTMLButtonElement) {
    if (batchDeleting || !selectedImages.size) return;
    batchMode = mode;
    batchNames = [...selectedImages];
    sheetFocus = trigger;
    draftTags = [];
    const images = `${batchNames.length} ${batchNames.length === 1 ? 'image' : 'images'}`;
    tagsTitle.textContent = mode === 'add' ? `Add tags to ${images}` : `Remove tags from ${images}`;
    tagLabel.textContent = mode === 'add' ? 'Add tag' : 'Remove tag';
    nameInput.placeholder = mode === 'add' ? 'Press Enter to add' : 'Press Enter to remove';
    saveButton.textContent = mode === 'add' ? 'Add tags' : 'Remove tags';
    saveButton.disabled = false;
    tagError.textContent = '';
    nameInput.value = '';
    suggestionPool = mode === 'remove' ? posts.filter(post => selectedImages.has(post.name)) : allowedPosts(posts, showNSFW);
    renderChips();
    renderSuggestions();
    tagsSheet.showModal();
    tagsSheet.scrollTop = 0;
    tagsTitle.focus({preventScroll: true});
  }
  batchAdd.addEventListener('click', () => openBatchTags('add', batchAdd));
  batchRemove.addEventListener('click', () => openBatchTags('remove', batchRemove));
  tagsOpen.addEventListener('click', () => {
    batchMode = null;
    batchNames = [];
    tagsTitle.textContent = 'Tags';
    tagLabel.textContent = 'Add tag';
    nameInput.placeholder = 'Press Enter to add';
    saveButton.textContent = 'Save';
    sheetFocus = tagsOpen;
    draftTags = detailTags.slice();
    saveButton.disabled = !galleryLoaded;
    tagError.classList.toggle('loading', !galleryLoaded);
    tagError.textContent = galleryLoaded ? '' : 'Loading existing tags…';
    nameInput.value = '';
    suggestionPool = allowedPosts(posts, showNSFW);
    renderChips();
    renderSuggestions();
    tagsSheet.showModal();
    tagsSheet.scrollTop = 0;
    tagsTitle.focus({preventScroll: true});
    if (!galleryLoaded) fetchPosts().then(items => {
      if (tagsSheet.open) {
        suggestionPool = allowedPosts(items, showNSFW);
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
    if (batchMode && !draftTags.length) { tagError.textContent = 'Choose at least one tag'; return; }
    saving = true;
    tagError.textContent = '';
    tagsSheet.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach(control => { control.disabled = true; });
    try {
      if (batchMode) {
        const mode = batchMode;
        const names = batchNames.slice();
        const response = await fetch('/api/batch/tags', {
          method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({names, [mode]: draftTags}),
        });
        if (!response.ok) throw new Error(`Could not update tags (${response.status})`);
        console.info('Batch tag update succeeded', {mode, names, tags: [...draftTags]});
        sheetFocus = batchClear;
        tagsSheet.close();
        clearSelection();
        try {
          syncGallery(await fetchPosts());
        } catch (error) {
          console.error('Gallery refresh after tag update failed', {mode, names}, error);
        }
        showBatchFeedback(true);
        return;
      }
      const response = await fetch(`/api/posts/${encodeURIComponent(currentName)}/tags`, {
        method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({tags: draftTags}),
      });
      if (!response.ok) throw new Error(`Could not save tags (${response.status})`);
      const result = await response.json() as {tags: Tag[]};
      console.info('Image tag update succeeded', {name: currentName, tags: result.tags});
      detailTags = result.tags;
      const post = posts.find(post => post.name === currentName);
      if (post) post.tags = result.tags;
      if (galleryLoaded) syncGallery(posts);
      if (!showNSFW && isNSFW({tags: result.tags})) {
        hideNSFWImage();
        sheetFocus = nsfwReveal;
      }
      tagsSheet.close();
    } catch (error) {
      if (batchMode) {
        console.error('Batch tag update failed', {mode: batchMode, names: [...batchNames], tags: [...draftTags]}, error);
        tagsSheet.close();
        showBatchFeedback(false);
      } else {
        console.error('Image tag update failed', {name: currentName, tags: [...draftTags]}, error);
        tagError.textContent = error instanceof Error ? error.message : 'Could not save tags';
      }
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
      console.info('Image deletion succeeded', {name});
      if (galleryLoaded) {
        syncGallery(posts.filter(post => post.name !== name));
        previousFocus = grid.querySelector<HTMLAnchorElement>('.gallery-tile:not([hidden]) .gallery-link') ?? selectModeButton;
      }
      if (!detail.hidden && currentName === name) back.click();
    } catch (error) {
      console.error('Image deletion failed', {name}, error);
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
        const batch = pendingUploads.shift()!;
        const batchFailed = await uploadFiles(batch.files, batch.tags);
        uploaded += batch.files.length - batchFailed.length;
        failed.push(...batchFailed);
      }
      if (uploaded) {
        try {
          syncGallery(await fetchPosts());
        } catch (error) {
          console.error('Gallery refresh after image upload failed', {uploaded, failed: failed.map(file => file.name)}, error);
        }
      }
    } finally {
      uploading = false;
      if (pendingUploads.length) void processUploads();
    }
  }
  function queueUploads(files: File[], tags = [...selectedTags.values()]) {
    pendingUploads.push({files, tags});
    void processUploads();
  }
  async function queueDroppedImage(value: string, tags: Tag[]) {
    try {
      const file = await fetchDroppedImage(value);
      console.info('Dropped image fetched', {name: file.name, type: file.type, size: file.size});
      queueUploads([file], tags);
    } catch (error) {
      console.error('Dropped image fetch failed', error);
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
  function hideNSFWImage() {
    full.onerror = null;
    full.removeAttribute('src');
    full.hidden = true;
    nsfwReveal.hidden = false;
    detailStatus.textContent = 'NSFW image hidden';
    tagsOpen.disabled = true;
    deleteButton.disabled = true;
  }
  function showCurrentImage(name: string) {
    nsfwReveal.hidden = true;
    full.hidden = false;
    detailStatus.textContent = '';
    showImage(full, {url: `/images/${encodeURIComponent(name)}`, format: posts.find(post => post.name === name)?.format}, () => {
      if (currentName === name && !detail.hidden) detailStatus.textContent = 'This image cannot be displayed';
    });
    tagsOpen.disabled = deleting;
    deleteButton.disabled = deleting;
  }
  nsfwReveal.addEventListener('click', () => {
    if (detail.hidden || !tagsReady || !isNSFW({tags: detailTags})) return;
    setShowNSFW(true);
    showCurrentImage(currentName);
  });
  function openDetail(name: string) {
    if (detail.hidden) savedScroll = window.scrollY;
    openedFromGallery = galleryLoaded;
    const openedName = decodeURIComponent(name);
    currentName = openedName;
    full.onerror = null;
    full.removeAttribute('src');
    full.hidden = true;
    nsfwReveal.hidden = true;
    grid.inert = true;
    tagToolbar.inert = true;
    detail.hidden = false;
    updateSelectionCount();
    document.documentElement.style.overflow = 'hidden';
    scale = 1;
    panX = panY = 0;
    renderImage();
    full.alt = currentName;
    tagsReady = false;
    tagsOpen.disabled = true;
    deleteButton.disabled = true;
    fetch(`/api/posts/${encodeURIComponent(currentName)}/tags`).then(response => {
      if (!response.ok) throw new Error(`Failed to load tags (${response.status})`);
      return response.json() as Promise<{tags: Tag[]}>;
    }).then(({tags}) => {
      if (currentName !== openedName || detail.hidden) return;
      detailTags = tags;
      const post = posts.find(post => post.name === currentName);
      if (post) { post.tags = tags; if (galleryLoaded) syncGallery(posts); }
      tagsReady = true;
      if (!showNSFW && isNSFW({tags})) hideNSFWImage();
      else showCurrentImage(openedName);
    }).catch(error => {
      if (currentName === openedName && !detail.hidden) detailStatus.textContent = `Could not verify image tags: ${error instanceof Error ? error.message : String(error)}`;
    });
    detail.focus({preventScroll: true});
  }
  async function moveDetail(step: -1 | 1) {
    try {
      if (!posts.length) posts = await fetchPosts();
      if (detail.hidden || tagsSheet.open || deleting) return;
      const name = adjacentName(allowedPosts(posts, showNSFW), currentName, step, [...selectedTags.keys()]);
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
    updateSelectionCount();
    grid.inert = false;
    tagToolbar.inert = false;
    document.documentElement.style.overflow = '';
    window.scrollTo(0, savedScroll);
    if (previousFocus?.isConnected) previousFocus.focus({preventScroll: true});
    else nsfwToggle.focus({preventScroll: true});
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
    if (shouldExitSelectionOnEscape(event, selectionMode, Boolean(detail.hidden), tagsSheet.open)) {
      event.preventDefault();
      batchClear.click();
      return;
    }
    if (event.key === 'Escape' && !detail.hidden && !tagsSheet.open) back.click();
    if (detail.hidden || tagsSheet.open || deleting || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    void moveDetail(event.key === 'ArrowLeft' ? -1 : 1);
  });
  let mouseDown: {x: number; y: number; target: EventTarget | null} | null = null;
  let mouseDragged = false;
  let clickTimer: ReturnType<typeof setTimeout> | undefined;
  detail.addEventListener('click', event => {
    if (detail.hidden || tagsSheet.open || deleting || mouseDragged) return;
    const step = detailTapStep(event, detail, full);
    if (step === null) return;
    if (mouseDown?.target === full) {
      clearTimeout(clickTimer);
      if (event.detail === 1) {
        const name = currentName;
        clickTimer = setTimeout(() => { if (currentName === name) void moveDetail(step); }, 500);
      }
    } else void moveDetail(step);
  });
  detail.addEventListener('wheel', event => {
    event.preventDefault();
    event.stopPropagation();
    if (event.target !== full) return;
    const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? detail.clientHeight : 1;
    zoom(scale * Math.exp(-event.deltaY * units / 500), event.clientX, event.clientY);
  }, {passive: false});
  detail.addEventListener('dblclick', event => {
    if (event.target !== full && !(event.target === detail && mouseDown?.target === full)) return;
    clearTimeout(clickTimer);
    zoom(scale === 1 ? 2 : 1, event.clientX, event.clientY);
  });
  detail.addEventListener('pointerdown', event => {
    mouseDown = event.pointerType === 'mouse' && event.button === 0 ? {x: event.clientX, y: event.clientY, target: event.target} : null;
    mouseDragged = false;
    if (event.pointerType === 'touch' || event.target !== full || scale === 1) return;
    drag = {x: event.clientX, y: event.clientY};
    detail.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  detail.addEventListener('pointermove', event => {
    if (mouseDown && event.buttons === 1 && Math.hypot(event.clientX - mouseDown.x, event.clientY - mouseDown.y) > 4) mouseDragged = true;
    if (!drag) return;
    panX += event.clientX - drag.x;
    panY += event.clientY - drag.y;
    drag = {x: event.clientX, y: event.clientY};
    renderImage();
  });
  detail.addEventListener('pointerup', () => { drag = null; });
  detail.addEventListener('pointercancel', () => { drag = mouseDown = null; });
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
    if (batchDeleting) return;
    const target = event.target instanceof Element ? event.target : null;
    if (selectionMode) {
      const tile = target?.closest<HTMLDivElement>('.gallery-tile');
      if (tile && event.button === 0) {
        event.preventDefault();
        const entry = entryByTile.get(tile);
        if (entry) selectImage(entry, event.shiftKey);
      }
      return;
    }
    const link = target?.closest('a');
    if (event.target instanceof Element && event.target.closest('button')) return;
    if (!(link instanceof HTMLAnchorElement) || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    previousFocus = link;
    history.pushState(null, '', link.href);
    openDetail(link.pathname.slice('/posts/'.length));
  });
  grid.addEventListener('keydown', event => {
    if (!selectionMode || event.key !== ' ' || !(event.target instanceof HTMLAnchorElement)) return;
    const tile = event.target.closest<HTMLDivElement>('.gallery-tile');
    if (!tile) return;
    event.preventDefault();
    const entry = entryByTile.get(tile);
    if (entry) selectImage(entry, event.shiftKey);
  });
  const acceptsFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
  const acceptsURL = (event: DragEvent) => {
    const types = event.dataTransfer?.types;
    return !!types && ['text/uri-list', 'text/html', 'text/plain', 'DownloadURL', 'application/x-moz-file-promise-url'].some(type => types.includes(type));
  };
  const acceptsDrop = (event: DragEvent) => acceptsFiles(event) || acceptsURL(event);
  const galleryReadyForInput = () => location.pathname === '/' && detail.hidden && !tagsSheet.open;
  let dragDepth = 0;
  const clearDropOverlay = () => { dragDepth = 0; dropOverlay.hidden = true; };
  document.addEventListener('dragenter', event => {
    if (!galleryReadyForInput() || !acceptsDrop(event)) return;
    event.preventDefault();
    dragDepth++;
    dropOverlay.hidden = false;
  });
  document.addEventListener('dragover', event => {
    if (!galleryReadyForInput()) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', event => {
    if (!galleryReadyForInput() || !acceptsDrop(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropOverlay.hidden = true;
  });
  document.addEventListener('drop', event => {
    if (!galleryReadyForInput()) return;
    event.preventDefault();
    clearDropOverlay();
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length) {
      queueUploads(files);
    } else if (event.dataTransfer) {
      const url = droppedImageURL(event.dataTransfer);
      if (url) void queueDroppedImage(url, [...selectedTags.values()]);
      else console.error('Dropped item is not an image file or supported Twitter image URL');
    }
  });
  document.addEventListener('paste', event => {
    if (!galleryReadyForInput() || (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable]'))) return;
    const files = event.clipboardData && clipboardImages(event.clipboardData);
    if (!files?.length) return;
    event.preventDefault();
    queueUploads(files);
  });
  let pullStart: {x: number; y: number} | null = null;
  let pullDistance = 0;
  let pulling = false;
  let refreshing = false;
  let pullResetTimer = 0;
  const resetPull = () => {
    pullStart = null;
    pullDistance = 0;
    pulling = false;
    if (main.classList.contains('is-pulling')) {
      main.classList.remove('is-pulling');
      main.classList.add('is-pull-resetting');
      window.clearTimeout(pullResetTimer);
      pullResetTimer = window.setTimeout(() => {
        main.classList.remove('is-pull-resetting');
        main.style.removeProperty('--pull-offset');
      }, 180);
    }
    if (!refreshing) pullRefresh.hidden = true;
  };
  document.addEventListener('touchstart', event => {
    if (event.touches.length !== 1) { resetPull(); return; }
    if (refreshing || !galleryReadyForInput() || window.scrollY > 0 || (event.target instanceof Element && event.target.closest('button, input, textarea, [contenteditable]'))) return;
    window.clearTimeout(pullResetTimer);
    main.classList.remove('is-pull-resetting');
    main.style.removeProperty('--pull-offset');
    pullStart = {x: event.touches[0].clientX, y: event.touches[0].clientY};
    pullDistance = 0;
    pulling = false;
  }, {passive: true});
  document.addEventListener('touchmove', event => {
    if (!pullStart) return;
    if (event.touches.length !== 1 || window.scrollY > 0) { resetPull(); return; }
    const distance = event.touches[0].clientY - pullStart.y;
    const intent = pullIntent(event.touches[0].clientX - pullStart.x, distance, pulling);
    if (intent === 'pending') return;
    if (intent === 'cancel') { resetPull(); return; }
    event.preventDefault();
    pulling = true;
    pullDistance = distance;
    main.style.setProperty('--pull-offset', `${pullOffset(distance)}px`);
    main.classList.add('is-pulling');
    pullRefresh.hidden = false;
    pullRefresh.textContent = shouldRefreshPull(distance, true) ? 'Release to refresh' : 'Pull to refresh';
  }, {passive: false});
  document.addEventListener('touchend', event => {
    if (!pullStart || event.touches.length) return;
    const ready = shouldRefreshPull(pullDistance, window.scrollY <= 0) && galleryReadyForInput();
    resetPull();
    if (ready && !refreshing) {
      refreshing = true;
      pullRefresh.hidden = false;
      pullRefresh.textContent = 'Refreshing…';
      location.reload();
    }
  });
  document.addEventListener('touchcancel', resetPull);
  window.addEventListener('blur', clearDropOverlay);
  const match = location.pathname.match(/^\/posts\/([^/]+)$/);
  if (match) openDetail(match[1]);
  else loadGallery();
}
