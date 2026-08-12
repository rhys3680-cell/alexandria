/// <reference types="vite/client" />
import type { AlexandriaApi } from '../../shared/api.js';

declare global {
  interface Window {
    alexandria: AlexandriaApi;
  }
}

export {};
