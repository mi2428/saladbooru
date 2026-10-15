import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutRows, installZoom, imageRatio, showImage, uploadFiles, clipboardImages, droppedImageURL, fetchDroppedImage, shouldSubmitTagOnEnter, clickedOutsideDialog, tagColor, tagsByUse, filterTags, adjacentName, selectionRange, shouldRefreshPull, detailTapStep} from '../src/app.ts';

test('only AVIF falls back to preview, other formats retry once', () => {
  for (const name of ['x.avif', 'x.AVIF']) {
    const img = {src: '', onerror: () => {}} as unknown as HTMLImageElement;
    let errors = 0;
    showImage(img, {url: `/images/my%20${name}`, format: 'avif'}, () => { errors++; });
    assert.equal(img.src, `/images/my%20${name}`);
    assert.equal(errors, 0); // A browser that decodes natively never requests a JPEG.
    img.onerror!(new Event('error'));
    assert.equal(img.src, `/preview/my%20${name}`);
    assert.equal(errors, 0);
    img.onerror!(new Event('error'));
    assert.equal(errors, 1);
    showImage(img, {url: '/images/next.avif'}, () => { errors++; });
    img.onerror!(new Event('error'));
    assert.equal(img.src, '/preview/next.avif');
    assert.equal(errors, 1);
  }
  for (const name of ['x.png', 'x.jpg', 'x.gif', 'x.webp']) {
    const img = {src: '', onerror: () => {}} as unknown as HTMLImageElement;
    let errors = 0;
    showImage(img, {url: `/images/my%20${name}`, format: name.slice(name.lastIndexOf('.') + 1)}, () => { errors++; });
    img.onerror!(new Event('error'));
    assert.match(img.src, new RegExp(`^/images/my%20${name.replace('.', '\\.')}\\?retry=\\d+$`));
    assert.equal(errors, 0);
    img.onerror!(new Event('error'));
    assert.equal(errors, 1);
  }
});

test('a missing gallery thumbnail falls back to the original before reporting failure', () => {
  const img = {src: '', onerror: () => {}} as unknown as HTMLImageElement;
  let errors = 0;
  showImage(img, {url: '/thumbs/my%20image.jpg', original: '/images/my%20image.jpg', format: 'jpeg'}, () => { errors++; });
  img.onerror!(new Event('error'));
  assert.equal(img.src, '/images/my%20image.jpg');
  img.onerror!(new Event('error'));
  assert.match(img.src, /^\/images\/my%20image\.jpg\?retry=\d+$/);
  img.onerror!(new Event('error'));
  assert.equal(errors, 1);
  showImage(img, {url: '/thumbs/next.avif', original: '/images/next.avif', format: 'avif'}, () => { errors++; });
  img.onerror!(new Event('error'));
  assert.equal(img.src, '/images/next.avif');
  img.onerror!(new Event('error'));
  assert.equal(img.src, '/preview/next.avif');
});

test('direct detail URLs with an unknown format retain the AVIF fallback even when misnamed', () => {
  const img = {src: '', onerror: () => {}} as unknown as HTMLImageElement;
  let errors = 0;
  showImage(img, {url: '/images/animation.jpg'}, () => { errors++; });
  img.onerror!(new Event('error'));
  assert.match(img.src, /^\/images\/animation\.jpg\?retry=\d+$/);
  img.onerror!(new Event('error'));
  assert.equal(img.src, '/preview/animation.jpg');
  img.onerror!(new Event('error'));
  assert.equal(errors, 1);
});

