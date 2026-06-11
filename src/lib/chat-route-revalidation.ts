const ACTIVE_CHAT_LOADER_SEARCH_PARAMS = [
  "adminReadonly",
  "embed",
  "newThread",
  "chatCache",
  "group",
  "devCreditState",
  "devChatError",
] as const;

export interface ActiveChatShouldRevalidateArgs {
  currentUrl?: URL;
  nextUrl?: URL;
  currentParams?: Partial<Record<string, string | undefined>>;
  nextParams?: Partial<Record<string, string | undefined>>;
  formData?: FormData | null;
  defaultShouldRevalidate?: boolean;
}

export function shouldRevalidateActiveChatRoute({
  currentUrl,
  nextUrl,
  currentParams,
  nextParams,
  formData,
  defaultShouldRevalidate = true,
}: ActiveChatShouldRevalidateArgs): boolean {
  if (!currentUrl || !nextUrl) {
    return defaultShouldRevalidate;
  }

  if (currentUrl.pathname !== nextUrl.pathname) {
    return true;
  }

  if (currentParams?.id !== nextParams?.id) {
    return true;
  }

  for (const param of ACTIVE_CHAT_LOADER_SEARCH_PARAMS) {
    if (currentUrl.searchParams.get(param) !== nextUrl.searchParams.get(param)) {
      return true;
    }
  }

  if (formData?.get("intent") === "updateThreadModel") {
    return false;
  }

  return defaultShouldRevalidate;
}
