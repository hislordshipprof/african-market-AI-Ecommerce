import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DirectoryPlace } from "@/components/directory/directory-place";
import { directoryOrigin } from "@/lib/directory/links";
import { statePage } from "@/lib/directory/places";
import { listDirectoryCards } from "@/lib/directory/stores";

// Cached for every request (the root layout sees no headers) and cleared by the directory tag on any store save (#451).
export const dynamic = "force-static";
export const revalidate = 300;

export function generateStaticParams() {
  return [];
}

type Props = { params: Promise<{ state: string }> };

async function load(params: Props["params"]) {
  const { state } = await params;
  return statePage(await listDirectoryCards(), state);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = await load(params);
  if (!page) return { title: "Not found · Globe Grocer" };
  return {
    title: `African grocery stores in ${page.name} · Globe Grocer`,
    description: `${page.stores.length === 1 ? "1 independent store" : `${page.stores.length} independent stores`} in ${page.name}. Order pickup or delivery straight from the store.`,
    alternates: { canonical: `${directoryOrigin()}/stores/${page.slug}` },
  };
}

export default async function StatePage({ params }: Props) {
  const page = await load(params);
  if (!page) notFound();
  return (
    <DirectoryPlace
      crumbs={[{ label: "All stores", href: "/" }, { label: page.name }]}
      title={`African grocery stores in ${page.name}`}
      lede="Independent stores, each with its own shop. Pick one, then order pickup or delivery straight from that store."
      stores={page.stores}
      places={{
        title: `Cities in ${page.name}`,
        links: page.cities.map((city) => ({ name: city.name, href: `/stores/${page.slug}/${city.slug}`, count: city.stores.length })),
      }}
    />
  );
}
