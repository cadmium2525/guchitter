import { readFile } from 'node:fs/promises';
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { test } from './media-fixtures';

const password = 'test-only backup passphrase 2026';
const visibleButton = (page: Page, name: string) => page.getByRole('button', { name, exact: true }).and(page.locator(':visible')).first();

async function openComposer(page: Page) {
  await visibleButton(page, '愚痴をこぼす').click();
  return page.getByRole('dialog', { name: '愚痴をこぼす', exact: true });
}

async function addText(page: Page, body: string) {
  const composer = await openComposer(page);
  await composer.getByLabel('今の気持ち', { exact: true }).fill(body);
  await composer.getByRole('button', { name: '吐き出す', exact: true }).click();
  await expect(composer).not.toBeVisible();
}

async function photoFile(page: Page) {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 2600; canvas.height = 1300;
    const brush = canvas.getContext('2d')!;
    brush.fillStyle = '#d9a76c'; brush.fillRect(0, 0, 2600, 1300);
    brush.fillStyle = '#527964'; brush.fillRect(200, 200, 1000, 800);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  return { name: 'synthetic-photo.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') };
}

async function addPhoto(page: Page, body: string) {
  const file = await photoFile(page);
  const composer = await openComposer(page);
  if (body) await composer.getByLabel('今の気持ち', { exact: true }).fill(body);
  await composer.getByLabel('添付する画像', { exact: true }).setInputFiles(file);
  await expect(composer.getByAltText('添付画像1のプレビュー', { exact: true })).toBeVisible();
  await expect(composer.getByRole('button', { name: '吐き出す', exact: true })).toBeEnabled();
  await composer.getByRole('button', { name: '吐き出す', exact: true }).click();
  await expect(composer).not.toBeVisible();
  await expect(page.getByAltText('投稿の画像1', { exact: true })).toBeVisible();
}

async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const values = await new Promise<{ posts: { id: string; body: string; tags: string[]; imageIds: string[]; angerCount: string }[]; images: { id: string; postId: string; blob: Blob; width: number; height: number; mimeType: string; byteLength: number }[] }>((resolve, reject) => {
      const open = indexedDB.open('guchitter-local-diary');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const database = open.result;
        const transaction = database.transaction(['posts', 'attachments'], 'readonly');
        const posts = transaction.objectStore('posts').getAll();
        const images = transaction.objectStore('attachments').getAll();
        transaction.oncomplete = () => { database.close(); resolve({ posts: posts.result, images: images.result }); };
        transaction.onabort = () => { database.close(); reject(transaction.error); };
      };
    });
    const images = await Promise.all(values.images.map(async ({ blob, ...image }) => ({
      ...image,
      hash: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), value => value.toString(16).padStart(2, '0')).join(''),
    })));
    return { posts: values.posts, images };
  });
}

function unexpectedRequests(context: BrowserContext, baseURL: string) {
  const found: string[] = [];
  context.on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && (url.origin !== new URL(baseURL).origin || !['GET', 'HEAD'].includes(request.method()))) found.push(`${request.method()} ${url.origin}`);
  });
  return found;
}

test('local photos resize, persist, work offline and are removed with their post', async ({ page, context, baseURL }) => {
  const requests = unexpectedRequests(context, baseURL!);
  await page.goto('./');
  await addPhoto(page, '');
  const saved = await snapshot(page);
  expect(saved.posts).toHaveLength(1);
  expect(saved.posts[0].body).toBe('');
  expect(saved.images).toHaveLength(1);
  expect(saved.images[0]).toMatchObject({ width: 2048, height: 1024, postId: saved.posts[0].id });
  expect(['image/webp', 'image/png', 'image/jpeg']).toContain(saved.images[0].mimeType);
  expect(saved.images[0].byteLength).toBeLessThan(5 * 1024 * 1024);
  await page.getByRole('button', { name: '画像1を拡大', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '画像の拡大表示', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '画像を閉じる', exact: true }).click();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByAltText('投稿の画像1', { exact: true })).toBeVisible();
  await expect.poll(() => page.getByAltText('投稿の画像1', { exact: true }).evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  expect(await snapshot(page)).toEqual(saved);
  await page.screenshot({ path: test.info().outputPath('photo-timeline.png'), fullPage: true });
  const card = page.getByRole('article').first();
  await card.getByRole('button', { name: '投稿のメニュー', exact: true }).click();
  await visibleButton(page, '編集').click();
  const editor = page.getByRole('dialog', { name: 'ひとりごとを編集', exact: true });
  await expect(editor.getByAltText('添付画像1のプレビュー', { exact: true })).toBeVisible();
  await editor.getByLabel('今の気持ち', { exact: true }).fill('写真を整理した日。 #写真');
  await editor.getByRole('button', { name: '添付画像1を外す', exact: true }).click();
  await editor.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect((await snapshot(page)).images).toHaveLength(0);
  // A second photo verifies cascade deletion rather than only edit removal.
  await addPhoto(page, '削除を確認する写真。');
  await page.getByRole('article').first().getByRole('button', { name: '投稿のメニュー', exact: true }).click();
  await visibleButton(page, '削除').click();
  await page.getByRole('dialog', { name: 'このひとりごとを削除しますか？', exact: true }).getByRole('button', { name: '削除する', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).images.length).toBe(0);
  expect((await snapshot(page)).posts).toHaveLength(1);
  await visibleButton(page, 'イライラランキング').click();
  await expect(page.getByText('MY ANGER HALL OF FAME', { exact: true })).toHaveCount(0);
  expect(requests).toEqual([]);
});

