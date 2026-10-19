import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { test as base, webkit, type BrowserContext } from '@playwright/test';

type CreateDiaryContext = () => Promise<BrowserContext>;

/** Windows WebKit's temporary contexts cannot store native Blobs in IndexedDB.
 * A fresh normal profile exercises the same persistent storage used by the PWA.
 * Chromium keeps Playwright's standard isolated contexts. */
export const test = base.extend<{ newDiaryContext: CreateDiaryContext }>({
  newDiaryContext: async ({ browser, browserName, baseURL, viewport, userAgent,
    deviceScaleFactor, isMobile, hasTouch, acceptDownloads }, use, testInfo) => {
    const contexts: BrowserContext[] = [];
    const profiles: string[] = [];
    // Keep the native profile short: Windows WebKit's IndexedDB paths fail to
    // open when nested below Playwright's long per-test directory names.
    const scope = resolve(testInfo.project.outputDir);
    const createContext: CreateDiaryContext = async () => {
      const options = { baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, acceptDownloads };
      let context: BrowserContext;
      if (browserName === 'webkit') {
        await mkdir(scope, { recursive: true });
        const prefix = join(scope, 'wk-');
        const profile = await mkdtemp(prefix);
        profiles.push(profile);
        context = await webkit.launchPersistentContext(profile, options);
      } else {
        context = await browser.newContext(options);
      }
      contexts.push(context);
      return context;
    };
    try {
      await use(createContext);
    } finally {
      await Promise.allSettled(contexts.map(context => context.close()));
      for (const profile of profiles) {
        const target = resolve(profile);
        const within = relative(scope, target);
        if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
          throw new Error('Refusing to remove a WebKit profile outside this test output directory.');
        }
        // WebKit releases its service-worker SQLite handles just after close.
        await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    }
  },
  context: async ({ newDiaryContext }, use) => {
    await use(await newDiaryContext());
  },
});
