import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AlertCircle, Download, FileCheck2, LockKeyhole, Share2, Upload, X } from 'lucide-react';
import { decryptBackup, exportBackup, getRestorePreview, restoreBackup, type VerifiedBackup } from '../data/backup';
import './backup.css';

const PREFERENCES_KEY = 'guchitter-backup-preferences-v1';
const PREFERENCES_EVENT = 'guchitter-backup-preferences-change';
type ReminderDays = 7 | 30 | 0;
interface Preferences { reminderDays: ReminderDays; lastConfirmedAt?: number }
const defaultPreferences: Preferences = { reminderDays: 7 };

function readPreferences(): Preferences {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? 'null');
    if (!value || typeof value !== 'object') return defaultPreferences;
    const candidate = value as Record<string, unknown>;
    const reminderDays = candidate.reminderDays === 0 || candidate.reminderDays === 7 || candidate.reminderDays === 30 ? candidate.reminderDays : 7;
    const lastConfirmedAt = typeof candidate.lastConfirmedAt === 'number' && Number.isSafeInteger(candidate.lastConfirmedAt) && candidate.lastConfirmedAt > 0 && !Number.isNaN(new Date(candidate.lastConfirmedAt).getTime()) ? candidate.lastConfirmedAt : undefined;
    return { reminderDays, lastConfirmedAt };
  } catch { return defaultPreferences; }
}

function writePreferences(value: Preferences): void {
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify(value));
  window.dispatchEvent(new Event(PREFERENCES_EVENT));
}

function useBackupPreferences() {
  const [preferences, setPreferences] = useState(readPreferences);
  useEffect(() => {
    const update = () => setPreferences(readPreferences());
    window.addEventListener('storage', update);
    window.addEventListener(PREFERENCES_EVENT, update);
    return () => { window.removeEventListener('storage', update); window.removeEventListener(PREFERENCES_EVENT, update); };
  }, []);
  return preferences;
}

