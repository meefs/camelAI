const CONNECTIONS_UI_SEARCH_PARAMS = [
  "selected",
  "success",
  "error",
  "reason",
  "connection",
  "reauth",
] as const;

function stripSearchParams(
  searchParams: URLSearchParams,
  paramsToStrip: readonly string[],
): URLSearchParams {
  const stripped = new URLSearchParams(searchParams);
  for (const param of paramsToStrip) {
    stripped.delete(param);
  }
  return stripped;
}

function searchParamsEqual(left: URLSearchParams, right: URLSearchParams): boolean {
  return left.toString() === right.toString();
}

export function isConnectionsUiOnlySearchChange(
  currentUrl: URL,
  nextUrl: URL,
): boolean {
  if (
    currentUrl.pathname !== "/connections" ||
    nextUrl.pathname !== "/connections"
  ) {
    return false;
  }

  if (currentUrl.search === nextUrl.search) {
    return false;
  }

  const current = stripSearchParams(
    currentUrl.searchParams,
    CONNECTIONS_UI_SEARCH_PARAMS,
  );
  const next = stripSearchParams(
    nextUrl.searchParams,
    CONNECTIONS_UI_SEARCH_PARAMS,
  );
  return searchParamsEqual(current, next);
}

export function shouldRevalidateConnectionsRoute({
  currentUrl,
  nextUrl,
  formData,
  defaultShouldRevalidate = true,
}: {
  currentUrl?: URL;
  nextUrl?: URL;
  formData?: FormData | null;
  defaultShouldRevalidate?: boolean;
}): boolean {
  if (!currentUrl || !nextUrl) {
    return defaultShouldRevalidate;
  }

  if (currentUrl.pathname !== nextUrl.pathname) {
    return true;
  }

  if (formData) {
    return defaultShouldRevalidate;
  }

  if (isConnectionsUiOnlySearchChange(currentUrl, nextUrl)) {
    return false;
  }

  return defaultShouldRevalidate;
}
