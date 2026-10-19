import { Image, LockKeyhole, Quote, Reply } from 'lucide-react';
import { normalizeTag, stripTagsForDisplay, type Post } from '../data/posts';
import { PostImages } from './Images';

/** One level of content only: a quote never recursively embeds another card. */
export function PostReference({ post, kind, onOpen, showImages = false }: {
  post?: Post;
  kind: 'quote' | 'reply';
  onOpen?(): void;
  showImages?: boolean;
}) {
  const quote = kind === 'quote';
  const label = quote ? '引用元の投稿' : '返信先の投稿';
  const Icon = quote ? Quote : Reply;
  return <section className={`post-reference reference-${kind} ${post ? '' : 'reference-missing'}`} aria-label={label}>
    <div className="reference-caption"><Icon size={14} /><span>{label}</span></div>
    {post ? <>
      <button type="button" className="reference-open" disabled={!onOpen} onClick={onOpen} aria-label={quote ? '引用元を表示' : '返信先を表示'}>
        <span className="reference-author">わたし<LockKeyhole size={11} /><time dateTime={new Date(post.createdAt).toISOString()}>{new Intl.DateTimeFormat('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(post.createdAt)}</time></span>
        {stripTagsForDisplay(post.body) && <span className="reference-body">{stripTagsForDisplay(post.body)}</span>}
        {post.tags.length > 0 && <span className="reference-tags">{post.tags.map(tag => <span key={normalizeTag(tag)}>#{tag}</span>)}</span>}
        {post.imageIds.length > 0 && !showImages && <span className="reference-image-count"><Image size={13} />画像{post.imageIds.length}枚</span>}
      </button>
      {showImages && post.imageIds.length > 0 && <div className="reference-images"><PostImages postId={post.id} imageIds={post.imageIds} /></div>}
    </> : <p>{quote ? '引用元の投稿は削除されています。' : '返信先の投稿は削除されています。'}</p>}
  </section>;
}