test('an encrypted file restores photos and tags without replacing existing diary data', async ({ page, newDiaryContext, baseURL }) => {
  const sourceRequests = unexpectedRequests(page.context(), baseURL!);
  await page.goto('./');
  await addPhoto(page, 'バックアップする写真の記録。 #写真 #日常');
  await addText(page, 'あとで読み返したい記録。 #日常');
  const source = await snapshot(page);
  await visibleButton(page, '設定').click();
  await page.locator('#backup-password').fill(password);
  await page.locator('#backup-confirmation').fill(password);
  await page.getByRole('button', { name: '暗号化ファイルを作る', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ダウンロード', exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#backup-password')).toHaveCount(0);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'ダウンロード', exact: true }).click();
  const download = await downloaded;
  const path = test.info().outputPath(download.suggestedFilename());
  await download.saveAs(path);
  const fileText = await readFile(path, 'utf8');
  const envelope = JSON.parse(fileText);
  expect(envelope).toMatchObject({ format: 'guchitter-backup', formatVersion: 1, schemaVersion: 3, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600000 }, cipher: { name: 'AES-GCM', keyLength: 256, tagLength: 128 } });
  expect(fileText).not.toContain('バックアップする写真');
  expect(fileText).not.toContain(password);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('guchitter-backup-preferences-v1') ?? '{}').lastConfirmedAt)).toBeUndefined();
  await page.getByRole('button', { name: '保存できた', exact: true }).click();
  expect(await page.evaluate(() => Boolean(JSON.parse(localStorage.getItem('guchitter-backup-preferences-v1') ?? '{}').lastConfirmedAt))).toBe(true);
  const target = await newDiaryContext();
  try {
    const targetRequests = unexpectedRequests(target, baseURL!);
    const restored = await target.newPage();
    await restored.goto('./');
    await addText(restored, '今ある日記も大切に。 #保持');
    const original = await snapshot(restored);
    await visibleButton(restored, '設定').click();
    await restored.locator('#restore-file').setInputFiles(path);
    await restored.locator('#restore-password').fill('wrong password');
    await restored.getByRole('button', { name: '復号して内容を確認', exact: true }).click();
    await expect(restored.getByRole('alert')).toContainText('パスワードが違うか');
    expect(await snapshot(restored)).toEqual(original);
    await expect(restored.locator('#restore-password')).toHaveValue('');
    await restored.locator('#restore-password').fill(password);
    await restored.getByRole('button', { name: '復号して内容を確認', exact: true }).click();
    await expect(restored.getByRole('button', { name: '今のデータを残して追加する', exact: true })).toBeVisible();
    expect(await snapshot(restored)).toEqual(original);
    await restored.locator('.backup-restore-preview').screenshot({ path: test.info().outputPath('backup-restore-preview.png') });
    await restored.getByRole('button', { name: '今のデータを残して追加する', exact: true }).click();
    await expect(restored.locator('.backup-settings').getByRole('status')).toContainText('復元しました。');
    const result = await snapshot(restored);
    expect(result.posts).toEqual(expect.arrayContaining([...source.posts, ...original.posts]));
    expect(result.posts).toHaveLength(3);
    expect(result.images).toEqual(source.images);
    // Re-importing the same file skips existing complete posts, including photos.
    await restored.locator('#restore-file').setInputFiles(path);
    await restored.locator('#restore-password').fill(password);
    await restored.getByRole('button', { name: '復号して内容を確認', exact: true }).click();
    await restored.getByRole('button', { name: '今のデータを残して追加する', exact: true }).click();
    await expect(restored.locator('.backup-settings').getByRole('status')).toContainText('投稿0件・画像0枚');
    expect(await snapshot(restored)).toEqual(result);
    expect(await restored.evaluate(pass => Object.values(localStorage).some(value => String(value).includes(pass)), password)).toBe(false);
    await visibleButton(restored, 'タイムライン').click();
    await restored.reload();
    await expect(restored.getByAltText('投稿の画像1', { exact: true })).toBeVisible();
    expect(targetRequests).toEqual([]);
  } finally { await target.close(); }
  expect(sourceRequests).toEqual([]);
});
