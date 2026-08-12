import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { Briefing, Item, ListOptions, PipelineEvent, RelatedHit, SearchHit } from '@alexandria/core';
import { IPC, type AlexandriaApi, type DoctorCheck, type VaultStats } from '../shared/api.js';

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
