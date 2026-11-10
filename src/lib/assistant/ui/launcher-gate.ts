const CHECKOUT = /^\/checkout(?:\/|$)/;
const ORDER = /^\/order(?:\/|$)/;

function normalize(pathname: string): string {
  return (pathname.split("?")[0] || "/").replace(/\/+$/, "") || "/";
}

export function launcherVisible(input: {
  flag: boolean;
  storeStatus: string;
  pathname: string;
  sessionHidden?: boolean;
}): boolean {
  if (!input.flag) return false;
  if (input.storeStatus === "suspended") return false;
  if (input.sessionHidden) return false;
  const path = normalize(input.pathname);
  if (CHECKOUT.test(path) || ORDER.test(path)) return false;
  return true;
}

const IN_FLOW = /^\/(?:listings\/[^/]+|cart)$/;

/** Product and basket pages place the entry in the page, so it never covers their controls. */
export function launcherFloats(pathname: string): boolean {
  return !IN_FLOW.test(normalize(pathname));
}