test('uploads dropped files one at a time and continues after failures', async () => {
  const originalFetch = globalThis.fetch;
  const uploaded: string[] = [];
  let active = 0;
  let maxActive = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/api/posts');
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).has('Authorization'), false);
    assert.ok(init?.body instanceof FormData);
    const fields = Array.from(init.body.entries());
    assert.equal(fields.length, 1);
    assert.equal(fields[0][0], 'file');
    assert.ok(fields[0][1] instanceof File);
    const file = fields[0][1] as File;
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 0));
    active--;
    uploaded.push(file.name);
    return new Response(null, {status: file.name === 'bad.png' ? 422 : 201});
  };
  try {
    const files = [new File(['1'], 'first.png'), new File(['2'], 'bad.png'), new File(['3'], 'last.png')];
    const progress: string[] = [];
    const failed = await uploadFiles(files, (file, index) => progress.push(`${index}:${file.name}`));
    assert.deepEqual(uploaded, ['first.png', 'bad.png', 'last.png']);
    assert.equal(maxActive, 1);
    assert.deepEqual(progress, ['0:first.png', '1:bad.png', '2:last.png']);
    assert.deepEqual(failed.map(file => file.name), ['bad.png']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('uploads selected tags with the image in one multipart request', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/api/posts');
    assert.ok(init?.body instanceof FormData);
    assert.deepEqual(Array.from(init.body.keys()), ['file', 'tags']);
    assert.equal(init.body.get('tags'), '["Blue","red"]');
    requests++;
    return new Response(null, {status: 201});
  };
  try {
    assert.deepEqual(await uploadFiles([new File(['image'], 'image.png')], () => {}, ['Blue', 'red']), []);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('clipboard uploads only image files and gives nameless images an upload filename', async () => {
  const image = new File(['pixels'], '', {type: 'image/png'});
  const second = new File(['jpeg'], 'second.jpg', {type: 'image/jpeg'});
  const text = new File(['notes'], 'notes.txt', {type: 'text/plain'});
  const fromFiles = clipboardImages({files: [image, text, second] as unknown as FileList, items: [] as unknown as DataTransferItemList});
  assert.deepEqual(fromFiles.map(file => file.name), ['pasted-image', 'second.jpg']);
  assert.equal(fromFiles[0].type, 'image/png');
  assert.equal(await fromFiles[0].text(), 'pixels');
  assert.deepEqual(clipboardImages({files: [text] as unknown as FileList, items: [] as unknown as DataTransferItemList}), []);
  const items = [
    {kind: 'file', type: 'image/png', getAsFile: () => image},
    {kind: 'file', type: 'image/jpeg', getAsFile: () => second},
    {kind: 'string', type: 'text/plain', getAsFile: () => null},
  ] as unknown as DataTransferItemList;
  assert.deepEqual(clipboardImages({files: [] as unknown as FileList, items}).map(file => file.name), ['pasted-image', 'second.jpg']);
});

test('imports CORS-enabled Twitter image URLs as uploadable files', async () => {
  const url = 'https://pbs.twimg.com/media/example?format=jpg&name=4096x4096';
  const uri = droppedImageURL({getData: type => type === 'text/uri-list' ? `#image\n${url}\r\n` : ''});
  assert.equal(uri, url);
  assert.equal(droppedImageURL({getData: type => type === 'DownloadURL' ? `image/jpeg:dropped.jpg:${url}` : ''}), url);
  assert.ok(uri);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), url);
    assert.equal(init?.mode, 'cors');
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.referrerPolicy, 'no-referrer');
    assert.equal(init?.redirect, 'error');
    return new Response(new Blob(['image'], {type: 'image/jpeg'}), {headers: {'Content-Type': 'image/jpeg'}});
  };
  try {
    const file = await fetchDroppedImage(uri);
    assert.equal(file.name, 'dropped-image');
    assert.equal(file.type, 'image/jpeg');
    assert.equal(await file.text(), 'image');
    await assert.rejects(fetchDroppedImage('https://example.com/image.jpg'), /Only HTTPS images from/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('IME confirmation Enter does not submit a tag', () => {
  assert.equal(shouldSubmitTagOnEnter({key: 'Enter', isComposing: true, keyCode: 13}), false);
  assert.equal(shouldSubmitTagOnEnter({key: 'Enter', isComposing: false, keyCode: 229}), false);
  assert.equal(shouldSubmitTagOnEnter({key: 'Enter', isComposing: false, keyCode: 13}), true);
  assert.equal(shouldSubmitTagOnEnter({key: 'a', isComposing: false, keyCode: 65}), false);
});

test('only a click on the backdrop dismisses the tag dialog', () => {
  const dialog = {getBoundingClientRect: () => ({left: 50, right: 250, top: 100, bottom: 300})} as HTMLDialogElement;
  const click = (target: EventTarget, clientX: number, clientY: number) => clickedOutsideDialog({target, clientX, clientY}, dialog);
  assert.equal(click(dialog, 60, 110), false);
  assert.equal(click(dialog, 60, 301), true);
  assert.equal(click(dialog, 49, 110), true);
  assert.equal(click({} as EventTarget, 49, 110), false);
});

test('tags retain a vivid, case-insensitive color across views', () => {
  assert.equal(tagColor('Tomato'), tagColor('tomato'));
  const palette = new Set(Array.from({length: 512}, (_, i) => tagColor(`Tag${i}`)));
  assert.equal(palette.size, 32);
  for (const color of palette) assert.match(color, /^#[0-9a-f]{6}$/);
});

test('tag popularity counts images, merges case variants and sorts ties by name', () => {
  const posts = [
    {tags: ['Zulu', 'blue', 'BLUE']},
    {tags: ['Blue', 'Aiko']},
    {tags: ['aiko', 'blue']},
    {tags: ['Zulu']},
  ];
  assert.deepEqual(tagsByUse(posts), ['blue', 'Aiko', 'Zulu']);
  assert.deepEqual(tagsByUse([]), []);
});

test('active filters come first without changing popularity order or losing deleted tags', () => {
  const posts = [{tags: ['Blue', 'red']}, {tags: ['BLUE', 'Green']}, {tags: ['green', 'Blue']}];
  const selected = new Map([['red', 'RED'], ['green', 'Green'], ['gone', 'Gone']]);
  assert.deepEqual(filterTags(posts, selected), ['Green', 'red', 'Gone', 'Blue']);
  selected.delete('green');
  assert.deepEqual(filterTags(posts, selected), ['red', 'Gone', 'Blue', 'Green']);
  assert.deepEqual(filterTags(posts, new Map()), tagsByUse(posts));
});

test('arrow navigation follows gallery order and active filters without wrapping', () => {
  const posts = [
    {name: 'first.png', tags: ['Red']},
    {name: 'second.png', tags: ['Blue']},
    {name: 'third.png', tags: ['red']},
  ];
  assert.equal(adjacentName(posts, 'first.png', 1, []), 'second.png');
  assert.equal(adjacentName(posts, 'second.png', -1, []), 'first.png');
  assert.equal(adjacentName(posts, 'first.png', 1, ['red']), 'third.png');
  assert.equal(adjacentName(posts, 'first.png', -1, []), undefined);
  assert.equal(adjacentName(posts, 'third.png', 1, ['red']), undefined);
  assert.equal(adjacentName(posts, 'second.png', 1, ['red']), undefined);
});

test('Shift selects an inclusive range in either direction, never across missing anchors', () => {
  const names = ['first', 'second', 'third', 'fourth'];
  assert.deepEqual(selectionRange(names, 'first', 'third'), [0, 2]);
  assert.deepEqual(selectionRange(names, 'fourth', 'second'), [1, 3]);
  assert.deepEqual(selectionRange(names, 'third', 'third'), [2, 2]);
  assert.equal(selectionRange(names, 'missing', 'second'), null);
});

test('pull-to-refresh requires a released pull past the threshold at the top', () => {
  assert.equal(shouldRefreshPull(79, true), false);
  assert.equal(shouldRefreshPull(80, true), true);
  assert.equal(shouldRefreshPull(120, false), false);
});

test('viewer taps and mouse clicks use screen halves without intercepting viewer controls', () => {
  const detail = {getBoundingClientRect: () => ({left: 10, width: 300})} as HTMLElement;
  const image = {} as HTMLImageElement;
  const click = (target: EventTarget, clientX: number, button = 0) => detailTapStep({target, clientX, button}, detail, image);
  assert.equal(click(image, 159), -1);
  assert.equal(click(detail, 160), 1);
  assert.equal(click(image, 310), 1);
  assert.equal(click(image, 60, 2), null);
  assert.equal(click({} as EventTarget, 60), null);
});

test('browser intrinsic dimensions correct display ratios', () => {
  assert.equal(imageRatio({width: 64, height: 64}, {naturalWidth: 0, naturalHeight: 0}), 1);
  assert.equal(imageRatio({width: 64, height: 64}, {naturalWidth: 2, naturalHeight: 4}), 0.5);
});

test('justified rows preserve natural ratios, order and sparse final row', () => {
  const ratios = [0.5, 2, 1, 1.4, 0.6];
  const {positions} = layoutRows(ratios, 800, 220);
  positions.forEach((rect, i) => assert.ok(Math.abs(rect.width / rect.height - ratios[i]) < 1e-9));
  assert.ok(Math.abs(positions[2].x + positions[2].width - 800) < 1e-9);
  assert.equal(positions[3].height, 220);
  assert.ok(positions[4].x + positions[4].width < 800);
  assert.ok(layoutRows(ratios, 800, 110).positions[4].y < positions[4].y);
});

test('ordinary scroll stays native while modified wheel and two-finger pinch reflow', () => {
  const handlers = new Map<string, EventListener>();
  const layouts: number[] = [];
  const documentBefore = globalThis.document;
  const windowBefore = globalThis.window;
  globalThis.document = {elementFromPoint: () => null, querySelector: () => null, getElementById: () => ({hidden: true})} as unknown as Document;
  globalThis.window = {innerHeight: 700, addEventListener(type: string, fn: EventListener) { handlers.set(type, fn); }} as unknown as Window & typeof globalThis;
  try {
    const height = installZoom(() => layouts.push(height()));
    let prevented = 0;
    const dispatch = (type: string, event: object) => {
      const handler = handlers.get(type);
      assert.ok(handler);
      handler(event as Event);
    };
    const wheel = (extra: object) => dispatch('wheel', {deltaY: -100, deltaMode: 0, clientX: 0, clientY: 0, preventDefault() { prevented++; }, ...extra});
    wheel({});
    assert.equal(prevented, 0);
    assert.equal(layouts.length, 0);
    wheel({ctrlKey: true});
    assert.equal(prevented, 1);
    assert.ok(height() > 220);
    const touches = (d: number) => [{clientX: 0, clientY: 0}, {clientX: d, clientY: 0}];
    const initial = height();
    dispatch('touchstart', {touches: touches(100)});
    dispatch('touchmove', {touches: touches(50), preventDefault() { prevented++; }});
    assert.equal(height(), initial / 2);
    assert.equal(prevented, 2);
    assert.equal(layouts.length, 2);
  } finally {
    if (documentBefore === undefined) Reflect.deleteProperty(globalThis, 'document');
    else globalThis.document = documentBefore;
    if (windowBefore === undefined) Reflect.deleteProperty(globalThis, 'window');
    else globalThis.window = windowBefore;
  }
});
