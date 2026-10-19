import { expect, test, type BrowserContext, type Page } from '@playwright/test';

interface StoredPost {
  body: string;
  tags: string[];
  angerCount: string;
}

function visibleButton(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true }).and(page.locator(':visible')).first();
}

function postCard(page: Page, body: string) {
  return page.getByRole('article').filter({ hasText: body });
}

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    content: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
}

async function submitPost(page: Page, body: string) {
  const input = page.getByRole('textbox', { name: '今の気持ち', exact: true });
  await expect(input).toBeEditable();
  await input.fill(body);
  await expect(input).toHaveValue(body);
  const submit = visibleButton(page, '吐き出す');
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(postCard(page, body)).toHaveCount(1);
}

async function storedPosts(page: Page): Promise<StoredPost[]> {
  return page.evaluate(() => new Promise<StoredPost[]>((resolve, reject) => {
    const open = indexedDB.open('guchitter-local-diary');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction('posts', 'readonly');
      const request = transaction.objectStore('posts').getAll();
      request.onsuccess = () => resolve(request.result as StoredPost[]);
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => database.close();
      transaction.onabort = () => {
        database.close();
        reject(transaction.error);
      };
    };
  }));
}

async function waitForOfflineShell(page: Page) {
  await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) throw new Error('Service workers are unavailable.');
    await navigator.serviceWorker.ready;
  });
  // A new registration may take control on the next navigation.
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true);
}

function observeUnexpectedRequests(context: BrowserContext, origin: string) {
  const requests: string[] = [];
  context.on('request', (request) => {
    const url = new URL(request.url());
    if ((url.protocol === 'http:' || url.protocol === 'https:')
      && (url.origin !== origin || !['GET', 'HEAD'].includes(request.method()))) {
      requests.push(`${request.method()} ${request.url()}`);
    }
  });
  return requests;
}

test('a fresh diary persists text, tags, and every anger tap after reload', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'タイムライン', exact: true, includeHidden: true })).toBeAttached();
  await expect(page.getByRole('textbox', { name: '今の気持ち', exact: true })).toBeEditable();
  await expect(page.getByRole('article')).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: test.info().outputPath('timeline-empty.png'), fullPage: true });

  const body = 'また会議が長かった。でも今日は書いて手放す。 #仕事 #日常';
  await submitPost(page, body);
  const card = postCard(page, body);
  const angerButton = card.getByRole('button', { name: 'イライラを1増やす', exact: true });
  for (let tap = 0; tap < 10; tap += 1) await angerButton.click();

  await expect.poll(async () => (await storedPosts(page))[0]?.angerCount).toBe('10');
  await expect(card.getByText('10', { exact: true })).toBeVisible();
  await page.reload();
  await expect(postCard(page, body)).toBeVisible();
  await expect(postCard(page, body).getByText('10', { exact: true })).toBeVisible();
  expect(await storedPosts(page)).toEqual([
    expect.objectContaining({ body, tags: ['仕事', '日常'], angerCount: '10' }),
  ]);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: test.info().outputPath('timeline-populated.png'), fullPage: true });

  // Exercise the same settings from desktop and the emulated bottom navigation.
  await visibleButton(page, '設定').click();
  await visibleButton(page, 'ライト').click();
  const lightBackground = await page.locator('body').evaluate((body) => getComputedStyle(body).backgroundColor);
  await visibleButton(page, 'ダーク').click();
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  const darkBackground = await page.locator('body').evaluate((body) => getComputedStyle(body).backgroundColor);
  expect(darkBackground).not.toBe(lightBackground);
  await expectNoHorizontalOverflow(page);
  await page.reload();
  await expect(postCard(page, body)).toBeVisible();
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  await expect(page.locator('body')).toHaveCSS('background-color', darkBackground);
  await expectNoHorizontalOverflow(page);
});

test('search and ranking find the locally written diary entries', async ({ page }) => {
  await page.goto('./');
  const workBody = '電車も会議もぎゅうぎゅうだった。 #仕事 #日常';
  const otherBody = '買ったアイスが帰り道で溶けた。 #おやつ';
  await submitPost(page, workBody);
  await submitPost(page, otherBody);
  for (let tap = 0; tap < 3; tap += 1) {
    await postCard(page, workBody).getByRole('button', { name: 'イライラを1増やす', exact: true }).click();
  }
  await expect.poll(async () => (await storedPosts(page)).find((post) => post.body === workBody)?.angerCount)
    .toBe('3');

  await visibleButton(page, '検索').click();
  const search = page.getByLabel('日記を検索', { exact: true });
  await search.fill('ぎゅうぎゅう');
  await expect(postCard(page, workBody)).toBeVisible();
  await expect(postCard(page, otherBody)).toHaveCount(0);
  await search.fill('#おやつ');
  await expect(postCard(page, otherBody)).toBeVisible();
  await expect(postCard(page, workBody)).toHaveCount(0);

  await visibleButton(page, 'イライラランキング').click();
  await expect(page.getByRole('article').first()).toContainText(workBody);
  await expect(postCard(page, workBody).getByText('3', { exact: true })).toBeVisible();
});

