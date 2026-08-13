import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import {
  Alexandria,
  createLogger,
  describeError,
  type Item,
  type ListOptions,
  type PipelineEvent,
} from '@alexandria/core';
import { InAppBrowser } from './browser.js';
import { IPC, type AskRequest, type BrowserBounds } from '../shared/api.js';

const isDev = !app.isPackaged;

let alexandria: Alexandria | undefined;
let mainWindow: BrowserWindow | undefined;
let inAppBrowser: InAppBrowser | undefined;

function browser(): InAppBrowser {
  if (!inAppBrowser) {
    if (!mainWindow) throw new Error('창이 아직 준비되지 않았습니다.');
    inAppBrowser = new InAppBrowser(mainWindow, (state) => broadcast(IPC.browserState, state));
  }
  return inAppBrowser;
}

function vault(): Alexandria {
  if (!alexandria) throw new Error('보관소가 아직 열리지 않았습니다.');
  return alexandria;
}

function broadcast(channel: string, payload?: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload);
  }
}

// --------------------------------------------------------------- queue loop

let working = false;

/**
 * Drains the queue whenever there is something to do. Capture handlers call
 * this directly, and a slow timer catches anything queued by the CLI while the
 * app was open.
 */
async function drainQueue(): Promise<void> {
  if (working || !alexandria) return;
  working = true;
  try {
    while (alexandria.pendingCount() > 0) {
      await alexandria.processPending({
        limit: 1,
        onEvent: (event: PipelineEvent) => {
          broadcast(IPC.pipelineEvent, event);
          if (event.type !== 'job:start') broadcast(IPC.changed);
        },
      });
    }
  } catch (error) {
    console.error('큐 처리 중 오류:', describeError(error));
  } finally {
    working = false;
  }
}

// ------------------------------------------------------------------ window

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 820,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#faf9f7',
    title: 'Alexandria',
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload bundle is ESM, which the sandbox does not load.
      sandbox: false,
    },
  });

  mainWindow.on('ready-to-show', () => mainWindow?.show());

  // External links belong in the user's browser, never in the app frame.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(import.meta.dirname, '../renderer/index.html'));
  }
}

// -------------------------------------------------------------------- ipc

function registerIpc(): void {
  ipcMain.handle(IPC.captureText, async (_event, text: string): Promise<Item> => {
    const item = vault().captureText({ text, source: 'manual' });
    broadcast(IPC.changed);
    void drainQueue();
    return item;
  });

  ipcMain.handle(IPC.captureAudio, async (_event, buffer: ArrayBuffer, extension: string): Promise<Item> => {
    const temporary = path.join(os.tmpdir(), `alexandria-${randomBytes(6).toString('hex')}${extension}`);
    fs.writeFileSync(temporary, Buffer.from(buffer));
    // `move` so the temp file does not linger once it is inside the vault.
    const item = vault().captureAudio({ filePath: temporary, source: 'mic', move: true });
    broadcast(IPC.changed);
    void drainQueue();
    return item;
  });

  ipcMain.handle(IPC.captureFiles, async (_event, paths: string[]): Promise<Item[]> => {
    const captured: Item[] = [];
    for (const filePath of paths) {
      try {
        captured.push(vault().captureFile(filePath, 'file'));
      } catch (error) {
        console.error('수집 실패:', filePath, describeError(error));
      }
    }
    broadcast(IPC.changed);
    void drainQueue();
    return captured;
  });

  ipcMain.handle(IPC.list, async (_event, options?: ListOptions) => vault().list(options));
  ipcMain.handle(IPC.search, async (_event, query: string, limit?: number) => vault().search(query, limit));
  ipcMain.handle(IPC.get, async (_event, id: string) => vault().get(id));

  ipcMain.handle(IPC.remove, async (_event, id: string) => {
    const removed = vault().delete(id);
    if (removed) broadcast(IPC.changed);
    return removed;
  });

  ipcMain.handle(IPC.related, async (_event, id: string, limit?: number) => vault().related(id, limit));

  ipcMain.handle(IPC.browserAttach, async (_event, bounds: BrowserBounds) => browser().attach(bounds));
  ipcMain.handle(IPC.browserDetach, async () => browser().detach());
  ipcMain.handle(IPC.browserNavigate, async (_event, input: string) => browser().navigate(input));
  ipcMain.handle(IPC.browserBack, async () => browser().back());
  ipcMain.handle(IPC.browserForward, async () => browser().forward());
  ipcMain.handle(IPC.browserReload, async () => browser().reload());

  ipcMain.handle(IPC.browserCapture, async () => {
    const page = await browser().capture();
    if (!page.text.trim()) throw new Error('페이지에서 읽을 수 있는 글이 없습니다.');

    // The page title leads so the organize pass has something to work with even
    // when the body is mostly boilerplate.
    const item = vault().captureText({
      text: `# ${page.title}\n\n${page.url}\n\n${page.text}`,
      source: 'web',
      sourceRef: page.url,
    });
    broadcast(IPC.changed);
    void drainQueue();
    return item;
  });

  ipcMain.handle(IPC.ask, async (event, request: AskRequest) => {
    const context = (request.contextIds ?? [])
      .map((id) => vault().get(id))
      .filter((item): item is Item => Boolean(item));

    return vault().ask({
      prompt: request.prompt,
      tools: request.tools,
      context,
      resume: request.resume,
      // Streamed back to the window that asked, so a long answer is readable
      // while it is still being written.
      onText: (text) => event.sender.send(IPC.askChunk, { id: request.id, text }),
    });
  });

  ipcMain.handle(IPC.saveAnswer, async (_event, question: string, answer: string) => {
    const item = vault().saveAnswer(question, answer);
    broadcast(IPC.changed);
    void drainQueue();
    return item;
  });

  ipcMain.handle(IPC.briefing, async (_event, soonDays?: number) =>
    vault().briefing(soonDays === undefined ? undefined : { soonDays }),
  );

  ipcMain.handle(IPC.setTaskDone, async (_event, itemId: string, index: number, done: boolean) => {
    const updated = vault().setTaskDone(itemId, index, done);
    if (updated) broadcast(IPC.changed);
    return updated;
  });

  ipcMain.handle(IPC.stats, async () => vault().stats());
  ipcMain.handle(IPC.doctor, async () => vault().doctor());
  ipcMain.handle(IPC.vaultPath, async () => vault().config.vaultDir);
  ipcMain.handle(IPC.revealVault, async () => {
    await shell.openPath(vault().config.vaultDir);
  });
  ipcMain.handle(IPC.processNow, async () => {
    await drainQueue();
  });
}

// ------------------------------------------------------------------ launch

// A second instance would open the same SQLite file and fight over the queue.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(() => {
    alexandria = Alexandria.open(undefined, { logger: createLogger(isDev ? 'debug' : 'warn') });
    registerIpc();
    createWindow();
    void drainQueue();

    // Picks up work queued by `alx` while the app was already running.
    setInterval(() => void drainQueue(), 5000).unref();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    inAppBrowser?.destroy();
    inAppBrowser = undefined;
    alexandria?.close();
    alexandria = undefined;
  });
}
