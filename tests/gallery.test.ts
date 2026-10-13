import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutRows, installZoom, imageRatio, showImage, uploadFiles, droppedImageURL, fetchDroppedImage} from '../src/app.ts';

test('native image first, preview once after decode failure, then show error', () => {
  for (const name of ['x.avif', 'x.AVIF', 'x.png', 'x.jpg']) {
    const img = {src: '', onerror: () => {}} as unknown as HTMLImageElement;
    let errors = 0;
    showImage(img, `/images/my%20${name}`, () => { errors++; });
    assert.equal(img.src, `/images/my%20${name}`);
    assert.equal(errors, 0); // A browser that decodes natively never requests a JPEG.
    img.onerror!(new Event('error'));
    assert.equal(img.src, `/preview/my%20${name}`);
    assert.equal(errors, 0);
    img.onerror!(new Event('error'));
    assert.equal(errors, 1);
    showImage(img, '/images/next.avif', () => { errors++; });
    img.onerror!(new Event('error'));
    assert.equal(img.src, '/preview/next.avif');
    assert.equal(errors, 1);
  }
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
