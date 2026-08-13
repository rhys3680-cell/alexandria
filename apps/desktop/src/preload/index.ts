import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type {
  AskResult,
  Briefing,
  Item,
  ListOptions,
  PipelineEvent,
  RelatedHit,
  SearchHit,
} from '@alexandria/core';
import {
  IPC,
  type AlexandriaApi,
  type AskChunk,
  type BrowserState,
  type DoctorCheck,
  type VaultStats,
} from '../shared/api.js';

/**
 * Everything crosses the bridge as plain data. The renderer never sees a
 * database handle, a file path it can write to, or Node itself.
 */
const api: AlexandriaApi = {
  captureText: (text) => ipcRenderer.invoke(IPC.captureText, text) as Promise<Item>,
  captureAudio: (buffer, extension) =>
    ipcRenderer.invoke(IPC.captureAudio, buffer, extension) as Promise<Item>,
  captureFiles: (paths) => ipcRenderer.invoke(IPC.captureFiles, paths) as Promise<Item[]>,
  pathForFile: (file) => webUtils.getPathForFile(file),

  list: (options?: ListOptions) => ipcRenderer.invoke(IPC.list, options) as Promise<Item[]>,
  search: (query, limit) => ipcRenderer.invoke(IPC.search, query, limit) as Promise<SearchHit[]>,
  get: (id) => ipcRenderer.invoke(IPC.get, id) as Promise<Item | undefined>,
  remove: (id) => ipcRenderer.invoke(IPC.remove, id) as Promise<boolean>,

  related: (id, limit) => ipcRenderer.invoke(IPC.related, id, limit) as Promise<RelatedHit[]>,

  browserAttach: (bounds) => ipcRenderer.invoke(IPC.browserAttach, bounds) as Promise<void>,
  browserDetach: () => ipcRenderer.invoke(IPC.browserDetach) as Promise<void>,
  browserNavigate: (input) => ipcRenderer.invoke(IPC.browserNavigate, input) as Promise<void>,
  browserBack: () => ipcRenderer.invoke(IPC.browserBack) as Promise<void>,
  browserForward: () => ipcRenderer.invoke(IPC.browserForward) as Promise<void>,
  browserReload: () => ipcRenderer.invoke(IPC.browserReload) as Promise<void>,
  browserCapture: () => ipcRenderer.invoke(IPC.browserCapture) as Promise<Item>,
  onBrowserState: (listener) =>
    subscribe(IPC.browserState, (_event, payload) => listener(payload as BrowserState)),

  ask: (request) => ipcRenderer.invoke(IPC.ask, request) as Promise<AskResult>,
  saveAnswer: (question, answer) => ipcRenderer.invoke(IPC.saveAnswer, question, answer) as Promise<Item>,
  onAskChunk: (listener) => subscribe(IPC.askChunk, (_event, payload) => listener(payload as AskChunk)),
  briefing: (soonDays) => ipcRenderer.invoke(IPC.briefing, soonDays) as Promise<Briefing>,
  setTaskDone: (itemId, index, done) =>
    ipcRenderer.invoke(IPC.setTaskDone, itemId, index, done) as Promise<Item | undefined>,

  stats: () => ipcRenderer.invoke(IPC.stats) as Promise<VaultStats>,
  doctor: () => ipcRenderer.invoke(IPC.doctor) as Promise<DoctorCheck[]>,
  vaultPath: () => ipcRenderer.invoke(IPC.vaultPath) as Promise<string>,
  revealVault: () => ipcRenderer.invoke(IPC.revealVault) as Promise<void>,
  processNow: () => ipcRenderer.invoke(IPC.processNow) as Promise<void>,

  onPipelineEvent: (listener) => subscribe(IPC.pipelineEvent, (_event, payload) => listener(payload as PipelineEvent)),
  onChanged: (listener) => subscribe(IPC.changed, () => listener()),
};

function subscribe(
  channel: string,
  handler: (event: IpcRendererEvent, payload: unknown) => void,
): () => void {
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.off(channel, handler);
  };
}

contextBridge.exposeInMainWorld('alexandria', api);
