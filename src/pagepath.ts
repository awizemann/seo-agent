/**
 * pageToPath — reconcile the two grains the analytics layer joins on:
 * gsc_daily.page is an ABSOLUTE URL (e.g. https://site.com/articles/x/?utm=1)
 * while changes.path / snapshots are site-root PATHS (/articles/x). This maps a
 * page (absolute or already a path) to the canonical path used everywhere else:
 * strip the origin, keep the leading slash, drop query/fragment, and strip a
 * trailing slash except on the root. Pure; unit-tested.
 */
export function pageToPath(page: string, siteUrl: string): string {
  let path: string;
  try {
    // A second arg lets this accept both absolute URLs and bare paths; pathname
    // already excludes query + fragment.
    path = new URL(page, siteUrl).pathname;
  } catch {
    path = String(page ?? '').replace(/[?#].*$/, '');
  }
  if (!path) return '/';
  if (path.length > 1) path = path.replace(/\/+$/, '') || '/';
  return path.startsWith('/') ? path : '/' + path;
}

/**
 * Candidate absolute page URLs for a path, with and without a trailing slash.
 * GSC's page dimension is the canonical URL and carries no query string, so
 * these two forms cover it — a cheap SQL pre-filter; pageToPath still confirms
 * each match so a path that is a prefix of another can't leak in.
 */
export function pageCandidates(path: string, siteUrl: string): string[] {
  const origin = new URL(siteUrl).origin;
  if (path === '/') return [origin + '/', origin];
  const p = '/' + path.replace(/^\/+/, '').replace(/\/+$/, '');
  return [origin + p, origin + p + '/'];
}
