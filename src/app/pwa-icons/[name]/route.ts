import { headers } from "next/headers";
import { findStoreForHeaders } from "@/lib/get-store";
import { PWA_ICONS, renderStoreIcon } from "@/lib/pwa/manifest";

export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const spec = Object.hasOwn(PWA_ICONS, name) ? PWA_ICONS[name] : null;
  const store = spec ? await findStoreForHeaders(await headers()) : null;
  if (!spec || !store) return new Response("Not found", { status: 404 });
  const png = await renderStoreIcon(store, spec);
  return new Response(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
