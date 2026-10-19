import { expect, test, type BrowserContext, type Page } from '@playwright/test';

interface StoredPost {
  id: string;
  body: string;
  tags: string[];
  angerCount: string;
  quotePostId?: string;
  replyToId?: string;
}

function visibleButton(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true }).and(page.locator(':visible')).first();
}

function postCard(page: Page, prose: string) {
  // A quoted source has its own preview, never another editable post body.
  return page.getByRole('article', { name: '日記の投稿', exact: true }).filter({
    has: page.locator('.post-body').filter({ hasText: new RegExp(`^${prose.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }),
  });
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
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
  }));
}

async function compose(page: Page, prose: string, kind?: 'quote' | 'reply', source?: string, tag?: string) {
  const title = kind === 'quote' ? '引用して投稿' : kind === 'reply' ? '返信する' : '愚痴をこぼす';
  if (kind) await postCard(page, source!).getByRole('button', { name: kind === 'quote' ? '引用する' : '返信する', exact: true }).click();
  else await visibleButton(page, '愚痴をこぼす').click();
  const dialog = page.getByRole('dialog', { name: title, exact: true });
  await expect(dialog).toBeVisible();
  if (kind) await expect(dialog.getByRole('region', { name: kind === 'quote' ? '引用元の投稿' : '返信先の投稿', exact: true })).toContainText(source!);
  await dialog.getByRole('textbox', { name: '今の気持ち', exact: true }).fill(`${prose}${tag ? ` #${tag}` : ''}`);
  await dialog.getByRole('button', { name: '吐き出す', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await visibleButton(page, 'タイムライン').click();
  await expect(postCard(page, prose)).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth)).toBeLessThanOrEqual(1);
}

async function waitForOfflineShell(page: Page) {
  await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) throw new Error('Service workers are unavailable.');
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
}

function observeUnexpectedRequests(context: BrowserContext, origin: string) {
  const requests: string[] = [];
  context.on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol)
      && (url.origin !== origin || !['GET', 'HEAD'].includes(request.method()))) requests.push(`${request.method()} ${request.url()}`);
  });
  return requests;
}

test('a quote keeps independent prose, tags, and anger and opens its original thread', async ({ page }) => {
  await page.goto('./');
  const original = 'あの会議、本当に長かった。';
  const quote = 'いまなら、少し笑って振り返れる。';
  await compose(page, original, undefined, undefined, '仕事');
  await compose(page, quote, 'quote', original, '思い出');
  const card = postCard(page, quote);
  await expect(card.locator('.post-body')).toHaveText(quote);
  await expect(card.locator('.post-tags').getByRole('button')).toHaveText(['#思い出']);
  const source = card.getByRole('region', { name: '引用元の投稿', exact: true });
  await expect(source).toContainText(original);
  await card.getByRole('button', { name: 'イライラを1増やす', exact: true }).click();
  await expect.poll(async () => (await storedPosts(page)).find(post => post.body.startsWith(quote))?.angerCount).toBe('1');
  const posts = await storedPosts(page);
  const parent = posts.find(post => post.body.startsWith(original))!;
  expect(posts.find(post => post.body.startsWith(quote))).toEqual(expect.objectContaining({
    body: `${quote} #思い出`, tags: ['思い出'], quotePostId: parent.id, angerCount: '1',
  }));
  expect(parent.angerCount).toBe('0');
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path: test.info().outputPath('quote-timeline.png'), fullPage: true });

  await source.getByRole('button', { name: '引用元を表示', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'スレッド', exact: true })).toBeVisible();
  await expect(postCard(page, original)).toBeVisible();
  await expect(postCard(page, quote)).toHaveCount(0);
  await visibleButton(page, '戻る').click();
  await expect(postCard(page, quote)).toBeVisible();
  await page.reload();
  await expect(postCard(page, quote).getByRole('region', { name: '引用元の投稿', exact: true })).toContainText(original);
  await expect(postCard(page, quote).getByText('1', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('replies form a chronological tree with nested children after reopening the diary', async ({ page }) => {
  await page.goto('./');
  const root = '今日のモヤモヤ、ここから整理する。';
  const first = 'まずは深呼吸した。';
  const nested = '散歩したら、少し落ち着いた。';
  const sibling = '帰ってから好きなお茶を飲む。';
  await compose(page, root);
  await compose(page, first, 'reply', root);
  await compose(page, nested, 'reply', first, 'ひと休み');
  await compose(page, sibling, 'reply', root);
  const posts = await storedPosts(page);
  const rootPost = posts.find(post => post.body === root)!;
  const firstPost = posts.find(post => post.body === first)!;
  expect(posts.find(post => post.body.startsWith(nested))?.replyToId).toBe(firstPost.id);
  expect(posts.find(post => post.body === sibling)?.replyToId).toBe(rootPost.id);
  expect(firstPost.replyToId).toBe(rootPost.id);

  await page.reload();
  await postCard(page, nested).getByRole('button', { name: 'スレッドを表示', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'スレッド', exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: '日記の投稿', exact: true }).locator('.post-body')).toHaveText([root, first, nested, sibling]);
  await expect(page.locator('[data-thread-depth]')).toHaveCount(4);
  expect(await page.locator('[data-thread-depth]').evaluateAll(nodes => nodes.map(node => Number(node.getAttribute('data-thread-depth'))))).toEqual([0, 1, 2, 1]);
  await expect(postCard(page, nested).locator('.post-tags').getByRole('button')).toHaveText(['#ひと休み']);
  await expectNoHorizontalOverflow(page);
  // The selected nested reply is scrolled into view on open. Capture from the
  // top so WebKit's full-page image places the sticky header at its true origin.
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path: test.info().outputPath('reply-tree.png'), fullPage: true });
  await visibleButton(page, '戻る').click();
  await expect(postCard(page, sibling)).toBeVisible();
});

