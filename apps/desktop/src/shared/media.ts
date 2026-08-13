/** Scheme used to play recordings back from the vault. */
export const MEDIA_SCHEME = 'alx-media';

/**
 * Builds the URL the renderer plays, from an item's vault-relative media path.
 *
 * Kept in `shared` because both the preload bridge and the main-process handler
 * need it, and the preload bundle must not pull in main-process modules.
 */
export function mediaUrl(relativePath: string): string {
  const withoutPrefix = relativePath.replace(/^media\//, '');
  return `${MEDIA_SCHEME}://vault/${encodeURIComponent(withoutPrefix)}`;
}
