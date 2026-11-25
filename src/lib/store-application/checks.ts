import { suggestSlug } from "./fields";

interface Application {
  id: string;
  businessName: string;
  addressLine1: string;
  state: string;
  zip: string;
  email: string;
  website: string | null;
  offersPickup: boolean;
  offersDelivery: boolean;
}

interface Store {
  name: string;
  slug: string;
  addressLine1: string | null;
  zip: string | null;
}

const same = (a: string | null, b: string | null) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
const sameAddress = (a: { addressLine1: string | null; zip: string | null }, b: { addressLine1: string | null; zip: string | null }) =>
  same(a.addressLine1, b.addressLine1) && same(a.zip, b.zip);

/**
 * What the admin assistant reports on a waiting application (#832): details the applicant left out, anything that
 * duplicates a store or another application (approve refuses a taken slug), and whether a metro covers its state.
 * Applications carry no coordinates, so the metro check is by state, not by the metro's radius.
 */
export function applicationChecks(
  application: Application,
  context: { stores: Store[]; metros: Array<{ name: string; states: string[] }>; pending: Application[] },
) {
  const suggestedSlug = suggestSlug(application.businessName);
  const missing = [
    ...(application.website ? [] : ["no website or social link"]),
    ...(application.offersPickup || application.offersDelivery ? [] : ["offers neither pickup nor delivery"]),
  ];
  const slugOwner = context.stores.find((store) => store.slug === suggestedSlug);
  const others = context.pending.filter((other) => other.id !== application.id);
  const duplicates = [
    ...(slugOwner ? [`the slug ${suggestedSlug} is taken by ${slugOwner.name}, so approve needs another slug`] : []),
    ...context.stores.filter((store) => same(store.name, application.businessName)).map((store) => `a store named ${store.name} already exists`),
    ...context.stores.filter((store) => sameAddress(store, application)).map((store) => `${store.name} is at the same address`),
    ...others.filter((other) => same(other.email, application.email)).map((other) => `another waiting application, ${other.businessName}, uses the same email`),
    ...others.filter((other) => sameAddress(other, application)).map((other) => `another waiting application, ${other.businessName}, is at the same address`),
  ];
  const metro = context.metros.find((row) => row.states.includes(application.state.toUpperCase()))?.name ?? null;
  return { suggestedSlug, missing, duplicates, metro, outsideMetro: metro === null };
}
