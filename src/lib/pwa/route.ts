import { headers } from "next/headers";
import { findStoreForHeaders } from "../get-store";
import { buildManifest, type PwaApp } from "./manifest";

/** The web app manifest for the store on this host. */
export async function manifestResponse(app: PwaApp): Promise<Response> {
  const store = await findStoreForHeaders(await headers());
  if (!store) return new Response("Not found", { status: 404 });
  return new Response(JSON.stringify(buildManifest(store, app)), {
    headers: {
      "Content-Type": "application/manifest+json",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