test('editing updates the stored text and tags, and deletion requires confirmation', async ({ page }) => {
  await page.goto('./');
  const original = '今日は少し疲れた。 #仕事';
  const edited = '今日は少し疲れたけれど、帰り道は楽しかった。 #日常';
  await submitPost(page, original);
  await postCard(page, original).getByRole('button', { name: 'イライラを1増やす', exact: true }).click();
  await expect.poll(async () => (await storedPosts(page))[0]?.angerCount).toBe('1');
  await postCard(page, original).getByRole('button', { name: '投稿のメニュー', exact: true }).click();
  await visibleButton(page, '編集').click();
  const editor = page.getByRole('dialog', { name: 'ひとりごとを編集', exact: true });
  await editor.getByRole('textbox', { name: '今の気持ち', exact: true }).fill(edited);
  await editor.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect.poll(async () => (await storedPosts(page))[0]?.body).toBe(edited);
  await page.reload();
  await expect(postCard(page, edited)).toBeVisible();
  expect(await storedPosts(page)).toEqual([
    expect.objectContaining({ body: edited, tags: ['日常'], angerCount: '1' }),
  ]);

  await postCard(page, edited).getByRole('button', { name: '投稿のメニュー', exact: true }).click();
  await visibleButton(page, '削除').click();
  const confirmation = page.getByRole('dialog', { name: 'このひとりごとを削除しますか？', exact: true });
  await confirmation.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await expect(postCard(page, edited)).toBeVisible();
  expect(await storedPosts(page)).toHaveLength(1);

  await postCard(page, edited).getByRole('button', { name: '投稿のメニュー', exact: true }).click();
  await visibleButton(page, '削除').click();
  await confirmation.getByRole('button', { name: '削除する', exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('article')).toHaveCount(0);
  expect(await storedPosts(page)).toEqual([]);
});

test('the cached production app reopens, reads, and writes while offline without external requests', async ({ page, context, baseURL }) => {
  const unexpectedRequests = observeUnexpectedRequests(context, new URL(baseURL!).origin);
  await page.goto('./');
  const onlineBody = '接続中に書いた、この端末だけの記録。 #日常';
  const offlineBody = '圏外でも吐き出せると少し楽になる。 #オフライン';
  await submitPost(page, onlineBody);
  await waitForOfflineShell(page);

  await context.setOffline(true);
  await page.reload();
  await expect(postCard(page, onlineBody)).toBeVisible();
  await submitPost(page, offlineBody);
  await postCard(page, offlineBody).getByRole('button', { name: 'イライラを1増やす', exact: true }).click();
  await expect.poll(async () => (await storedPosts(page)).find((post) => post.body === offlineBody)?.angerCount)
    .toBe('1');
  await page.reload();
  await expect(postCard(page, onlineBody)).toBeVisible();
  await expect(postCard(page, offlineBody)).toBeVisible();

  // Closing the app tab tests a new navigation, beyond a cached in-memory React view.
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(baseURL!);
  await expect(postCard(reopened, onlineBody)).toBeVisible();
  await expect(postCard(reopened, offlineBody)).toBeVisible();
  expect(await storedPosts(reopened)).toEqual(expect.arrayContaining([
    expect.objectContaining({ body: onlineBody, angerCount: '0' }),
    expect.objectContaining({ body: offlineBody, angerCount: '1' }),
  ]));
  await visibleButton(reopened, '検索').click();
  await reopened.getByLabel('日記を検索', { exact: true }).fill('圏外');
  await expect(postCard(reopened, offlineBody)).toBeVisible();
  await expect(postCard(reopened, onlineBody)).toHaveCount(0);
  expect(unexpectedRequests).toEqual([]);
});

test('the install manifest provides local standalone navigation and valid mobile icons', async ({ page, baseURL }) => {
  await page.goto('./');
  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(manifestHref).toBeTruthy();
  const manifestURL = new URL(manifestHref!, baseURL!);
  const response = await page.request.get(manifestURL.href);
  expect(response.ok()).toBe(true);
  const manifest = await response.json();
  expect(manifest.name).toContain('愚痴ったー');
  expect(manifest.display).toBe('standalone');
  expect(new URL(manifest.start_url, manifestURL).origin).toBe(new URL(baseURL!).origin);
  expect(new URL(manifest.scope, manifestURL).origin).toBe(new URL(baseURL!).origin);
  expect(new URL(manifest.start_url, manifestURL).pathname).toBe(new URL(baseURL!).pathname);
  expect(new URL(manifest.scope, manifestURL).pathname).toBe(new URL(baseURL!).pathname);

  for (const size of [192, 512]) {
    const icon = manifest.icons.find((item: { sizes: string }) => item.sizes.split(' ').includes(`${size}x${size}`));
    expect(icon, `${size}px icon must be present`).toBeTruthy();
    const iconURL = new URL(icon.src, manifestURL);
    expect(iconURL.origin).toBe(new URL(baseURL!).origin);
    const iconResponse = await page.request.get(iconURL.href);
    expect(iconResponse.ok()).toBe(true);
    expect(iconResponse.headers()['content-type']).toContain('image/png');
    const dimensions = await page.evaluate((url) => new Promise<{ width: number; height: number }>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error('The manifest icon could not be decoded.'));
      image.src = url;
    }), iconURL.href);
    expect(dimensions).toEqual({ width: size, height: size });
  }
});
