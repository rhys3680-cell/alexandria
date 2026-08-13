import { BrowserWindow, shell, WebContentsView } from 'electron';

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

export interface CapturedPage {
  url: string;
  title: string;
  text: string;
}

const HOME = 'about:blank';

/**
 * An in-app browser built on WebContentsView rather than the deprecated
 * `<webview>` tag.
 *
 * The view is owned by the main process and floats above the renderer, so the
 * React side owns the chrome (URL bar, buttons) and reports where the viewport
 * should sit. Nothing from the app is exposed to the page: no preload, sandbox
 * on, its own session partition.
 */
export class InAppBrowser {
  private view: WebContentsView | undefined;
  private attached = false;

  constructor(
    private readonly window: BrowserWindow,
    private readonly onState: (state: BrowserState) => void,
  ) {}

  private ensure(): WebContentsView {
    if (this.view) return this.view;

    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Cookies and logins persist, so pages behind a sign-in stay usable —
        // which is the whole reason for browsing inside the app rather than
        // fetching the URL.
        partition: 'persist:alexandria-browser',
      },
    });

    const contents = view.webContents;
    // Anything the page tries to pop open goes to the real browser.
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });

    const publish = () => this.onState(this.state());
    contents.on('did-start-loading', publish);
    contents.on('did-stop-loading', publish);
    contents.on('did-navigate', publish);
    contents.on('did-navigate-in-page', publish);
    contents.on('page-title-updated', publish);

    this.view = view;
    return view;
  }

  state(): BrowserState {
    const contents = this.view?.webContents;
    if (!contents) return { url: '', title: '', canGoBack: false, canGoForward: false, loading: false };
    const url = contents.getURL();
    return {
      url: url === HOME ? '' : url,
      title: contents.getTitle(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      loading: contents.isLoading(),
    };
  }

  attach(bounds: BrowserBounds): void {
    const view = this.ensure();
    if (!this.attached) {
      this.window.contentView.addChildView(view);
      this.attached = true;
    }
    view.setBounds(roundBounds(bounds));
    view.setVisible(true);
    this.onState(this.state());
  }

  detach(): void {
    this.view?.setVisible(false);
  }

  /**
   * Starts a navigation and resolves once the page settles.
   *
   * `loadURL`'s own promise is not a reliable signal: it rejects with
   * ERR_ABORTED whenever a redirect supersedes the original request, which is
   * ordinary behaviour on most real sites. The load events are the truth.
   */
  navigate(input: string): Promise<void> {
    const contents = this.ensure().webContents;
    const url = toUrl(input);

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        contents.off('did-finish-load', finish);
        contents.off('did-fail-load', onFail);
        clearTimeout(timer);
        this.onState(this.state());
        resolve();
      };
      const onFail = (_event: unknown, code: number, description: string, failedUrl: string) => {
        // Sub-resource failures also raise this; only the main frame matters.
        if (failedUrl && failedUrl !== url) return;
        if (code === -3) return; // aborted by a redirect we are still following
        this.lastError = `${description} (${code})`;
        finish();
      };
      const timer = setTimeout(finish, 30_000);

      contents.on('did-finish-load', finish);
      contents.on('did-fail-load', onFail);
      this.lastError = undefined;
      void contents.loadURL(url).catch(() => {});
    });
  }

  /** Set when the last navigation failed; surfaced through `state()`. */
  private lastError: string | undefined;

  error(): string | undefined {
    return this.lastError;
  }

  back(): void {
    const history = this.view?.webContents.navigationHistory;
    if (history?.canGoBack()) history.goBack();
  }

  forward(): void {
    const history = this.view?.webContents.navigationHistory;
    if (history?.canGoForward()) history.goForward();
  }

  reload(): void {
    this.view?.webContents.reload();
  }

  /**
   * Pulls the readable text out of the live page.
   *
   * Deliberately reads what is rendered rather than refetching the URL: that is
   * what makes a page behind a login, or one assembled by scripts, capturable
   * at all. It is plain innerText, so layout and images are lost.
   */
  async capture(): Promise<CapturedPage> {
    const contents = this.view?.webContents;
    if (!contents || !contents.getURL() || contents.getURL() === HOME) {
      throw new Error('열려 있는 페이지가 없습니다.');
    }

    const text = (await contents.executeJavaScript(
      `(() => {
        const drop = ['script', 'style', 'noscript', 'nav', 'footer', 'aside'];
        const clone = document.body.cloneNode(true);
        for (const selector of drop) {
          for (const node of clone.querySelectorAll(selector)) node.remove();
        }
        return (clone.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
      })()`,
    )) as string;

    return { url: contents.getURL(), title: contents.getTitle(), text };
  }

  destroy(): void {
    if (this.view && this.attached) this.window.contentView.removeChildView(this.view);
    this.view?.webContents.close();
    this.view = undefined;
    this.attached = false;
  }
}

/** Bare words become a search; anything host-like becomes https. */
export function toUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return HOME;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[\w-]+(\.[\w-]+)+(\/|$|:\d)/.test(trimmed)) return `https://${trimmed}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
}

function roundBounds(bounds: BrowserBounds): BrowserBounds {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  };
}
