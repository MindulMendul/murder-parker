import { expect, spyOn, test } from 'bun:test';
import { checkDimensions, imageDimensions, jpegDimensions, webpFilename } from '../src/features/image-converter/headers';
import { convertToWebp, MAX_IMAGE_BYTES } from '../src/features/image-converter/convert';

test('oversized metadata rejects before decoding; wrong headers reject safely', async () => {
  const bytes = new Uint8Array(24);
  bytes.set([137,80,78,71,13,10,26,10]); bytes.set([73,72,68,82],12);
  const view = new DataView(bytes.buffer);view.setUint32(16,100_000);view.setUint32(20,100_000);
  const dimensions = imageDimensions(bytes, 'image/png');
  expect(() => checkDimensions(dimensions.width, dimensions.height)).toThrow('dimensions');
  for (const mime of ['image/png','image/jpeg','image/gif','image/webp']) expect(() => imageDimensions(new Uint8Array(4),mime)).toThrow('format');
  expect(webpFilename('name.photo.jpg')).toBe('name.photo.webp');
});

test('JPEG metadata beyond 256 KiB reaches decoding only after the bounded dimension check', async () => {
  const metadata = new Uint8Array(65537);
  metadata.set([255, 225, 255, 255]);
  const frame = new Uint8Array([255, 192, 0, 8, 8, 0, 60, 0, 80, 0]);
  const parts = [new Uint8Array([255, 216]), ...Array.from({ length: 5 }, () => metadata), frame];
  let decodes = 0;
  const previous = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async () => { decodes++; throw Error('decoder reached'); };
  try {
    const file = new File(parts, 'metadata.jpg', { type: 'image/jpeg' });
    expect(file.size).toBeGreaterThan(256 * 1024);
    await expect(convertToWebp(file)).rejects.toThrow('decoder reached');
    expect(decodes).toBe(1);
    new DataView(frame.buffer).setUint16(5, 65535);
    new DataView(frame.buffer).setUint16(7, 65535);
    await expect(convertToWebp(new File(parts, 'oversized.jpg', { type: 'image/jpeg' }))).rejects.toThrow('dimensions');
    await expect(convertToWebp(new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], 'large.jpg', { type: 'image/jpeg' }))).rejects.toThrow('size');
    expect(decodes).toBe(1);
  } finally { globalThis.createImageBitmap = previous; }
});

test('JPEG inspection skips large payloads, stops at SOF and bounds malformed metadata work', async () => {
  const frame = new Uint8Array([255, 192, 0, 8, 8, 0, 60, 0, 80, 0]);
  const segment = new Uint8Array(65537); segment.set([255, 239, 255, 255]);
  for (const metadata of [[], Array.from({ length: 5 }, () => segment)]) {
    const file = new File([new Uint8Array([255,216]), ...metadata, frame, new Uint8Array(9 * 1024 * 1024)], 'bounded.jpg');
    const originalSlice = file.slice.bind(file);
    let readBytes = 0;
    const slice = spyOn(file, 'slice').mockImplementation((start = 0, end = file.size) => { readBytes += Math.min(end, file.size) - start; return originalSlice(start, end); });
    const fullRead = spyOn(file, 'arrayBuffer').mockImplementation(() => { throw Error('full file read'); });
    try {
      expect(await jpegDimensions(file)).toEqual({ width: 80, height: 60 });
      expect(readBytes).toBeLessThan(256 * 1024);
    } finally { slice.mockRestore(); fullRead.mockRestore(); }
  }
  for (const bytes of [
    [255,216,255,225,0,1], // invalid length
    [255,216,255,225,255,255], // truncated segment
    [255,216,255,218,0,2], // no frame before compressed data
  ]) await expect(jpegDimensions(new Blob([new Uint8Array(bytes)]))).rejects.toThrow('format');
  const tooMany = new Blob([new Uint8Array([255,216]), ...Array.from({ length: 4097 }, () => new Uint8Array([255,225,0,2])), frame]);
  await expect(jpegDimensions(tooMany)).rejects.toThrow('format');
});

test('PNG, GIF, JPEG, WebP VP8X/VP8L/VP8 metadata dimensions', () => {
  const png=new Uint8Array(24);png.set([137,80,78,71,13,10,26,10]);png.set([73,72,68,82],12);new DataView(png.buffer).setUint32(16,80);new DataView(png.buffer).setUint32(20,60);
  expect(imageDimensions(png,'image/png')).toEqual({width:80,height:60});
  const gif=new Uint8Array([71,73,70,56,57,97,80,0,60,0]);expect(imageDimensions(gif,'image/gif')).toEqual({width:80,height:60});
  const jpg=new Uint8Array([255,216,255,192,0,8,8,0,60,0,80,0]);expect(imageDimensions(jpg,'image/jpeg')).toEqual({width:80,height:60});
  for(const kind of ['VP8X','VP8L','VP8 ']) {
    const bytes=new Uint8Array(30);const view=new DataView(bytes.buffer);bytes.set(new TextEncoder().encode('RIFF'),0);bytes.set(new TextEncoder().encode('WEBP'+kind),8);view.setUint32(16,10,true);
    if(kind==='VP8X'){bytes[24]=79;bytes[27]=59;}
    if(kind==='VP8L'){bytes[20]=47;view.setUint32(21,79+(59<<14),true);}
    if(kind==='VP8 '){bytes.set([157,1,42],23);view.setUint16(26,80,true);view.setUint16(28,60,true);}
    expect(imageDimensions(bytes,'image/webp')).toEqual({width:80,height:60});
  }
});
