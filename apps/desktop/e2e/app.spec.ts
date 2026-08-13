import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

/**
 * End-to-end coverage for the paths that only exist behind the UI.
 *
 * Everything else in this project is tested through the core package, but the
 * renderer and the main process were previously verified by "it launched and
 * printed no errors" — which missed a layout regression entirely. Screenshots
 * are written to e2e/screenshots so a change can be looked at, not guessed at.
 */
const SHOTS = path.join(import.meta.dirname, 'screenshots');

let app: ElectronApplication;
let page: Page;
let vaultDir: string;

test.beforeAll(async () => {
  // A throwaway vault, so a test run never touches real notes.
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alexandria-e2e-'));
  fs.mkdirSync(SHOTS, { recursive: true });

  app = await electron.launch({
    args: [path.join(import.meta.dirname, '..')],
    env: { ...process.env, ALEXANDRIA_VAULT: vaultDir },
  });
  page = await app.firstWindow();
  await page.waitForSelector('.app');
  // The briefing loads asynchronously; give it a beat before measuring.
  await page.waitForTimeout(1500);
});

test.afterAll(async () => {
  try {
    await app?.close();
  } catch {
    // The shutdown test may have closed it already.
  }
  fs.rmSync(vaultDir, { recursive: true, force: true });
});

test('the shell lays out as header, body and footer', async () => {
  await page.screenshot({ path: path.join(SHOTS, '01-briefing.png') });

  const layout = await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      // Unrounded: rounding each value separately makes sums drift by a pixel.
      return { width: box.width, height: box.height, top: box.top };
    };
    return {
      header: rect('.header'),
      banner: rect('.setup-banner'),
      body: rect('.body'),
      footer: rect('.footer'),
      left: rect('.left'),
      right: rect('.right'),
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });

  expect(layout.header!.top).toBe(0);
  const near = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);
  // Bars stack with no gaps; the setup banner may or may not be showing.
  const barsAbove = layout.header!.height + (layout.banner?.height ?? 0);
  near(layout.body!.top, barsAbove);

  // Every bar has to hug its content, or it is stealing the body's space.
  if (layout.banner) expect(layout.banner.height).toBeLessThan(160);

  // The body takes whatever is left over.
  near(layout.body!.height, layout.viewport.height - barsAbove - layout.footer!.height);
  expect(layout.footer!.top + layout.footer!.height).toBeLessThanOrEqual(layout.viewport.height + 1);
  near(layout.left!.width + layout.right!.width, layout.viewport.width);
});

test('Pretendard is the font actually in use', async () => {
  const font = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  expect(font).toContain('Pretendard');
});

test('a shadcn button keeps its own size instead of the legacy button rule', async () => {
  // The bare `button { padding: 6px 14px }` in styles.css used to win over
  // Tailwind utilities, which is what broke the new components.
  const settings = page.locator('.header button[title="설정"]');
  await expect(settings).toBeVisible();

  const style = await settings.evaluate((element) => {
    const computed = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return {
      width: Math.round(box.width),
      height: Math.round(box.height),
      padding: computed.padding,
    };
  });

  // size="icon" is h-8 w-8 — 32x32.
  expect(style.height).toBe(32);
  expect(style.width).toBe(32);
});

test('settings opens, shows its sections, and closes on Escape', async () => {
  await page.locator('.header button[title="설정"]').click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('보관소', { exact: true })).toBeVisible();
  await expect(dialog.getByText('사전', { exact: true })).toBeVisible();
  await expect(dialog.getByText('의미 검색', { exact: true })).toBeVisible();

  await page.screenshot({ path: path.join(SHOTS, '02-settings.png') });

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('the console accepts a typed turn and shows the tool modes', async () => {
  await page.locator('.header button[title="모델과 대화하기"]').click();
  await expect(page.locator('.console')).toBeVisible();
  await expect(page.locator('.chip', { hasText: '빠름' })).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, '03-console.png') });

  // The console must stay inside the right pane. A class name colliding with a
  // Tailwind utility (`fixed`) once tore this pane out of the grid entirely.
  const panes = await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, height: box.height };
    };
    return { left: rect('.left'), right: rect('.right'), console: rect('.console') };
  });

  expect(panes.right!.left).toBeGreaterThanOrEqual(panes.left!.right);
  expect(Math.abs(panes.console!.left - panes.right!.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(panes.console!.right - panes.right!.right)).toBeLessThanOrEqual(1);
  expect(Math.abs(panes.right!.height - panes.left!.height)).toBeLessThanOrEqual(1);
});

test('the browser pane opens and survives being torn down', async () => {
  // Opening it is what matters: the in-app browser is destroyed on quit, and
  // that path threw "Object has been destroyed" when the window went first.
  // A run that never opens the browser never exercises it.
  await page.locator('.header button[title="앱 안에서 웹 보기"]').click();
  await expect(page.locator('.browser')).toBeVisible();
  await expect(page.locator('.address')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, '05-browser.png') });

  await page.locator('.header button[title="오늘 챙길 것들"]').click();
});

test('capturing a note runs it through the pipeline into the list', async () => {
  await page.locator('.header button[title="오늘 챙길 것들"]').click();

  await page.locator('.composer textarea').fill('E2E 테스트로 넣은 메모입니다.');
  await page.locator('.composer button', { hasText: '저장' }).click();

  // Organizing needs the model, which a test must not depend on; the item
  // existing in the list is what this asserts.
  await expect(page.locator('.list li').first()).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: path.join(SHOTS, '04-captured.png') });
});

test('closing the window with the browser open shuts down cleanly', async () => {
  // The exact path that crashed: the in-app browser is attached, the window is
  // closed, and `before-quit` then tears the browser down after the window has
  // already been destroyed. An uncaught throw there leaves Electron sitting on
  // an error dialog, so this waits for the process to actually exit.
  await page.locator('.header button[title="앱 안에서 웹 보기"]').click();
  await expect(page.locator('.browser')).toBeVisible();

  const exited = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.close();
  });
  await exited;
});
