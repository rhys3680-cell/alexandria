import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';
import { MEDIA_SCHEME } from '../shared/media.js';

/**
 * Registers the scheme used to play back a recording.
 *
 * The renderer cannot read `file://` — the CSP forbids it, and handing the
 * renderer arbitrary filesystem access would undo the point of the
 * contextBridge. A dedicated scheme serves exactly one directory instead, and
 * `stream: true` is what lets an <audio> element seek rather than buffering the
 * whole file.
 *
 * Must be called before the app is ready.
 */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false },
    },
  ]);
}

/** Serves files from the vault's media directory, and nowhere else. */
export function serveMedia(vaultDir: string): void {
  const mediaRoot = path.resolve(vaultDir, 'media');

  protocol.handle(MEDIA_SCHEME, async (request) => {
    const requested = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '');
    const absolute = path.resolve(mediaRoot, requested);

    // Anything that escapes the media directory is refused outright, so a
    // crafted path cannot turn this into a general file reader.
    const inside = absolute === mediaRoot || absolute.startsWith(mediaRoot + path.sep);
    if (!inside || !fs.existsSync(absolute)) {
      return new Response('not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(absolute).toString());
  });
}
