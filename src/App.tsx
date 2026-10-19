import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { liveQuery } from 'dexie';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { ArrowDownWideNarrow, ArrowUpRight, Check, CheckCheck, ChevronRight, Download, Flame, Hash, Home, Leaf, LockKeyhole, Menu, Monitor, Moon, MoreHorizontal, Pencil, Plus, Search, Settings, ShieldCheck, Sparkles, Sun, Trash2, Trophy, WifiOff, X } from 'lucide-react';
import { compareAnger, createPost, db, deletePost, incrementAnger, incrementPostAnger, normalizeTag, totalAnger, updatePost, type Post } from './data';

type Page = 'timeline' | 'search' | 'ranking' | 'settings';
type Theme = 'light' | 'dark' | 'system';
type InstallEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };
const navItems = [
  { id: 'timeline', label: 'タイムライン', icon: Home },
  { id: 'search', label: '検索', icon: Search },
  { id: 'ranking', label: 'イライラランキング', icon: Flame },
  { id: 'settings', label: '設定', icon: Settings },
] as const;

function numberLabel(value: string | number): string { return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function timeLabel(value: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - value) / 60000));
  if (minutes < 1) return 'たった今';
  if (minutes < 60) return `${minutes}分前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}時間前`;
  return new Intl.DateTimeFormat('ja-JP', { month: 'short', day: 'numeric' }).format(value);
}
function friendlyError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'QuotaExceededError') return '端末の保存容量が足りません。空き容量を確認してください。入力内容は残っています。';
  return '端末への保存に失敗しました。入力内容を確認し、もう一度お試しください。';
}
function getInitialTheme(): Theme {
  try { const value = localStorage.getItem('guchitter-theme'); return value === 'light' || value === 'dark' ? value : 'system'; } catch { return 'system'; }
}

function Brand({ small = false }: { small?: boolean }) {
  return <div className={`brand ${small ? 'brand-small' : ''}`}><span className="brand-mark"><Flame size={25} strokeWidth={2.1} fill="currentColor" /></span><div><span className="brand-name">愚痴ったー<span className="brand-dot">。</span></span>{!small && <span className="brand-caption">ここだけの、ひとりごと。</span>}</div></div>;
}

function SteamArt({ quiet = false }: { quiet?: boolean }) {
  return <svg className={`steam-art ${quiet ? 'quiet-art' : ''}`} viewBox="0 0 180 150" fill="none" aria-hidden="true">
    <ellipse cx="91" cy="134" rx="52" ry="7" fill="currentColor" opacity=".06" />
    <path d="M65 75c-5-21 14-26 10-44M88 70c-5-22 15-26 10-46M112 76c-5-17 12-22 8-36" stroke="currentColor" strokeWidth="3" strokeLinecap="round" opacity=".38" />
    <path d="M46 81h90l-9 39c-2 10-10 15-22 15H76c-12 0-20-6-22-16L46 81Z" fill="currentColor" opacity=".15" />
    <path d="M46 81h90l-9 39c-2 10-10 15-22 15H76c-12 0-20-6-22-16L46 81ZM135 89h8c18 0 15 25-12 24" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" />
    <path d="M78 104c1 3 3 4 5 4m16-4c1 3 3 4 5 4M87 119c3 2 6 2 9 0" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    <path d="m35 47 2-6 2 6 6 2-6 2-2 6-2-6-6-2 6-2Zm111 19 2-5 1 5 5 1-5 2-1 5-2-5-5-2 5-1Z" fill="currentColor" opacity=".55" />
  </svg>;
}

function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => { dialog?.close(); }; }, []);
  return <dialog ref={ref} className="dialog" onCancel={event => { event.preventDefault(); onClose(); }} aria-labelledby="dialog-title"><div className="dialog-head"><h2 id="dialog-title">{title}</h2><button className="icon-button" onClick={onClose} aria-label="閉じる"><X size={21} /></button></div>{children}</dialog>;
}

