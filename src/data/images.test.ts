import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_IMAGE_BYTES,
  MAX_INPUT_IMAGE_BYTES,
  prepareImage,
  readRasterMetadata,
  validatePreparedImage,
  type PreparedImage,
} from './images';

const tinyPng = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1kAAAAASUVORK5CYII='), (value) => value.charCodeAt(0));

function png(width = 1, height = 1): Blob {
  const bytes = tinyPng.slice();
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return new Blob([bytes], { type: 'image/png' });
}

function webp(width = 1, height = 1): Blob {
  const bytes = new Uint8Array(26);
  bytes.set(Array.from('RIFF', (value) => value.charCodeAt(0)), 0);
  bytes.set(Array.from('WEBPVP8L', (value) => value.charCodeAt(0)), 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(16, 5, true);
  bytes[20] = 0x2f;
  view.setUint32(21, (width - 1) | ((height - 1) << 14), true);
  return new Blob([bytes], { type: 'image/webp' });
}

function prepared(blob = png(), width = 1, height = 1): PreparedImage {
  return { blob, mimeType: blob.type as PreparedImage['mimeType'], width, height, byteLength: blob.size };
}

function mockCanvas(output: (mime: string) => Blob | null, sourceWidth = 1, sourceHeight = 1, decodeError = false) {
  const revoke = vi.fn();
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:local-only'), revokeObjectURL: revoke });
  class MockImage {
    naturalWidth = sourceWidth;
    naturalHeight = sourceHeight;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) { queueMicrotask(() => decodeError ? this.onerror?.() : this.onload?.()); }
  }
  vi.stubGlobal('Image', MockImage);
  const drawImage = vi.fn();
  const toBlob = vi.fn((callback: BlobCallback, mime: string) => callback(output(mime)));
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), toBlob };
  vi.spyOn(document, 'createElement').mockImplementation((name: string) => {
    if (name !== 'canvas') throw new Error('Unexpected element');
    return canvas as unknown as HTMLCanvasElement;
  });
  return { revoke, canvas, drawImage, toBlob };
}

beforeEach(() => {
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('File', NodeFile);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('stored image validation', () => {
  it('reads actual PNG and WebP frame signatures and dimensions', async () => {
    expect(readRasterMetadata(new Uint8Array(await png().arrayBuffer())))
      .toEqual({ mimeType: 'image/png', width: 1, height: 1 });
    expect(readRasterMetadata(new Uint8Array(await webp(2048, 999).arrayBuffer())))
      .toEqual({ mimeType: 'image/webp', width: 2048, height: 999 });
    // SOF0 frame, one component, ending with EOI.
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 20, 0, 30, 1, 1, 0x11, 0, 0xff, 0xd9);
    expect(readRasterMetadata(jpeg)).toEqual({ mimeType: 'image/jpeg', width: 30, height: 20 });
  });

  it('rejects incorrect MIME, metadata, sizes, truncated files and SVG masquerading as PNG', async () => {
    await expect(validatePreparedImage(prepared())).resolves.toBeUndefined();
    await expect(validatePreparedImage({ ...prepared(), width: 2 })).rejects.toThrow();
    await expect(validatePreparedImage({ ...prepared(), mimeType: 'image/jpeg' })).rejects.toThrow();
    await expect(validatePreparedImage({ ...prepared(), byteLength: 1 })).rejects.toThrow();
    await expect(validatePreparedImage(prepared(png(2049, 1), 2049))).rejects.toThrow();
    await expect(validatePreparedImage(prepared(new Blob(['<svg/>'], { type: 'image/png' })))).rejects.toThrow();
    await expect(validatePreparedImage(prepared(new Blob([tinyPng.slice(0, 33)], { type: 'image/png' })))).rejects.toThrow();
    await expect(validatePreparedImage(prepared(new Blob([new Uint8Array(MAX_IMAGE_BYTES + 1)], { type: 'image/png' })))).rejects.toThrow();
    expect(() => readRasterMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xda]))).toThrow();
  });
});

describe('local image conversion', () => {
  it('resizes without upscaling, encodes WebP and releases object URLs and canvas memory', async () => {
    const { revoke, canvas, drawImage, toBlob } = mockCanvas(() => webp(2048, 1024), 4000, 2000);
    const file = new File([png()], 'photo.png', { type: 'image/png' });
    const result = await prepareImage(file);
    expect(result).toMatchObject({ mimeType: 'image/webp', width: 2048, height: 1024 });
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 2048, 1024);
    expect(toBlob).toHaveBeenCalledWith(expect.anything(), 'image/webp', 0.82);
    expect(revoke).toHaveBeenCalledWith('blob:local-only');
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it('uses a newly encoded PNG when the browser does not support WebP rather than keeping the original', async () => {
    const output = png();
    const { toBlob } = mockCanvas(() => output);
    const source = new File([png()], 'with-metadata.png', { type: 'image/png' });
    const result = await prepareImage(source);
    expect(result.mimeType).toBe('image/png');
    expect(result.blob).toBe(output);
    expect(result.blob).not.toBe(source);
    expect(toBlob.mock.calls.map((call) => call[1])).toEqual(['image/webp', 'image/png']);
    expect(result.width).toBe(1);
  });

  it('falls back after an encoder throws for an unsupported MIME', async () => {
    const output = png();
    const { toBlob } = mockCanvas((mime) => {
      if (mime === 'image/webp') throw new DOMException('Unsupported type', 'NotSupportedError');
      return output;
    });
    const result = await prepareImage(new File([png()], 'photo.png', { type: 'image/png' }));
    expect(result.mimeType).toBe('image/png');
    expect(toBlob).toHaveBeenCalledTimes(2);
  });

  it('rejects SVG even with a false photo MIME, oversize inputs, and excessive pixel dimensions before decoding', async () => {
    const { drawImage, revoke } = mockCanvas(() => png());
    await expect(prepareImage(new File(['<svg/>'], 'fake.jpg', { type: 'image/jpeg' }))).rejects.toThrow('対応していない');
    await expect(prepareImage(new File(['<svg/>'], 'image.svg', { type: 'image/svg+xml' }))).rejects.toThrow('SVG');
    await expect(prepareImage(new File([new Uint8Array(MAX_INPUT_IMAGE_BYTES + 1)], 'large.png', { type: 'image/png' }))).rejects.toThrow('20MB');
    await expect(prepareImage(new File([png(10_000, 10_000)], 'huge.png', { type: 'image/png' }))).rejects.toThrow('4,000万');
    expect(drawImage).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it('reports unsupported HEIC decode, file reads, failed encoders and frees temporary URLs', async () => {
    const { revoke } = mockCanvas(() => null, 1, 1, true);
    const heic = new File([Uint8Array.of(0, 0, 0, 24, ...Array.from('ftypheic', (value) => value.charCodeAt(0)))], 'photo.heic', { type: 'image/heic' });
    await expect(prepareImage(heic)).rejects.toThrow('HEIC');
    expect(revoke).toHaveBeenCalledOnce();
    const unreadable = new File([png()], 'file.png', { type: 'image/png' });
    vi.spyOn(unreadable, 'arrayBuffer').mockRejectedValueOnce(new Error('read failed'));
    await expect(prepareImage(unreadable)).rejects.toThrow('読み込めません');
    mockCanvas(() => null);
    await expect(prepareImage(new File([png()], 'file.png', { type: 'image/png' }))).rejects.toThrow('圧縮に失敗');
  });
});