test('quotes and replies work offline and survive deletion of their source', async ({ page, context, baseURL }) => {
  const unexpectedRequests = observeUnexpectedRequests(context, new URL(baseURL!).origin);
  await page.goto('./');
  const root = 'ここに書けたら、今日はそれで十分。';
  const quote = '昔の自分に、おつかれさま。';
  const reply = 'もうひとつ、あとから思い出した。';
  await compose(page, root);
  const rootId = (await storedPosts(page)).find(post => post.body === root)!.id;
  await waitForOfflineShell(page);
  await context.setOffline(true);
  await page.reload();
  await compose(page, quote, 'quote', root);
  await compose(page, reply, 'reply', root);
  await page.reload();
  await expect(postCard(page, quote).getByRole('region', { name: '引用元の投稿', exact: true })).toContainText(root);
  await postCard(page, root).getByRole('button', { name: '投稿のメニュー', exact: true }).click();
  await visibleButton(page, '削除').click();
  await page.getByRole('dialog', { name: 'このひとりごとを削除しますか？', exact: true }).getByRole('button', { name: '削除する', exact: true }).click();
  await expect(postCard(page, root)).toHaveCount(0);
  await expect(postCard(page, quote)).toBeVisible();
  await expect(postCard(page, reply)).toBeVisible();
  await page.reload();
  const posts = await storedPosts(page);
  expect(posts).toHaveLength(2);
  expect(posts.find(post => post.body === quote)?.quotePostId).toBe(rootId);
  expect(posts.find(post => post.body === reply)?.replyToId).toBe(rootId);
  await expect(postCard(page, quote).getByRole('region', { name: '引用元の投稿', exact: true })).toContainText('引用元の投稿は削除されています。');
  await postCard(page, reply).getByRole('button', { name: 'スレッドを表示', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'スレッド', exact: true })).toBeVisible();
  await expect(page.getByText('元の投稿は削除されています。', { exact: true })).toBeVisible();
  await expect(postCard(page, reply)).toBeVisible();
  await expect(postCard(page, quote)).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  expect(unexpectedRequests).toEqual([]);
});

