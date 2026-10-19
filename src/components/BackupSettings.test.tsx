import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptBackup, exportBackup, getRestorePreview, restoreBackup, type VerifiedBackup } from '../data/backup';
import { BackupReminder, BackupSettings } from './BackupSettings';

vi.mock('../data/backup', () => ({ exportBackup: vi.fn(), decryptBackup: vi.fn(), getRestorePreview: vi.fn(), restoreBackup: vi.fn() }));

const password = 'remember-this-password';
const preferencesKey = 'guchitter-backup-preferences-v1';
const snapshot: VerifiedBackup = {
  createdAt: Date.now() - 60_000,
  posts: [{ id: 'saved-post', body: '思い出 #日常', tags: ['日常'], imageIds: [], angerCount: '12', createdAt: 1000, updatedAt: 2000 }],
  attachments: [],
};
const share = vi.fn<Navigator['share']>();
const canShare = vi.fn<Navigator['canShare']>();

beforeEach(() => {
  localStorage.clear();
  vi.mocked(exportBackup).mockReset().mockResolvedValue({ blob: new Blob(['encrypted-bytes'], { type: 'application/json' }), filename: 'guchitter-test.guchitter-backup', postCount: 1, imageCount: 0, createdAt: snapshot.createdAt });
  vi.mocked(decryptBackup).mockReset().mockResolvedValue(snapshot);
  vi.mocked(getRestorePreview).mockReset().mockResolvedValue({ existingPosts: 3, duplicatePosts: 0, conflictingPosts: 0, requiredBytes: 1000, addedPosts: 1, addedImages: 0 });
  vi.mocked(restoreBackup).mockReset().mockResolvedValue({ addedPosts: 1, addedImages: 0, skippedPosts: 0 });
  canShare.mockReset().mockReturnValue(false);
  share.mockReset().mockResolvedValue();
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: canShare });
  Object.defineProperty(navigator, 'share', { configurable: true, value: share });
  vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:encrypted-backup'); static revokeObjectURL = vi.fn(); });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'canShare');
  Reflect.deleteProperty(navigator, 'share');
});

async function prepareExport() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('新しいバックアップのパスワード'), password);
  await user.type(screen.getByLabelText('パスワードをもう一度'), password);
  await user.click(screen.getByRole('button', { name: '暗号化ファイルを作る' }));
  await screen.findByRole('button', { name: 'ダウンロード' });
  return user;
}

async function chooseRestore() {
  const user = userEvent.setup();
  // Files.app can expose a backup by extension with no MIME type.
  const file = new File(['encrypted-backup'], 'guchitter.guchitter-backup');
  await user.upload(screen.getByLabelText('暗号化バックアップファイル'), file);
  await user.type(screen.getByLabelText('このファイルのパスワード'), password);
  await user.click(screen.getByRole('button', { name: '復号して内容を確認' }));
  return user;
}

