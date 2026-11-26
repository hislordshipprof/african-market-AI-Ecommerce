import Link from "next/link";

/** Under the hero (#862 AC1): the names shoppers here search for most, as links that wrap and never scroll sideways. */
export function PopularNames({ names }: { names: string[] }) {
  if (!names.length) return null;
  return (
    <section className="sf-popular sf-container" data-testid="popular-names" aria-labelledby="popular-names-title">
      <h2 id="popular-names-title">Popular:</h2>
      <ul>
        {names.map((name) => (
          <li key={name}>
            <Link className="sf-popular-chip" href={"/search?q=" + encodeURIComponent(name.toLowerCase())}>
              {name}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
