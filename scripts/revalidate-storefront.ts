/** Set URL+secret when seeding an already-running deployment. No public cache flush. */
export async function revalidateSeededStores(stores: { id: string; slug: string }[]) {
  const url = process.env.STOREFRONT_REVALIDATION_URL;
  const secret = process.env.STOREFRONT_REVALIDATION_SECRET;
  if (!url) {
    console.log("Seed complete. For an already-running server, set STOREFRONT_REVALIDATION_URL and STOREFRONT_REVALIDATION_SECRET to expire its store/listing/banner/collection tags. Storefront reads also refresh after 60 seconds.");
    return;
  }
  if (!secret) throw new Error("STOREFRONT_REVALIDATION_SECRET is required with the revalidation URL");
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` }, body: JSON.stringify({ stores }), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Storefront revalidation failed (${response.status})`);
  console.log(`Expired storefront, banner and collection caches for ${stores.length} stores`);
}