describe('backup user confirmation boundaries', () => {
  it('prepares an encrypted file without saving, and only records backup after human confirmation', async () => {
    render(<BackupSettings />);
    const user = await prepareExport();
    expect(exportBackup).toHaveBeenCalledWith(password);
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
    expect(localStorage.getItem(preferencesKey)).toBeNull();
    expect(screen.queryByDisplayValue(password)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'ダウンロード' }));
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
    expect(screen.getByRole('status')).toHaveTextContent('ダウンロードを開始しました。ファイルが保存されたか確認してください。');
    expect(localStorage.getItem(preferencesKey)).toBeNull();
    await user.click(screen.getByRole('button', { name: '保存できた' }));
    const preferences = JSON.parse(localStorage.getItem(preferencesKey)!);
    expect(preferences.lastConfirmedAt).toBeGreaterThan(snapshot.createdAt);
    expect(preferences.reminderDays).toBe(7);
    expect(localStorage.getItem(preferencesKey)).not.toContain(password);
    expect(screen.queryByRole('button', { name: 'ダウンロード' })).not.toBeInTheDocument();
  });

  it('treats share cancellation as cancellation without claiming or recording success', async () => {
    canShare.mockReturnValue(true);
    share.mockRejectedValue(new DOMException('cancelled', 'AbortError'));
    render(<BackupSettings />);
    const user = await prepareExport();
    await user.click(screen.getByRole('button', { name: '共有して保存' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('共有をキャンセルしました'));
    expect(localStorage.getItem(preferencesKey)).toBeNull();
    expect(screen.queryByRole('button', { name: '保存できた' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ダウンロード' })).toBeEnabled();
    expect(share).toHaveBeenCalledWith({ files: [expect.any(File)] });
  });

  it('does not prepare a saveable file on encryption failure and clears both passwords', async () => {
    vi.mocked(exportBackup).mockRejectedValue(new Error('暗号化した内容を確認できませんでした。'));
    const onDirtyChange = vi.fn();
    render(<BackupSettings onDirtyChange={onDirtyChange} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('新しいバックアップのパスワード'), password);
    await user.type(screen.getByLabelText('パスワードをもう一度'), password);
    await user.click(screen.getByRole('button', { name: '暗号化ファイルを作る' }));
    await screen.findByRole('alert');
    expect(screen.getByLabelText('新しいバックアップのパスワード')).toHaveValue('');
    expect(screen.getByLabelText('パスワードをもう一度')).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'ダウンロード' })).not.toBeInTheDocument();
    expect(localStorage.getItem(preferencesKey)).toBeNull();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('validates the complete backup before preview and waits for explicit restore confirmation', async () => {
    render(<BackupSettings />);
    const user = await chooseRestore();
    const confirm = await screen.findByRole('button', { name: '今のデータを残して追加する' });
    expect(decryptBackup).toHaveBeenCalledWith(expect.any(File), password);
    expect(getRestorePreview).toHaveBeenCalledWith(snapshot);
    expect(restoreBackup).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue(password)).not.toBeInTheDocument();
    expect(screen.getByText('今ある投稿')).toBeInTheDocument();
    await user.click(confirm);
    await screen.findByText('復元しました。投稿1件・画像0枚を追加しました。');
    expect(restoreBackup).toHaveBeenCalledOnce();
    expect(restoreBackup).toHaveBeenCalledWith(snapshot);
    expect(screen.getByLabelText('このファイルのパスワード')).toHaveValue('');
    expect(screen.getByLabelText('暗号化バックアップファイル')).toHaveValue('');
  });

  it('never writes on wrong password, or when a validated restore is cancelled', async () => {
    vi.mocked(decryptBackup).mockRejectedValueOnce(new Error('パスワードが違うか、ファイルが破損しています。'));
    render(<BackupSettings />);
    const user = await chooseRestore();
    await screen.findByRole('alert');
    expect(getRestorePreview).not.toHaveBeenCalled();
    expect(restoreBackup).not.toHaveBeenCalled();
    expect(screen.getByLabelText('このファイルのパスワード')).toHaveValue('');

    await user.type(screen.getByLabelText('このファイルのパスワード'), password);
    await user.click(screen.getByRole('button', { name: '復号して内容を確認' }));
    await screen.findByRole('button', { name: '今のデータを残して追加する' });
    await user.click(screen.getByRole('button', { name: '復元をやめる' }));
    expect(restoreBackup).not.toHaveBeenCalled();
    expect(screen.getByLabelText('暗号化バックアップファイル')).toHaveValue('');
    expect(screen.getByLabelText('このファイルのパスワード')).toHaveValue('');
  });

  it('keeps work busy and dirty until crypto ends, blocking a second action', async () => {
    let finish: (result: Awaited<ReturnType<typeof exportBackup>>) => void = () => {};
    vi.mocked(exportBackup).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const onBusyChange = vi.fn(); const onDirtyChange = vi.fn();
    const { unmount } = render(<BackupSettings onBusyChange={onBusyChange} onDirtyChange={onDirtyChange} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('新しいバックアップのパスワード'), password);
    await user.type(screen.getByLabelText('パスワードをもう一度'), password);
    await user.click(screen.getByRole('button', { name: '暗号化ファイルを作る' }));
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole('button', { name: '暗号化・確認中…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '復号して内容を確認' })).toBeDisabled();
    expect(screen.getByLabelText('新しいバックアップのパスワード')).toBeDisabled();
    await act(async () => { finish({ blob: new Blob(['ciphertext']), filename: 'guchitter.json', postCount: 1, imageCount: 0, createdAt: snapshot.createdAt }); });
    await screen.findByRole('button', { name: 'ダウンロード' });
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    unmount();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });
});

describe('backup reminder', () => {
  it('starts from the first saved post, respects off, and refreshes when the app becomes visible', () => {
    const realNow = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(realNow);
    render(<BackupReminder hasData oldestPostAt={realNow - 86_400_000} onOpenSettings={vi.fn()} />);
    expect(screen.queryByLabelText('バックアップのお知らせ')).not.toBeInTheDocument();
    now.mockReturnValue(realNow + 7 * 86_400_000);
    fireEvent(document, new Event('visibilitychange'));
    expect(screen.getByLabelText('バックアップのお知らせ')).toBeInTheDocument();
    act(() => { localStorage.setItem(preferencesKey, JSON.stringify({ reminderDays: 0 })); window.dispatchEvent(new Event('storage')); });
    expect(screen.queryByLabelText('バックアップのお知らせ')).not.toBeInTheDocument();
  });
});
