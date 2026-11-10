const CHECKOUT = /^\/checkout(?:\/|$)/;
const ORDER = /^\/order(?:\/|$)/;

export function launcherVisible(input: {
  flag: boolean;
  storeStatus: string;
  pathname: string;
  sessionHidden?: boolean;
}): boolean {
  if (!input.flag) return false;
  if (input.storeStatus === "suspended") return false;
  if (input.sessionHidden) return false;
  const path = (input.pathname.split("?")[0] || "/").replace(/\/+$/, "") || "/";
  if (CHECKOUT.test(path) || ORDER.test(path)) return false;
  return true;
}