test('closing quote and reply composers preserves the target alongside the unsent draft', async ({ page }) => {
  await page.goto('./');
  const root = '書きかけでも、あとで戻ってこられる。';
  const quote = '引用しながら、あの日の自分に返したい言葉。';
  const reply = '続きを書くのは、明日でもいい。';
  await compose(page, root);
  await postCard(page, root).getByRole('button', { name: '引用する', exact: true }).click();
  const quoteDialog = page.getByRole('dialog', { name: '引用して投稿', exact: true });
  await quoteDialog.getByRole('textbox', { name: '今の気持ち', exact: true }).fill(quote);
  await quoteDialog.getByRole('button', { name: '投稿前のイライラを1増やす', exact: true }).click();
  await quoteDialog.getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(quoteDialog).not.toBeVisible();
  expect(await storedPosts(page)).toHaveLength(1);
  await visibleButton(page, '愚痴をこぼす').click();
  await expect(quoteDialog).toBeVisible();
  await expect(quoteDialog.getByRole('region', { name: '引用元の投稿', exact: true })).toContainText(root);
  await expect(quoteDialog.getByRole('textbox', { name: '今の気持ち', exact: true })).toHaveValue(quote);
  await expect(quoteDialog.getByRole('button', { name: '投稿前のイライラを1増やす', exact: true })).toContainText('1');
  await quoteDialog.getByRole('button', { name: '吐き出す', exact: true }).click();
  await expect(quoteDialog).not.toBeVisible();
  await expect(postCard(page, quote)).toBeVisible();

  await postCard(page, root).getByRole('button', { name: '返信する', exact: true }).click();
  const replyDialog = page.getByRole('dialog', { name: '返信する', exact: true });
  await replyDialog.getByRole('textbox', { name: '今の気持ち', exact: true }).fill(reply);
  await replyDialog.getByRole('textbox', { name: '今の気持ち', exact: true }).press('Escape');
  await expect(replyDialog).not.toBeVisible();
  expect(await storedPosts(page)).toHaveLength(2);
  await visibleButton(page, '愚痴をこぼす').click();
  await expect(replyDialog).toBeVisible();
  await expect(replyDialog.getByRole('region', { name: '返信先の投稿', exact: true })).toContainText(root);
  await expect(replyDialog.getByRole('textbox', { name: '今の気持ち', exact: true })).toHaveValue(reply);
  await replyDialog.getByRole('button', { name: '吐き出す', exact: true }).click();
  await expect(replyDialog).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'スレッド', exact: true })).toBeVisible();
  await expect(postCard(page, root)).toBeVisible();
  await expect(postCard(page, reply)).toBeVisible();
  await expect(postCard(page, quote)).toHaveCount(0);
  const posts = await storedPosts(page);
  const rootId = posts.find(post => post.body === root)!.id;
  expect(posts.find(post => post.body === quote)).toEqual(expect.objectContaining({ quotePostId: rootId, angerCount: '1' }));
  expect(posts.find(post => post.body === reply)).toEqual(expect.objectContaining({ replyToId: rootId }));
  await visibleButton(page, 'タイムライン').click();
  await visibleButton(page, '愚痴をこぼす').click();
  const ordinaryComposer = page.getByRole('dialog', { name: '愚痴をこぼす', exact: true });
  await expect(ordinaryComposer).toBeVisible();
  await expect(ordinaryComposer.getByRole('textbox', { name: '今の気持ち', exact: true })).toHaveValue('');
  await expect(ordinaryComposer.getByRole('region', { name: /^(引用元|返信先)の投稿$/ })).toHaveCount(0);
});

