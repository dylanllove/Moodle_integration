import { useEffect } from "react";

/**
 * Re-run a page's own loader when a background sync finishes.
 *
 * A sync that lands while you're looking at the dashboard used to be invisible
 * until you navigated away and back — or, worse, was announced by reloading the
 * page out from under you. Pages that care subscribe instead.
 */
export function useSyncedRefresh(reload: () => void): void {
  useEffect(() => {
    const handler = () => reload();
    window.addEventListener("uni:synced", handler);
    return () => window.removeEventListener("uni:synced", handler);
  }, [reload]);
}
