export function hardRedirect(url: string) {
  if (typeof window === 'undefined') {
    return;
  }
  window.location.assign(url);
}