function dateLabel(value: number): string {
  return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function sizeLabel(value: number): string {
  if (value === 0) return '0 KB';
  if (value < 1024 * 1024) return `${Math.max(1, Math.ceil(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function BackupReminder({ hasData, oldestPostAt, onOpenSettings }: { hasData: boolean; oldestPostAt?: number; onOpenSettings: () => void }) {
  const preferences = useBackupPreferences();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== 'hidden') setNow(Date.now()); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  const anchor = preferences.lastConfirmedAt ?? oldestPostAt;
  if (!hasData || !preferences.reminderDays || !anchor || now - anchor < preferences.reminderDays * 86_400_000) return null;
  return <aside className="backup-reminder" aria-label="バックアップのお知らせ">
    <LockKeyhole size={18} aria-hidden="true" />
    <div><strong>思い出のバックアップを。</strong><p>{preferences.lastConfirmedAt ? '前回の保存確認から時間が経っています。' : '日記を端末の外にも残しておきましょう。'}</p></div>
    <button onClick={onOpenSettings}>設定を開く</button>
  </aside>;
}

type PreparedBackup = Awaited<ReturnType<typeof exportBackup>> & { file: File };
type RestorePreview = Awaited<ReturnType<typeof getRestorePreview>>;

export function BackupSettings({ onBusyChange, onDirtyChange }: { onBusyChange?: (busy: boolean) => void; onDirtyChange?: (dirty: boolean) => void }) {
  const preferences = useBackupPreferences();
  const [exportPassword, setExportPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [restorePassword, setRestorePassword] = useState('');
  const [selectedFile, setSelectedFile] = useState<File>();
  const [prepared, setPrepared] = useState<PreparedBackup>();
  const [verified, setVerified] = useState<VerifiedBackup>();
  const [preview, setPreview] = useState<RestorePreview>();
  const [busy, setBusy] = useState<'export' | 'decrypt' | 'restore' | 'share'>();
  const busyRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const restoreButtonRef = useRef<HTMLButtonElement>(null);
  const exportHeadingRef = useRef<HTMLHeadingElement>(null);
  const pendingUrls = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [saveAttempted, setSaveAttempted] = useState(false);
  const [exportError, setExportError] = useState('');
  const [restoreError, setRestoreError] = useState('');
  const [exportStatus, setExportStatus] = useState('');
  const [restoreStatus, setRestoreStatus] = useState('');
  const [preferencesError, setPreferencesError] = useState('');
  const dirty = Boolean(exportPassword || confirmation || restorePassword || selectedFile || prepared || verified || busy);

  useEffect(() => { onBusyChange?.(Boolean(busy)); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => () => {
    for (const [url, timer] of pendingUrls.current) { clearTimeout(timer); URL.revokeObjectURL(url); }
    pendingUrls.current.clear();
  }, []);

  const canShare = useMemo(() => {
    if (!prepared || typeof navigator.canShare !== 'function' || typeof navigator.share !== 'function') return false;
    try { return navigator.canShare({ files: [prepared.file] }); } catch { return false; }
  }, [prepared]);

  function startBusy(value: NonNullable<typeof busy>) {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(value); return true;
  }
  function finishBusy() { busyRef.current = false; setBusy(undefined); }

  async function prepareBackup(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current) return;
    setExportError(''); setExportStatus('');
    if (exportPassword.length < 12) { setExportError('パスワードは12文字以上にしてください。'); return; }
    if (exportPassword !== confirmation) { setExportError('確認用のパスワードが一致しません。'); return; }
    if (!startBusy('export')) return;
    setPrepared(undefined); setSaveAttempted(false);
    try {
      const result = await exportBackup(exportPassword);
      const file = new File([result.blob], result.filename, { type: result.blob.type || 'application/octet-stream' });
      setPrepared({ ...result, file });
      setExportStatus('暗号化と復号の確認ができました。続けてファイルを保存してください。');
    } catch (error) { setExportError(errorMessage(error, 'バックアップを作成できませんでした。')); }
    finally { setExportPassword(''); setConfirmation(''); finishBusy(); }
  }

  function cancelExport() {
    if (busyRef.current) return;
    setExportPassword(''); setConfirmation(''); setPrepared(undefined); setSaveAttempted(false); setExportError(''); setExportStatus('');
    exportHeadingRef.current?.focus();
  }

  function downloadBackup() {
    if (!prepared || busyRef.current) return;
    setExportError(''); setExportStatus('');
    let url: string | undefined;
    try {
      url = URL.createObjectURL(prepared.file);
      const link = document.createElement('a');
      link.href = url; link.download = prepared.filename; link.style.display = 'none';
      document.body.append(link);
      try { link.click(); } finally { link.remove(); }
      const toRevoke = url;
      const timer = setTimeout(() => { URL.revokeObjectURL(toRevoke); pendingUrls.current.delete(toRevoke); }, 60_000);
      pendingUrls.current.set(url, timer);
      setSaveAttempted(true);
      setExportStatus('ダウンロードを開始しました。ファイルが保存されたか確認してください。');
    } catch {
      if (url) URL.revokeObjectURL(url);
      setExportError('ダウンロードを開始できませんでした。もう一度お試しください。');
    }
  }

  async function shareBackup() {
    if (!prepared || !canShare || !startBusy('share')) return;
    setExportError(''); setExportStatus('');
    try {
      await navigator.share({ files: [prepared.file] });
      setSaveAttempted(true);
      setExportStatus('共有操作が完了しました。保存先にファイルがあるか確認してください。');
    } catch (error) {
      if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') setExportStatus('共有をキャンセルしました。ファイルはまだ保存確認されていません。');
      else setExportError('共有できませんでした。ダウンロードから保存することもできます。');
    } finally { finishBusy(); }
  }

  function confirmSaved() {
    if (!prepared || !saveAttempted || busyRef.current) return;
    try {
      writePreferences({ ...readPreferences(), lastConfirmedAt: Date.now() });
      setPrepared(undefined); setSaveAttempted(false); setExportError(''); setPreferencesError('');
      setExportStatus('保存確認を記録しました。パスワードも忘れずに保管してください。');
    } catch { setExportError('保存確認日時を記録できませんでした。保存先にファイルがあることを確認してください。'); }
  }

  function clearRestore(clearMessages = true) {
    if (busyRef.current) return;
    setSelectedFile(undefined); setRestorePassword(''); setVerified(undefined); setPreview(undefined);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (clearMessages) { setRestoreError(''); setRestoreStatus(''); }
  }

  async function checkRestore(event: FormEvent) {
    event.preventDefault();
    if (!selectedFile || !restorePassword || !startBusy('decrypt')) return;
    setRestoreError(''); setRestoreStatus(''); setVerified(undefined); setPreview(undefined);
    try {
      const value = await decryptBackup(selectedFile, restorePassword);
      const summary = await getRestorePreview(value);
      setVerified(value); setPreview(summary);
      setRestoreStatus('復号と整合性の確認ができました。内容を確認してから追加してください。');
      requestAnimationFrame(() => restoreButtonRef.current?.focus());
    } catch (error) { setRestoreError(errorMessage(error, 'ファイルを復号・確認できませんでした。')); }
    finally { setRestorePassword(''); finishBusy(); }
  }

  async function performRestore() {
    if (!verified || !preview || !startBusy('restore')) return;
    setRestoreError(''); setRestoreStatus('');
    try {
      const result = await restoreBackup(verified);
      setRestoreStatus(`復元しました。投稿${result.addedPosts}件・画像${result.addedImages}枚を追加しました。${result.skippedPosts ? `同じ投稿${result.skippedPosts}件は追加していません。` : ''}`);
      setVerified(undefined); setPreview(undefined); setSelectedFile(undefined); setRestorePassword('');
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (error) { setRestoreError(errorMessage(error, '復元できませんでした。今ある日記はそのままです。')); }
    finally { finishBusy(); }
  }

  return <section className="setting-section backup-settings" aria-labelledby="backup-heading">
    <span className="section-kicker">KEEP YOUR MEMORIES</span>
    <h2 id="backup-heading">バックアップと復元</h2>
    <p>投稿・タグ・画像を、パスワードで暗号化した1つのファイルに保存できます。処理はこの端末で行います。</p>
    <div className="backup-note"><LockKeyhole size={18} aria-hidden="true" /><p>パスワードを忘れると復元できません。アプリには保存しないため、別の場所に大切に保管してください。</p></div>

    <div className="backup-panel">
      <h3 ref={exportHeadingRef} tabIndex={-1}>ファイルにバックアップ</h3>
      {!prepared ? <form className="backup-form" onSubmit={event => void prepareBackup(event)}>
        <label htmlFor="backup-password">新しいバックアップのパスワード</label>
        <input id="backup-password" type="password" autoComplete="new-password" minLength={12} required value={exportPassword} onChange={event => setExportPassword(event.target.value)} disabled={Boolean(busy)} aria-describedby="backup-password-help" />
        <p id="backup-password-help" className="backup-help">12文字以上。複数の言葉を組み合わせると覚えやすくなります。</p>
        <label htmlFor="backup-confirmation">パスワードをもう一度</label>
        <input id="backup-confirmation" type="password" autoComplete="new-password" minLength={12} required value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={Boolean(busy)} />
        <div className="backup-actions"><button type="submit" className="primary-button" disabled={Boolean(busy) || !exportPassword || !confirmation}><LockKeyhole size={16} />{busy === 'export' ? '暗号化・確認中…' : '暗号化ファイルを作る'}</button>{(exportPassword || confirmation) && <button type="button" className="secondary-button" onClick={cancelExport} disabled={Boolean(busy)}>入力を消す</button>}</div>
      </form> : <div className="backup-prepared">
        <div className="backup-file"><FileCheck2 size={22} aria-hidden="true" /><div><strong>{prepared.filename}</strong><span>投稿 {prepared.postCount}件 · 画像 {prepared.imageCount}枚 · {sizeLabel(prepared.file.size)}</span><span>{dateLabel(prepared.createdAt)} 時点</span></div></div>
        <div className="backup-actions">{canShare && <button className="primary-button" onClick={() => void shareBackup()} disabled={Boolean(busy)}><Share2 size={16} />{busy === 'share' ? '共有中…' : '共有して保存'}</button>}<button className="secondary-button" onClick={downloadBackup} disabled={Boolean(busy)}><Download size={16} />ダウンロード</button></div>
        <p className="backup-help">iPhoneでは共有メニューの「ファイルに保存」を選べます。ダウンロードした場合は「ファイル」アプリなどで確認してください。</p>
        {saveAttempted && <button className="secondary-button backup-confirm-saved" onClick={confirmSaved} disabled={Boolean(busy)}><FileCheck2 size={16} />保存できた</button>}
        <button className="backup-cancel" onClick={cancelExport} disabled={Boolean(busy)}><X size={15} />作成したファイルを閉じる</button>
      </div>}
      {exportError && <p className="backup-message backup-error" role="alert"><AlertCircle size={16} aria-hidden="true" />{exportError}</p>}
      {exportStatus && <p className="backup-message" role="status">{exportStatus}</p>}
    </div>

    <div className="backup-panel">
      <h3>ファイルから復元</h3>
      <p className="backup-help">今ある日記を残して追加します。同じ投稿は重複せず、内容が異なる投稿は別の投稿として残します。</p>
      {!verified ? <form className="backup-form" onSubmit={event => void checkRestore(event)}>
        <label htmlFor="restore-file">暗号化バックアップファイル</label>
        <input ref={fileInputRef} id="restore-file" type="file" accept=".guchitter-backup,.guchitter,.json,application/json,application/octet-stream" disabled={Boolean(busy)} onChange={event => { setSelectedFile(event.target.files?.[0]); setRestorePassword(''); setVerified(undefined); setPreview(undefined); setRestoreError(''); setRestoreStatus(''); }} />
        <label htmlFor="restore-password">このファイルのパスワード</label>
        <input id="restore-password" type="password" autoComplete="off" required value={restorePassword} onChange={event => setRestorePassword(event.target.value)} disabled={Boolean(busy)} />
        <div className="backup-actions"><button type="submit" className="secondary-button" disabled={Boolean(busy) || !selectedFile || !restorePassword}><Upload size={16} />{busy === 'decrypt' ? '復号・確認中…' : '復号して内容を確認'}</button>{(selectedFile || restorePassword) && <button type="button" className="backup-cancel" onClick={() => clearRestore()} disabled={Boolean(busy)}>選択と入力を消す</button>}</div>
      </form> : preview && <div className="backup-restore-preview">
        <h4>復元する内容</h4>
        <dl><div><dt>作成日時</dt><dd>{dateLabel(verified.createdAt)}</dd></div><div><dt>ファイルの内容</dt><dd>投稿 {verified.posts.length}件 · 画像 {verified.attachments.length}枚</dd></div><div><dt>今ある投稿</dt><dd>{preview.existingPosts}件</dd></div><div><dt>追加する内容</dt><dd>投稿 {preview.addedPosts}件 · 画像 {preview.addedImages}枚</dd></div><div><dt>同じ内容の投稿</dt><dd>{preview.duplicatePosts}件（追加しません）</dd></div><div><dt>同じIDで内容が異なる投稿</dt><dd>{preview.conflictingPosts}件（別の投稿として追加）</dd></div><div><dt>追加データ量の目安</dt><dd>{sizeLabel(preview.requiredBytes)}</dd></div></dl>
        <p className="backup-help">保存領域にはこの目安より余裕が必要です。追加件数は実行時に再確認します。</p>
        <div className="backup-actions"><button ref={restoreButtonRef} className="primary-button" onClick={() => void performRestore()} disabled={Boolean(busy)}>{busy === 'restore' ? '追加しています…' : '今のデータを残して追加する'}</button><button className="secondary-button" onClick={() => clearRestore()} disabled={Boolean(busy)}>復元をやめる</button></div>
      </div>}
      {restoreError && <p className="backup-message backup-error" role="alert"><AlertCircle size={16} aria-hidden="true" />{restoreError}</p>}
      {restoreStatus && <p className="backup-message" role="status">{restoreStatus}</p>}
    </div>

    <div className="backup-reminder-settings"><label htmlFor="backup-reminder-days">バックアップのお知らせ</label><select id="backup-reminder-days" value={preferences.reminderDays} disabled={Boolean(busy)} onChange={event => { try { writePreferences({ ...readPreferences(), reminderDays: Number(event.target.value) as ReminderDays }); setPreferencesError(''); } catch { setPreferencesError('お知らせの設定を保存できませんでした。'); } }}><option value={7}>7日ごと</option><option value={30}>30日ごと</option><option value={0}>オフ</option></select><p className="backup-help">アプリを開いたときにお知らせします。自動保存は行いません。</p><p className="backup-help">最後の保存確認：{preferences.lastConfirmedAt ? dateLabel(preferences.lastConfirmedAt) : 'まだありません'}</p>{preferencesError && <p className="backup-message backup-error" role="alert">{preferencesError}</p>}</div>
  </section>;
}
