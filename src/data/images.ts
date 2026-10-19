export type ImageMimeType = 'image/webp' | 'image/jpeg' | 'image/png';

export interface Attachment {
  id: string;
  postId: string;
  mimeType: ImageMimeType;
  byteLength: number;
  width: number;
  height: number;
  createdAt: number;
  blob: Blob;
}

export type PreparedImage = Omit<Attachment, 'id' | 'postId' | 'createdAt'>;

export const MAX_IMAGES_PER_POST = 4;
export const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 2048;
const MAX_INPUT_PIXELS = 40_000_000;

interface RasterMetadata {
  mimeType: ImageMimeType;
  width: number;
  height: number;
}

const invalidImage = () => new Error('画像の形式またはデータが正しくありません。');
const ascii = (bytes: Uint8Array, offset: number, length: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

/** Read encoded raster dimensions without decoding or executing image contents. */
export function readRasterMetadata(bytes: Uint8Array): RasterMetadata {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 33 && ascii(bytes, 1, 3) === 'PNG' &&
      bytes[0] === 0x89 && ascii(bytes, 4, 4) === '\r\n\x1a\n' &&
      view.getUint32(8) === 13 && ascii(bytes, 12, 4) === 'IHDR') {
    let offset = 8;
    let hasImageData = false;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset);
      if (length > bytes.length - offset - 12) throw invalidImage();
      const kind = ascii(bytes, offset + 4, 4);
      if (kind === 'IDAT' && length > 0) hasImageData = true;
      if (kind === 'IEND') {
        if (!hasImageData || length !== 0 || offset + 12 !== bytes.length) throw invalidImage();
        return checkedMetadata('image/png', view.getUint32(16), view.getUint32(20));
      }
      offset += 12 + length;
    }
    throw invalidImage();
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP' &&
      view.getUint32(4, true) + 8 === bytes.length) {
    // A WebP file may contain metadata chunks before its frame. Only a frame is accepted.
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const kind = ascii(bytes, offset, 4);
      const size = view.getUint32(offset + 4, true);
      const data = offset + 8;
      if (size > bytes.length - data) throw invalidImage();
      if (kind === 'VP8 ' && size >= 10 && bytes[data + 3] === 0x9d &&
          bytes[data + 4] === 0x01 && bytes[data + 5] === 0x2a) {
        return checkedMetadata('image/webp', view.getUint16(data + 6, true) & 0x3fff,
          view.getUint16(data + 8, true) & 0x3fff);
      }
      if (kind === 'VP8L' && size >= 5 && bytes[data] === 0x2f) {
        const dimensions = view.getUint32(data + 1, true);
        return checkedMetadata('image/webp', (dimensions & 0x3fff) + 1,
          ((dimensions >>> 14) & 0x3fff) + 1);
      }
      offset = data + size + (size % 2);
    }
    throw invalidImage();
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
      bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) {
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) throw invalidImage();
      while (bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) throw invalidImage();
      const length = view.getUint16(offset);
      if (length < 2 || length > bytes.length - offset) throw invalidImage();
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) throw invalidImage();
        return checkedMetadata('image/jpeg', view.getUint16(offset + 5), view.getUint16(offset + 3));
      }
      offset += length;
    }
  }
  throw invalidImage();
}

function checkedMetadata(mimeType: ImageMimeType, width: number, height: number): RasterMetadata {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw invalidImage();
  }
  return { mimeType, width, height };
}

/** Shared by normal writes and backup import; call before an IndexedDB transaction. */
export async function validatePreparedImage(image: PreparedImage): Promise<void> {
  if (!image || !(image.blob instanceof Blob) ||
      !['image/webp', 'image/jpeg', 'image/png'].includes(image.mimeType) ||
      image.blob.type !== image.mimeType || image.byteLength !== image.blob.size ||
      !Number.isSafeInteger(image.byteLength) || image.byteLength < 1 || image.byteLength > MAX_IMAGE_BYTES ||
      !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) ||
      image.width < 1 || image.height < 1 || image.width > MAX_IMAGE_SIDE || image.height > MAX_IMAGE_SIDE) {
    throw invalidImage();
  }
  const metadata = readRasterMetadata(new Uint8Array(await image.blob.arrayBuffer()));
  if (metadata.mimeType !== image.mimeType || metadata.width !== image.width || metadata.height !== image.height) {
    throw invalidImage();
  }
}

function encode(canvas: HTMLCanvasElement, type: ImageMimeType): Promise<Blob | null> {
  return new Promise((resolve) => {
    try { canvas.toBlob(resolve, type, type === 'image/png' ? undefined : 0.82); }
    catch { resolve(null); }
  });
}

/** Decode, resize and re-encode on this device; never retain the original file or its metadata. */
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!file || file.size < 1 || file.size > MAX_INPUT_IMAGE_BYTES) {
    throw new Error('画像は1枚20MB以下のファイルを選んでください。');
  }
  if (file.type.toLowerCase().includes('svg')) {
    throw new Error('写真などの画像ファイルを選んでください。SVGは使用できません。');
  }
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await file.arrayBuffer()); }
  catch { throw new Error('画像ファイルを読み込めませんでした。もう一度選んでください。'); }
  // Some mobile file pickers omit the MIME. Trust raster signatures instead of a filename or MIME alone.
  const knownRaster = (bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG') ||
    (bytes[0] === 0xff && bytes[1] === 0xd8) ||
    (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') ||
    ['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6)) || ascii(bytes, 0, 2) === 'BM' ||
    (ascii(bytes, 4, 4) === 'ftyp' &&
      ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis'].includes(ascii(bytes, 8, 4)));
  if (!knownRaster) throw new Error('対応していない画像です。JPEG・PNG・WebPなどの写真を選んでください。');
  // Known raster formats can be rejected before the browser allocates a decoded image.
  let header: RasterMetadata | undefined;
  try { header = readRasterMetadata(bytes); } catch { /* Other browser-supported raster formats may decode. */ }
  if (header && header.width * header.height > MAX_INPUT_PIXELS) {
    throw new Error('画像が大きすぎます。4,000万画素以下の画像を選んでください。');
  }
  let url: string | undefined;
  let canvas: HTMLCanvasElement | undefined;
  try {
    url = URL.createObjectURL(file);
    const image = new Image();
    image.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('画像を開けませんでした。HEICなどの場合はJPEG・PNGへ変換してから選んでください。'));
      image.src = url!;
    });
    const sourceWidth = image.naturalWidth;
    const sourceHeight = image.naturalHeight;
    if (!sourceWidth || !sourceHeight || sourceWidth * sourceHeight > MAX_INPUT_PIXELS) {
      throw new Error('画像が大きすぎるか、読み取れません。4,000万画素以下の画像を選んでください。');
    }
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('この端末では画像を変換できません。');
    context.drawImage(image, 0, 0, width, height);
    for (const mimeType of ['image/webp', 'image/png', 'image/jpeg'] as const) {
      const blob = await encode(canvas, mimeType);
      // Safari may return PNG for an unsupported MIME. Accept only the requested format.
      if (!blob || blob.type !== mimeType || blob.size > MAX_IMAGE_BYTES) continue;
      const prepared: PreparedImage = { blob, mimeType, width, height, byteLength: blob.size };
      await validatePreparedImage(prepared);
      return prepared;
    }
    throw new Error('画像の圧縮に失敗しました。別の画像か、小さい画像を選んでください。');
  } catch (error) {
    if (error instanceof Error && !(error instanceof DOMException)) throw error;
    throw new Error('画像を変換できませんでした。別の画像を選んでください。');
  } finally {
    if (url) URL.revokeObjectURL(url);
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
