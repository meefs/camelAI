import { useEffect, useRef } from "react";
import type { NavigateFunction } from "react-router";
import { toast } from "sonner";

interface CheckoutStatusOptions {
  hash: string;
  navigate: NavigateFunction;
  pathname: string;
  search: string;
}

/** Shows the one-shot checkout result and removes it from the current URL. */
export function useCheckoutStatus({
  hash,
  navigate,
  pathname,
  search,
}: CheckoutStatusOptions): void {
  const lastHandledCheckoutKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const searchParams = new URLSearchParams(search);
    const checkoutStatus = searchParams.get("checkout");
    if (!checkoutStatus) return;
    const checkoutKey = `${pathname}${search}${hash}`;
    if (lastHandledCheckoutKeyRef.current === checkoutKey) return;
    lastHandledCheckoutKeyRef.current = checkoutKey;

    if (checkoutStatus === "success") {
      toast.success("Credits added");
    } else if (checkoutStatus === "cancelled") {
      toast.message("Credit checkout cancelled");
    }

    searchParams.delete("checkout");
    const nextSearch = searchParams.toString();
    navigate(`${pathname}${nextSearch ? `?${nextSearch}` : ""}${hash}`, {
      replace: true,
    });
  }, [hash, navigate, pathname, search]);
}
