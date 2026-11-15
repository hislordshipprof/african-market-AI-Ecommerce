import { statePages } from "./places";

type Placed = { slug: string; city: string | null; state: string | null };

/** The hero's counts (#690), grouped as the state and city pages group them. */
export function directoryCounts(stores: readonly Placed[]): { markets: number; cities: number; states: number } {
  const states = statePages([...stores]);
  return {
    markets: stores.length,
    cities: states.reduce((sum, state) => sum + state.cities.length, 0),
    states: states.length,
  };
}

type Storied = { slug: string; name: string; ownerName: string | null; ownerStory: string | null; ownerPhotoUrl: string | null };

export type OwnerQuote = Omit<Storied, "ownerStory"> & { quote: string };

const QUOTE_MAX = 180;
const QUOTES_MAX = 3;

/** Up to three owners' own stories, each cut to its first sentence (#690). */
export function ownerQuotes(stores: readonly Storied[]): OwnerQuote[] {
  return stores.flatMap(({ ownerStory, ...store }) => {
    const story = ownerStory?.replace(/\s+/g, " ").trim();
    return story ? [{ ...store, quote: shorten(story) }] : [];
  }).slice(0, QUOTES_MAX);
}

function shorten(story: string): string {
  const sentence = story.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? story;
  if (sentence.length <= QUOTE_MAX) return sentence;
  const cut = sentence.slice(0, QUOTE_MAX);
  return `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[\s,;:]+$/, "")}…`;
}
