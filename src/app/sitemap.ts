import type { MetadataRoute } from "next";
import { directoryOrigin } from "@/lib/directory/links";
import { statePages } from "@/lib/directory/places";
import { listDirectoryStores } from "@/lib/directory/stores";

// Root domain only (the proxy 404s it on store hosts). Read per request: the root domain is runtime config (#451).
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = directoryOrigin();
  const states = statePages(await listDirectoryStores());
  return [
    { url: `${origin}/` },
    ...states.flatMap((state) => [
      { url: `${origin}/stores/${state.slug}` },
      ...state.cities.map((city) => ({ url: `${origin}/stores/${state.slug}/${city.slug}` })),
    ]),
  ];
}
