import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, shell } from 'electron';
import {
  Alexandria,
  createLogger,
  describeError,
  ensureModel,
  ensureWhisperBinary,
  guessLanguage,
  loadConfig,
  loadDictionary,
  saveConfig,
  saveDictionary,
  TransformersEmbedder,
  vendorDir,
  WindowsSapiSpeaker,
  type AlexandriaConfig,
  type WhisperModel,
  type Item,
  type ItemPatch,
  type ListOptions,
  type PipelineEvent,
} from '@alexandria/core';
import { InAppBrowser } from './browser.js';
import { registerMediaScheme, serveMedia } from './media.js';
import { IPC, type AskRequest, type BrowserBounds, type DeepPartial, type SetupProgress } from '../shared/api.js';

const isDev = !app.isPackaged;

let alexandria: Alexandria | undefined;
let mainWindow: BrowserWindow | undefined;
let inAppBrowser: InAppBrowser | undefined;
const speaker = new WindowsSapiSpeaker();

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
    // Events can still arrive while windows are being torn down.
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
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

  ipcMain.handle(IPC.desktopSourceId, async () => {
    // Loopback audio is only granted alongside a desktop video source, so the
    // renderer needs an id even though it throws the video track away.
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    return sources[0]?.id;
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

  ipcMain.handle(IPC.updateItem, async (_event, id: string, patch: ItemPatch) => {
    const updated = vault().updateItem(id, patch);
    if (updated) {
      broadcast(IPC.changed);
      void drainQueue();
    }
    return updated;
  });

  ipcMain.handle(IPC.retranscribe, async (_event, id: string) => {
    const queued = vault().retranscribe(id);
    if (queued) {
      broadcast(IPC.changed);
      void drainQueue();
    }
    return queued;
  });

  ipcMain.handle(IPC.reorganize, async (_event, id: string) => {
    const queued = vault().reorganize(id);
    if (queued) {
      broadcast(IPC.changed);
      void drainQueue();
    }
    return queued;
  });

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

  ipcMain.handle(IPC.transcribeVoice, async (_event, buffer: ArrayBuffer, extension: string) => {
    // A spoken question is not a capture, so it never enters the vault — the
    // recording lives only as long as the transcription takes.
    const temporary = path.join(os.tmpdir(), `alexandria-voice-${randomBytes(6).toString('hex')}${extension}`);
    fs.writeFileSync(temporary, Buffer.from(buffer));
    try {
      const result = await vault().transcribeOnce(temporary);
      return result.text;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  });

  ipcMain.handle(IPC.speak, async (_event, text: string) => {
    await speaker.speak(text, { language: guessLanguage(text) });
  });
  ipcMain.handle(IPC.stopSpeaking, async () => speaker.stop());

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

  ipcMain.handle(IPC.getConfig, async () => vault().config);

  ipcMain.handle(IPC.setConfig, async (_event, patch: DeepPartial<AlexandriaConfig>) => {
    const current = loadConfig(vault().config.vaultDir);
    const merged: AlexandriaConfig = {
      ...current,
      llm: { ...current.llm, ...patch.llm },
      stt: { ...current.stt, ...patch.stt },
      ingest: { ...current.ingest, ...patch.ingest },
      search: { ...current.search, ...patch.search },
    };
    saveConfig(merged);
    // The running instance holds its own copy, so changes land on restart.
    return merged;
  });

  ipcMain.handle(IPC.getDictionary, async () => loadDictionary(vault().config.vaultDir));

  ipcMain.handle(IPC.setDictionary, async (_event, terms: string[]) => {
    saveDictionary(vault().config.vaultDir, terms);
    return loadDictionary(vault().config.vaultDir);
  });

  ipcMain.handle(IPC.pickFolder, async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled ? undefined : result.filePaths[0];
  });

  ipcMain.handle(IPC.runSetupWhisper, async (event, model: string) => {
    const report = (progress: Omit<SetupProgress, 'stage'>) =>
      event.sender.send(IPC.setupProgress, { stage: 'whisper', ...progress });
    const vendor = vendorDir(vault().config.vaultDir);

    try {
      report({ message: '실행 파일 확인 중…' });
      const binary = await ensureWhisperBinary(vendor, (received, total) =>
        report({ message: '실행 파일 내려받는 중', received, total }),
      );
      if (binary.instructions) {
        report({ message: binary.instructions, error: binary.instructions, done: true });
        return;
      }

      report({ message: `모델 '${model}' 내려받는 중` });
      const modelPath = await ensureModel(vendor, model as WhisperModel, (received, total) =>
        report({ message: `모델 '${model}' 내려받는 중`, received, total }),
      );

      const current = loadConfig(vault().config.vaultDir);
      saveConfig({ ...current, stt: { ...current.stt, binPath: binary.path, modelPath } });
      report({ message: '설치 완료. 앱을 다시 시작하면 적용됩니다.', done: true });
    } catch (error) {
      report({ message: describeError(error), error: describeError(error), done: true });
    }
  });

  ipcMain.handle(IPC.runSetupEmbeddings, async (event, model: string) => {
    const report = (progress: Omit<SetupProgress, 'stage'>) =>
      event.sender.send(IPC.setupProgress, { stage: 'embeddings', ...progress });

    try {
      const current = loadConfig(vault().config.vaultDir);
      const search = { ...current.search, semantic: true, model };
      report({ message: `모델 '${model}' 준비 중` });

      const embedder = new TransformersEmbedder(search, vendorDir(current.vaultDir), (progress) =>
        report({ message: `모델 내려받는 중 ${progress.file}`, received: progress.loaded, total: progress.total }),
      );
      const problem = await embedder.check();
      if (problem) {
        report({ message: problem, error: problem, done: true });
        return;
      }

      saveConfig({ ...current, search });
      report({ message: '설치 완료. 앱을 다시 시작하면 기존 항목이 임베딩됩니다.', done: true });
    } catch (error) {
      report({ message: describeError(error), error: describeError(error), done: true });
    }
  });

  ipcMain.handle(IPC.stats, async () => vault().stats());
  ipcMain.handle(IPC.doctor, async () => vault().doctor());
  ipcMain.handle(IPC.vaultPath, async () => vault().config.vaultDir);
  ipcMain.handle(IPC.revealVault, async () => {
    await shell.openPath(vault().config.vaultDir);
  });

  ipcMain.handle(IPC.revealItemFile, async (_event, relativePath: string) => {
    // showItemInFolder selects the file, which is what "where is my recording?"
    // actually asks for.
    shell.showItemInFolder(path.resolve(vault().config.vaultDir, relativePath));
  });
  ipcMain.handle(IPC.processNow, async () => {
    await drainQueue();
  });
}

// ------------------------------------------------------------------ launch

// Privileged schemes have to be declared before the app is ready.
registerMediaScheme();

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
    serveMedia(alexandria.config.vaultDir);
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
    speaker.stop();
    inAppBrowser?.destroy();
    inAppBrowser = undefined;
    alexandria?.close();
    alexandria = undefined;
  });
}
