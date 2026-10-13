// Saving from the address bar: this app's address in front of a link saves it.
//
//   localhost:8080/https://www.youtube.com/watch?v=_Hkdzzx15PI
//   localhost:8080/www.youtube.com/watch?v=_Hkdzzx15PI
//
// No DOM here, so the node suite can test it (tests/address.test.mjs). The
// server and nginx decide which paths get the app with a rule of their own
// (LINK_PATH in api/server.js, the @link location in web/nginx.conf); the same
// test holds the three together.

// Where a link saved this way goes: the folder for what is not sorted yet.
export const TEMP_FOLDER = 'Temporary';

// The link in an address, or '' when there is none. The query and the hash are
// the link's, not the app's. nginx folds the `//` of `https://` into one; the
// browser does not, but a path that went through something else may, so any
// number of slashes after the scheme is read as two. A host needs a dot: `/x`
// is a path of the app, not a link.
export function linkFromAddress({ pathname = '/', search = '', hash = '' } = {}) {
  const path = pathname.slice(1);
  if (!path || path === 'index.html') return '';
  let url = path.replace(/^(https?):\/*/i, '$1://');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url += search + hash;
  try {
    return new URL(url).hostname.includes('.') ? url : '';
  } catch {
    return '';
  }
}

// Whether two links are the same bookmark. A trailing slash is the only
// difference ignored: anything else may be a different page.
export function sameLink(a, b) {
  const bare = (u) => String(u || '').replace(/\/+$/, '');
  return bare(a) !== '' && bare(a) === bare(b);
}

// The bookmarklet for a given prefix: opens prefix + the page's address in a
// new tab, so the page being saved stays where it is.
export function bookmarklet(prefix) {
  return `javascript:void(open(${JSON.stringify(prefix)}+location.href))`;
}