function PostCard({ post, rank, onTag, onEdit, onDelete, onError }: { post: Post; rank?: number; onTag(tag: string): void; onEdit(post: Post): void; onDelete(post: Post): void; onError(message: string): void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [pulse, setPulse] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [menuOpen]);
  function tap() { setPulse(value => value + 1); void incrementPostAnger(post.id).catch(error => onError(friendlyError(error))); }
  return <article className="post-card" aria-label="日記の投稿">
    {rank !== undefined && <span className={`rank-number rank-${rank}`}>{String(rank).padStart(2, '0')}</span>}
    <div className="avatar"><Flame size={23} strokeWidth={1.7} /></div>
    <div className="post-main">
      <div className="post-head"><span className="post-author">わたし</span><span className="post-private"><LockKeyhole size={11} /> 自分だけ</span><span className="time-dot">·</span><time dateTime={new Date(post.createdAt).toISOString()} title={new Date(post.createdAt).toLocaleString('ja-JP')}>{timeLabel(post.createdAt)}</time><div className="post-menu" ref={menuRef}><button className="icon-button" aria-label="投稿のメニュー" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><MoreHorizontal size={20} /></button>{menuOpen && <div className="dropdown"><button onClick={() => { setMenuOpen(false); onEdit(post); }}><Pencil size={16} />編集</button><button className="danger-text" onClick={() => { setMenuOpen(false); onDelete(post); }}><Trash2 size={16} />削除</button></div>}</div></div>
      <p className="post-body">{post.body}</p>
      {post.tags.length > 0 && <div className="post-tags">{post.tags.map(tag => <button key={normalizeTag(tag)} onClick={() => onTag(tag)}>#{tag}</button>)}</div>}
      <div className="post-footer"><button className={`anger-button ${post.angerCount !== '0' ? 'has-anger' : ''}`} aria-label="イライラを1増やす" onClick={tap}><span key={pulse} className={pulse ? 'flame-pop' : ''}><Flame size={19} fill={post.angerCount !== '0' ? 'currentColor' : 'none'} /></span><span className="anger-value">{numberLabel(post.angerCount)}</span><span className="tap-hint">わかる、あのイライラ</span></button><span className="post-saved"><CheckCheck size={14} />端末に保存済み{post.updatedAt !== post.createdAt && <span className="edited-label"> · 更新あり</span>}</span></div>
    </div>
  </article>;
}

export default function App() {
  const [page, setPage] = useState<Page>('timeline');
  const [clock, setClock] = useState(Date.now());
  const [posts, setPosts] = useState<Post[] | undefined>();
  const [loadError, setLoadError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [body, setBody] = useState('');
  const [initialAnger, setInitialAnger] = useState('0');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ message: string; error: boolean }>();
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const [sort, setSort] = useState('newest');
  const [period, setPeriod] = useState('all');
  const [editing, setEditing] = useState<Post>();
  const [editBody, setEditBody] = useState('');
  const [deleting, setDeleting] = useState<Post>();
  const [mutationBusy, setMutationBusy] = useState(false);
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [online, setOnline] = useState(navigator.onLine);
  const [installEvent, setInstallEvent] = useState<InstallEvent>();
  const [persistent, setPersistent] = useState<boolean | undefined>();
  const [persistenceBusy, setPersistenceBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const allPosts = posts ?? [];
  const composerDisabled = saving || posts === undefined || loadError;
  const dirty = body.length > 0 || initialAnger !== '0' || Boolean(editing && editBody !== editing.body);
  const { needRefresh: [needRefresh], offlineReady: [offlineReady], updateServiceWorker } = useRegisterSW({ onRegisterError() { setNotice({ message: 'オフライン用ファイルの準備に失敗しました。オンラインで再読み込みしてください。', error: true }); } });

  useEffect(() => {
    setLoadError(false);
    const subscription = liveQuery(() => db.posts.orderBy('createdAt').reverse().toArray()).subscribe({ next: setPosts, error: () => { setLoadError(true); } });
    return () => subscription.unsubscribe();
  }, [retry]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { const dark = theme === 'dark' || (theme === 'system' && media.matches); document.documentElement.dataset.theme = dark ? 'dark' : 'light'; document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#191c1b' : '#fbf9f5'); };
    apply(); media.addEventListener('change', apply);
    try { localStorage.setItem('guchitter-theme', theme); } catch { /* A blocked preference store must not block the diary. */ }
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => { if (!notice || notice.error) return; const timeout = window.setTimeout(() => setNotice(undefined), 4200); return () => window.clearTimeout(timeout); }, [notice]);
  useEffect(() => {
    const handleOnline = () => setOnline(navigator.onLine);
    const install = (event: Event) => { event.preventDefault(); setInstallEvent(event as InstallEvent); };
    const installed = () => { setInstallEvent(undefined); };
    window.addEventListener('online', handleOnline); window.addEventListener('offline', handleOnline); window.addEventListener('beforeinstallprompt', install); window.addEventListener('appinstalled', installed);
    void navigator.storage?.persisted?.().then(setPersistent).catch(() => {});
    return () => { window.removeEventListener('online', handleOnline); window.removeEventListener('offline', handleOnline); window.removeEventListener('beforeinstallprompt', install); window.removeEventListener('appinstalled', installed); };
  }, []);
  useEffect(() => { if (!dirty) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty]);

  useEffect(() => {
    const refresh = () => setClock(Date.now());
    const interval = window.setInterval(refresh, 60000);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(interval); document.removeEventListener('visibilitychange', refresh); };
  }, []);

  const stats = useMemo(() => {
    const tags = new Map<string, { label: string; count: number }>();
    for (const post of allPosts) for (const label of post.tags) { const key = normalizeTag(label); tags.set(key, { label: tags.get(key)?.label ?? label, count: (tags.get(key)?.count ?? 0) + 1 }); }
    const dayStart = new Date(clock).setHours(0, 0, 0, 0);
    return { anger: totalAnger(allPosts), today: allPosts.filter(post => post.createdAt >= dayStart).length, tags: Array.from(tags.values()).sort((a, b) => b.count - a.count) };
  }, [posts, clock]);
  const visiblePosts = useMemo(() => {
    let results = allPosts.filter(post => (page !== 'timeline' || period === 'all' || post.createdAt >= new Date(clock).setHours(0, 0, 0, 0)) && (!tag || post.tags.some(value => normalizeTag(value) === normalizeTag(tag))));
    if (page === 'search' && search.trim()) { const terms = search.trim().normalize('NFKC').toLowerCase().split(/\s+/); results = results.filter(post => terms.every(term => term.startsWith('#') || term.startsWith('＃') ? post.tags.some(value => normalizeTag(value) === term.slice(1)) : post.body.normalize('NFKC').toLowerCase().includes(term))); }
    if (page === 'ranking' || sort === 'anger') return [...results].sort((a, b) => compareAnger(b.angerCount, a.angerCount) || b.createdAt - a.createdAt);
    return [...results].sort((a, b) => sort === 'oldest' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt);
  }, [posts, page, search, tag, sort, period, clock]);

  function notify(message: string, error = false) { setNotice({ message, error }); }
  function navigate(next: Page) { setPage(next); setTag(''); setSearch(''); window.scrollTo({ top: 0 }); }
  function compose() { setPage('timeline'); setTag(''); setPeriod('all'); requestAnimationFrame(() => { textareaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); textareaRef.current?.focus({ preventScroll: true }); }); }
  function searchTag(value: string) { setPage('search'); setSearch(''); setTag(value); window.scrollTo({ top: 0 }); }
  function addTag(value = '') { if (composerDisabled) return; setBody(current => `${current}${current && !/\s$/.test(current) ? ' ' : ''}#${value}${value ? ' ' : ''}`); textareaRef.current?.focus(); }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!body.trim() || saving || !posts || loadError) return;
    setSaving(true);
    try { await createPost(body, initialAnger); setBody(''); setInitialAnger('0'); setPeriod('all'); notify('吐き出せました。おつかれさま。'); } catch (error) { notify(friendlyError(error), true); } finally { setSaving(false); }
  }
  async function saveEdit(event: FormEvent) {
    event.preventDefault(); if (!editing || mutationBusy || !editBody.trim()) return;
    setMutationBusy(true);
    try { await updatePost(editing.id, editBody); setEditing(undefined); notify('日記を更新しました。'); } catch (error) { notify(friendlyError(error), true); } finally { setMutationBusy(false); }
  }
  async function confirmDelete() {
    if (!deleting || mutationBusy) return; setMutationBusy(true);
    try { await deletePost(deleting.id); setDeleting(undefined); notify('日記を削除しました。'); } catch (error) { notify(friendlyError(error), true); } finally { setMutationBusy(false); }
  }
  async function requestPersistence() {
    setPersistenceBusy(true);
    try { const granted = await navigator.storage?.persist?.(); setPersistent(granted); notify(granted ? '保存領域の保護が許可されました。' : 'このブラウザでは保護が許可されませんでした。閲覧データの削除にはご注意ください。'); } catch { notify('保存領域の保護を確認できませんでした。', true); } finally { setPersistenceBusy(false); }
  }

  const pageTitle = navItems.find(item => item.id === page)!.label;
  const cards = visiblePosts.map((post, index) => <PostCard key={post.id} post={post} rank={page === 'ranking' ? index + 1 : undefined} onTag={searchTag} onEdit={value => { setEditBody(value.body); setEditing(value); }} onDelete={setDeleting} onError={message => notify(message, true)} />);
  const navigation = (mobile = false) => <nav aria-label={mobile ? '下部ナビゲーション' : 'メインナビゲーション'} className={mobile ? 'bottom-nav' : 'side-nav'}>{navItems.map(({ id, label, icon: Icon }) => <button key={id} aria-label={label} aria-current={page === id ? 'page' : undefined} className={page === id ? 'active' : ''} onClick={() => navigate(id)}><Icon size={mobile ? 23 : 22} strokeWidth={page === id ? 2.3 : 1.8} /><span>{mobile && id === 'ranking' ? 'ランキング' : label}</span>{!mobile && page === id && <span className="nav-dot" />}</button>)}</nav>;

  return <div className="app-shell">
    <aside className="left-sidebar"><button className="brand-button" aria-label="愚痴ったー ホーム" onClick={() => navigate('timeline')}><Brand /></button>{navigation()}<button className="primary-button sidebar-compose" onClick={compose}><Pencil size={18} /><span>愚痴をこぼす</span></button><div className="sidebar-bottom"><span className="private-badge"><LockKeyhole size={13} /> PRIVATE DIARY</span><p>今日のモヤモヤも、<br />いつか笑える思い出に。</p><div className="sidebar-profile"><span className="avatar small-avatar"><Flame size={20} /></span><div><strong>わたしの居場所</strong><span>誰にも見せない日記</span></div><ShieldCheck size={17} /></div></div></aside>
    <main className="main-column" id="main-content">
      <header className="main-header"><div className="mobile-brand"><Brand small /></div><div className="header-title"><h1 ref={headingRef}>{pageTitle}</h1><span>{page === 'timeline' ? 'ためこまずに、ここに置いていこう。' : page === 'search' ? 'あの日の気持ちを、見つける。' : page === 'ranking' ? 'あのときは、本当に腹が立った。' : 'あなたに合った、心地よい場所に。'}</span></div><span className={`connection-badge ${!online ? 'is-offline' : ''}`}>{!online ? <WifiOff size={13} /> : <LockKeyhole size={13} />}<span>{!online ? 'オフライン' : 'この端末だけ'}</span></span></header>
      {page === 'timeline' && <>
        {allPosts.length === 0 && <section className="welcome-panel"><div><span className="eyebrow"><span /> YOUR LITTLE SAFE PLACE</span><h2>ここでは、<br />いい人じゃなくていい。</h2><p>誰にも言えない、ちょっとした本音。<br />ぜんぶ、ここに吐き出していこう。</p></div><SteamArt /><span className="welcome-footnote"><LockKeyhole size={11} /> あなただけの、非公開日記</span></section>}
        <form className="composer" onSubmit={submit}><div className="composer-top"><div className="avatar"><Flame size={24} strokeWidth={1.7} /></div><div className="composer-input"><label className="sr-only" htmlFor="new-post">今の気持ち</label><textarea id="new-post" ref={textareaRef} placeholder="いま、何にモヤモヤしてる？" value={body} onChange={event => setBody(event.target.value)} rows={3} disabled={composerDisabled} /><div className="composer-suggestions"><span>たとえば</span>{['仕事', '人間関係', '日常'].map(value => <button type="button" key={value} disabled={composerDisabled} onClick={() => addTag(value)}>#{value}</button>)}</div></div></div><div className="composer-bottom"><div className="composer-tools"><button type="button" className="icon-button" aria-label="タグをつける" title="タグをつける" disabled={composerDisabled} onClick={() => addTag()}><Hash size={21} /></button><span className="tool-divider" /><button type="button" className="draft-anger" aria-label="投稿前のイライラを1増やす" disabled={composerDisabled} onClick={() => setInitialAnger(incrementAnger(initialAnger))}><Flame size={18} /><span>{numberLabel(initialAnger)}</span></button><span className="draft-label">いまのイライラ</span></div><button className="primary-button submit-post" type="submit" disabled={!body.trim() || saving || !posts || loadError}>{saving ? '保存中…' : '吐き出す'}<ArrowUpRight size={17} /></button></div></form>
      </>}
      {page === 'search' && <section className="search-panel"><div className="search-box"><Search size={20} /><input aria-label="日記を検索" placeholder="言葉や #タグで探す" value={search} onChange={event => setSearch(event.target.value)} /><button className="icon-button" aria-label="検索をクリア" onClick={() => { setSearch(''); setTag(''); }} disabled={!search && !tag}><X size={17} /></button></div><p>複数の言葉で絞り込み。#タグは完全一致で検索します。</p>{stats.tags.length > 0 && <div className="filter-tags">{stats.tags.map(value => <button key={normalizeTag(value.label)} className={tag === value.label ? 'selected' : ''} onClick={() => setTag(tag === value.label ? '' : value.label)}>#{value.label}<span>{value.count}</span></button>)}</div>}</section>}
      {page === 'ranking' && <section className="ranking-banner"><span className="ranking-icon"><Trophy size={27} strokeWidth={1.5} /></span><div><span className="eyebrow">MY ANGER HALL OF FAME</span><h2>いつかの、笑い話のタネ。</h2><p>炎の数が多い順に、あの日を振り返る。</p></div></section>}
      {page !== 'settings' && <>
        <div className="feed-toolbar">{page === 'timeline' ? <div className="feed-tabs"><button className={period === 'all' ? 'selected' : ''} onClick={() => setPeriod('all')}>すべて<span>{allPosts.length}</span></button><button className={period === 'today' ? 'selected' : ''} onClick={() => setPeriod('today')}>今日のひとりごと</button></div> : <span className="result-count">{page === 'search' ? `${visiblePosts.length}件のひとりごと` : `${allPosts.length}件の思い出`}</span>}{page !== 'ranking' && <label className="sort-control"><ArrowDownWideNarrow size={15} /><span className="sr-only">並び順</span><select aria-label="並び順" value={sort} onChange={event => setSort(event.target.value)}><option value="newest">新しい順</option><option value="oldest">古い順</option><option value="anger">イライラ順</option></select></label>}</div>
        {tag && <div className="active-filter">#{tag}<button className="icon-button" onClick={() => setTag('')} aria-label="タグの絞り込みを解除"><X size={14} /></button></div>}
        {loadError ? <div className="empty-state error-state" role="alert"><ShieldCheck size={30} /><h2>日記を読み込めませんでした</h2><p>ブラウザで保存領域が利用できるか確認してください。<br />保存が確認できるまで、投稿は行いません。</p><button className="secondary-button" onClick={() => setRetry(value => value + 1)}>もう一度読み込む</button></div> : posts === undefined ? <div className="loading-state" role="status">日記を開いています…</div> : cards.length ? <div className="feed">{cards}</div> : <section className="empty-state"><span className="empty-icon">{page === 'search' ? <Search size={29} strokeWidth={1.4} /> : page === 'ranking' ? <Flame size={29} strokeWidth={1.4} /> : <Leaf size={29} strokeWidth={1.4} />}</span><h2>{page === 'search' ? 'まだ、その気持ちは見つかりません。' : page === 'ranking' ? 'ここに、あの日のイライラが並びます。' : period === 'today' ? '今日は、どんな一日？' : '最初のひとりごとを、どうぞ。'}</h2><p>{page === 'search' ? '言葉やタグを変えて、もう一度探してみてください。' : page === 'ranking' ? '日記の炎をタップすると、イライラ値が増えます。' : <>うまく書かなくて大丈夫。<br />「なんか疲れた」、それだけでも。</>}</p>{page !== 'search' && <button className="text-button" onClick={compose}>気持ちを書いてみる<ChevronRight size={15} /></button>}</section>}
        <div className="feed-end"><span /><Leaf size={13} /><span /></div><p className="feed-end-caption">ここまで読んだら、ひと息つこう。</p>
      </>}
      {page === 'settings' && <div className="settings-content">
        <section className="setting-section"><span className="section-kicker">APPEARANCE</span><h2>好きな明るさで。</h2><p>夜のひとりごとも、目にやさしく。</p><div className="theme-options">{([{ value: 'light', label: 'ライト', icon: Sun }, { value: 'dark', label: 'ダーク', icon: Moon }, { value: 'system', label: '端末に合わせる', icon: Monitor }] as const).map(({ value, label, icon: Icon }) => <button key={value} className={theme === value ? 'selected' : ''} aria-pressed={theme === value} onClick={() => setTheme(value)}><Icon size={23} /><span>{label}</span>{theme === value && <Check size={14} />}</button>)}</div></section>
        <section className="setting-section"><span className="section-kicker">YOUR DATA</span><h2>日記は、この端末の中に。</h2><div className="setting-info"><ShieldCheck size={22} /><div><strong>外部へ送信しません</strong><p>投稿はこのブラウザのIndexedDBに保存します。アカウント・広告・アクセス解析はありません。</p></div></div><div className="setting-info"><LockKeyhole size={22} /><div><strong>保存について知っておいてほしいこと</strong><p>日記自体は暗号化されていません。この端末を使える人からは閲覧できます。ブラウザの閲覧データ削除や端末の紛失で失われるため、大切な記録の唯一の保管先にはしないでください。</p></div></div><div className="storage-row"><span>保存領域の保護</span><span className={persistent ? 'green-text' : 'muted'}>{persistent ? '許可済み' : '未許可・未対応'}</span></div><button className="secondary-button" onClick={() => void requestPersistence()} disabled={persistent || persistenceBusy || !navigator.storage?.persist}>{persistenceBusy ? '確認中…' : persistent ? '保護が許可されています' : '保存領域の保護をリクエスト'}</button><p className="setting-note">ブラウザによっては許可されません。保護が有効でも、手動で削除したデータは戻せません。</p></section>
        <section className="setting-section"><span className="section-kicker">TAKE IT WITH YOU</span><h2>ホーム画面に、ひとりごとの場所。</h2><p>{offlineReady ? 'オフライン用の準備ができました。' : '初回はオンラインで開き、オフライン用ファイルの準備をお待ちください。'} 通信がなくても投稿・検索・閲覧ができます。</p>{installEvent ? <button className="secondary-button" onClick={async () => { try { await installEvent.prompt(); await installEvent.userChoice; setInstallEvent(undefined); } catch { notify('ブラウザのメニューからホーム画面に追加してください。'); } }}><Download size={16} />ホーム画面に追加</button> : <div className="install-guide"><strong>iPhone / Safari</strong><p>共有メニュー →「ホーム画面に追加」</p><strong>Android / Chrome</strong><p>メニュー →「ホーム画面に追加」または「アプリをインストール」</p></div>}</section>
        <section className="setting-section upcoming"><span className="section-kicker">COMING NEXT</span><h2>少しずつ、育てています。</h2><p>画像添付・端末内圧縮、暗号化バックアップと安全な復元は、次の開発段階で追加します。現在はバックアップできません。</p><span className="version-badge">v0.1.0 · はじまりのバージョン</span></section>
      </div>}
    </main>
    <aside className="right-sidebar"><div className="privacy-label"><span className="status-dot" /><LockKeyhole size={12} />誰にも見せない、わたしの場所</div><section className="stats-panel"><div className="panel-heading"><h2>あなたの記録</h2><span>MY LITTLE LOG</span></div><div className="stats-primary"><div><span>吐き出したひとりごと</span><strong>{numberLabel(allPosts.length)}<small>件</small></strong></div><span className="stats-icon"><Pencil size={21} strokeWidth={1.5} /></span></div><div className="stats-bottom"><div><span><Flame size={13} /> 累計イライラ</span><strong>{numberLabel(stats.anger)}<small>回</small></strong></div><div><span><Sun size={13} /> 今日の投稿</span><strong>{numberLabel(stats.today)}<small>件</small></strong></div></div></section><section className="tag-panel"><div className="panel-heading"><h2>よく使うタグ</h2><Hash size={17} /></div>{stats.tags.length ? <div className="sidebar-tags">{stats.tags.slice(0, 8).map(value => <button key={normalizeTag(value.label)} onClick={() => searchTag(value.label)}>#{value.label}<span>{value.count}</span></button>)}</div> : <p className="muted tag-empty">あなたの気持ちに、目印を。<br />投稿に #タグ をつけてみよう。</p>}</section><section className="breather-card"><div className="breather-top"><Leaf size={15} /><span>ひと息メモ</span><span>01</span></div><SteamArt quiet /><h2>怒った日も、<br />ちゃんと生きた日。</h2><p>書いて、少しだけ手放して。<br />あとは、あったかいものでも。</p><span className="breather-line" /></section><div className="right-footer"><LockKeyhole size={13} /><p>気持ちはサーバーに送りません。<br />あなたの端末に、そっと保存します。</p></div><span className="made-for-you">余白を、こころに。<span>愚痴ったー © 2026</span></span></aside>
    {navigation(true)}<button className="floating-compose" onClick={compose} aria-label="愚痴をこぼす"><Plus size={26} /></button>
    {notice && <div className={`toast ${notice.error ? 'toast-error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <WifiOff size={18} /> : <Check size={18} />}<span>{notice.message}</span><button aria-label="通知を閉じる" className="icon-button" onClick={() => setNotice(undefined)}><X size={16} /></button></div>}
    {needRefresh && <div className="update-banner"><span>新しいバージョンを使えます。{dirty ? '下書きを保存してから更新できます。' : ''}</span><button disabled={dirty || saving || mutationBusy} onClick={() => void updateServiceWorker(true)}>更新する</button></div>}
    {editing && <Dialog title="ひとりごとを編集" onClose={() => { if (!mutationBusy) { if (editBody === editing.body || window.confirm('編集内容を破棄して閉じますか？')) setEditing(undefined); } }}><form onSubmit={saveEdit}><label className="sr-only" htmlFor="edit-post">今の気持ち</label><textarea ref={editRef} id="edit-post" className="edit-textarea" value={editBody} onChange={event => setEditBody(event.target.value)} rows={6} disabled={mutationBusy} autoFocus /><p className="setting-note">投稿日時とイライラ値はそのまま。タグも更新されます。</p><div className="dialog-actions"><button type="submit" className="primary-button" disabled={mutationBusy || !editBody.trim()}>{mutationBusy ? '保存中…' : '保存する'}<Check size={17} /></button></div></form></Dialog>}
    {deleting && <Dialog title="このひとりごとを削除しますか？" onClose={() => { if (!mutationBusy) setDeleting(undefined); }}><p className="delete-explanation">削除した日記は元に戻せません。</p><blockquote className="delete-preview">{deleting.body}</blockquote><div className="dialog-actions"><button className="secondary-button" disabled={mutationBusy} onClick={() => setDeleting(undefined)}>キャンセル</button><button className="danger-button" disabled={mutationBusy} onClick={() => void confirmDelete()}>{mutationBusy ? '削除中…' : '削除する'}</button></div></Dialog>}
  </div>;
}