test('changing a draft target requires a decision and a deleted source can be detached without losing prose', async ({ page, context, baseURL }) => {
  await page.goto('./');
  const original = '前の気持ちを、もう一度眺める。';
  const other = '別の日の、小さなモヤモヤ。';
  const draft = 'どの投稿への言葉か、あとで考えたい。';
  await compose(page, original);
  await compose(page, other);
  await postCard(page, original).getByRole('button', { name: '引用する', exact: true }).click();
  const quoteDialog = page.getByRole('dialog', { name: '引用して投稿', exact: true });
  await quoteDialog.getByRole('textbox', { name: '今の気持ち', exact: true }).fill(draft);
  await quoteDialog.getByRole('button', { name: '投稿前のイライラを1増やす', exact: true }).click();
  await quoteDialog.getByRole('button', { name: '閉じる', exact: true }).click();

  const cancelPrompt = page.waitForEvent('dialog');
  const cancelledClick = postCard(page, other).getByRole('button', { name: '返信する', exact: true }).click();
  const cancelled = await cancelPrompt;
  expect(cancelled.type()).toBe('confirm');
  expect(cancelled.message()).toContain('書きかけの内容を残したまま');
  await cancelled.dismiss();
  await cancelledClick;
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await visibleButton(page, '愚痴をこぼす').click();
  await expect(quoteDialog).toBeVisible();
  await expect(quoteDialog.getByRole('region', { name: '引用元の投稿', exact: true })).toContainText(original);
  await expect(quoteDialog.getByRole('textbox', { name: '今の気持ち', exact: true })).toHaveValue(draft);
  await quoteDialog.getByRole('button', { name: '閉じる', exact: true }).click();

  const acceptPrompt = page.waitForEvent('dialog');
  const acceptedClick = postCard(page, other).getByRole('button', { name: '返信する', exact: true }).click();
  const accepted = await acceptPrompt;
  expect(accepted.type()).toBe('confirm');
  await accepted.accept();
  await acceptedClick;
  const replyDialog = page.getByRole('dialog', { name: '返信する', exact: true });
  await expect(replyDialog.getByRole('region', { name: '返信先の投稿', exact: true })).toContainText(other);
  await expect(replyDialog.getByRole('textbox', { name: '今の気持ち', exact: true })).toHaveValue(draft);
  await expect(replyDialog.getByRole('button', { name: '投稿前のイライラを1増やす', exact: true })).toContainText('1');

  // The app may be open in another tab: remove the source through that UI while
  // this tab keeps its composer open, rather than manufacturing a database row.
  const anotherTab = await context.newPage();
  await anotherTab.goto(baseURL!);
  await postCard(anotherTab, other).getByRole('button', { name: '投稿のメニュー', exact: true }).click();
  await visibleButton(anotherTab, '削除').click();
  await anotherTab.getByRole('dialog', { name: 'このひとりごとを削除しますか？', exact: true }).getByRole('button', { name: '削除する', exact: true }).click();
  await expect(postCard(anotherTab, other)).toHaveCount(0);
  await anotherTab.close();
  await page.bringToFront();
  await expect(replyDialog.getByRole('region', { name: '返信先の投稿', exact: true })).toContainText('返信先の投稿は削除されています。');
  await replyDialog.getByRole('button', { name: '吐き出す', exact: true }).click();
  await expect(replyDialog.getByRole('alert')).toContainText('引用元・返信先が削除されています。');
  await expect(replyDialog.getByRole('textbox', { name: '今の気持ち', exact: true })).toHaveValue(draft);
  expect(await storedPosts(page)).toHaveLength(1);
  await replyDialog.getByRole('button', { name: '返信をやめる', exact: true }).click();
  const ordinaryComposer = page.getByRole('dialog', { name: '愚痴をこぼす', exact: true });
  await expect(ordinaryComposer.getByRole('region', { name: /^(引用元|返信先)の投稿$/ })).toHaveCount(0);
  await expect(ordinaryComposer.getByRole('textbox', { name: '今の気持ち', exact: true })).toHaveValue(draft);
  await ordinaryComposer.getByRole('button', { name: '吐き出す', exact: true }).click();
  await expect(ordinaryComposer).not.toBeVisible();
  await expect(postCard(page, draft)).toBeVisible();
  const saved = (await storedPosts(page)).find(post => post.body === draft)!;
  expect(saved.angerCount).toBe('1');
  expect(saved.quotePostId).toBeUndefined();
  expect(saved.replyToId).toBeUndefined();
});
