import { useEffect, useRef, useState } from 'react';
import { liveQuery } from 'dexie';
import { ImagePlus, X } from 'lucide-react';
import { db } from '../data/database';
import { MAX_IMAGES_PER_POST, prepareImage, type Attachment, type PreparedImage } from '../data/images';
import './images.css';

export type ImageItem = Attachment | PreparedImage;

function useImageUrls(images: readonly ImageItem[]) {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const next = images.map(image => URL.createObjectURL(image.blob));
    setUrls(next);
    return () => next.forEach(url => URL.revokeObjectURL(url));
  }, [images]);
  return urls;
}

export function ImagePicker({ images, onChange, disabled, onBusyChange, onError }: {
  images: ImageItem[];
  onChange(images: ImageItem[]): void;
  disabled: boolean;
  onBusyChange(busy: boolean): void;
  onError(message: string): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const working = useRef(false);
  const [processing, setProcessing] = useState(false);
  const urls = useImageUrls(images);

  async function select(files: File[]) {
    if (disabled || working.current || files.length === 0) return;
    if (images.length + files.length > MAX_IMAGES_PER_POST) {
      onError(`画像は1投稿につき${MAX_IMAGES_PER_POST}枚までです。`);
      return;
    }
    working.current = true;
    setProcessing(true);
    onBusyChange(true);
    try {
      const prepared: PreparedImage[] = [];
      // Decode one photo at a time to limit mobile memory use.
      for (const file of files) prepared.push(await prepareImage(file));
      onChange([...images, ...prepared]);
    } catch (error) {
      onError(error instanceof Error ? error.message : '画像を読み込めませんでした。');
    } finally {
      working.current = false;
      setProcessing(false);
      onBusyChange(false);
    }
  }

  return <div className="image-picker">
    <div className="image-picker-toolbar">
      <button type="button" className="text-button" disabled={disabled || processing || images.length >= MAX_IMAGES_PER_POST} onClick={() => input.current?.click()}><ImagePlus size={20} />画像を添付<span>{images.length}/{MAX_IMAGES_PER_POST}</span></button>
      <input ref={input} type="file" accept="image/*" multiple className="sr-only" aria-label="添付する画像" disabled={disabled || processing} onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; void select(files); }} />
    </div>
    <p className="image-picker-note">画像はこの端末で縮小・変換します。</p>
    {processing && <p className="image-picker-note" role="status">画像を準備しています…</p>}
    {images.length > 0 && <div className="image-previews">{images.map((image, index) => <div className="image-preview" key={urls[index] ?? index}>
      {urls[index] && <img src={urls[index]} alt={`添付画像${index + 1}のプレビュー`} width={image.width} height={image.height} />}
      <span>{image.mimeType === 'image/webp' ? 'WebP' : image.mimeType === 'image/png' ? 'PNG' : 'JPEG'}</span>
      <button type="button" className="image-remove" disabled={disabled || processing} aria-label={`添付画像${index + 1}を外す`} onClick={() => onChange(images.filter((_, position) => position !== index))}><X size={18} /></button>
    </div>)}</div>}
  </div>;
}

export function PostImages({ postId, imageIds }: { postId: string; imageIds: readonly string[] }) {
  const [images, setImages] = useState<Attachment[]>([]);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<number>();
  const dialog = useRef<HTMLDialogElement>(null);
  const urls = useImageUrls(images);
  const key = JSON.stringify(imageIds);
  useEffect(() => {
    setFailed(false);
    const ids = JSON.parse(key) as string[];
    const subscription = liveQuery(() => db.attachments.bulkGet(ids)).subscribe({
      next: values => {
        const attachments = values.filter((value): value is Attachment => Boolean(value && value.postId === postId));
        setImages(attachments);
        setFailed(attachments.length !== ids.length);
      },
      error: () => setFailed(true),
    });
    return () => subscription.unsubscribe();
  }, [postId, key]);
  useEffect(() => {
    if (selected === undefined) return;
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, [selected]);
  return <>
    {images.length > 0 && <div className={`post-images post-images-${images.length}`}>{images.map((image, index) => urls[index] && <button type="button" key={image.id} aria-label={`画像${index + 1}を拡大`} onClick={() => setSelected(index)}><img src={urls[index]} alt={`投稿の画像${index + 1}`} width={image.width} height={image.height} loading="lazy" onError={() => setFailed(true)} /></button>)}</div>}
    {failed && <p className="image-picker-note" role="alert">画像を読み込めませんでした。</p>}
    {selected !== undefined && urls[selected] && <dialog ref={dialog} className="image-viewer" aria-label="画像の拡大表示" onCancel={event => { event.preventDefault(); setSelected(undefined); }}>
      <button type="button" className="image-viewer-close" aria-label="画像を閉じる" onClick={() => setSelected(undefined)}><X size={25} /></button>
      <img src={urls[selected]} alt={`拡大した投稿の画像${selected + 1}`} />
    </dialog>}
  </>;
}
