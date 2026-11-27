import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DirectoryPlace } from "@/components/directory/directory-place";
import { directoryOrigin } from "@/lib/directory/links";
import { cityPage } from "@/lib/directory/places";
import { listDirectoryCards } from "@/lib/directory/stores";

// Cached for every request and cleared by the directory tag on any store save (#451).
export const dynamic = "force-static";
export const revalidate = 300;

export function generateStaticParams() {
  return [];
}

type Props = { params: Promise<{ state: string; city: string }> };

async function load(params: Props["params"]) {
  const { state, city } = await params;
  return cityPage(await listDirectoryCards(), state, city);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = await load(params);
  if (!page) return { title: "Not found · Globe Grocer" };
  return {
    title: `African grocery stores in ${page.city}, ${page.state.code} · Globe Grocer`,
    description: `${page.stores.length === 1 ? "1 independent store" : `${page.stores.length} independent stores`} in ${page.city}, ${page.state.name}. Order pickup or delivery straight from the store.`,
    alternates: { canonical: `${directoryOrigin()}/stores/${page.state.slug}/${page.slug}` },
  };
}

export default async function CityPage({ params }: Props) {
  const page = await load(params);
  if (!page) notFound();
  const others = page.state.cities.filter((city) => city.slug !== page.slug);
  return (
    <DirectoryPlace
      crumbs={[{ label: "All stores", href: "/" }, { label: page.state.name, href: `/stores/${page.state.slug}` }, { label: page.city }]}
      title={`African grocery stores in ${page.city}, ${page.state.code}`}
      lede="Independent stores, each with its own shop. Pick one, then order pickup or delivery straight from that store."
      stores={page.stores}
      places={{
        title: `More in ${page.state.name}`,
        links: others.map((city) => ({ name: city.name, href: `/stores/${page.state.slug}/${city.slug}`, count: city.stores.length })),
      }}
    />
  );
}
