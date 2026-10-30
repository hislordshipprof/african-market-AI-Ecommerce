export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg">
      <div className="text-center">
        <h1
          className="font-display text-ink mb-sm"
          style={{ fontSize: "clamp(28px, 4vw, 40px)", fontWeight: 700 }}
        >
          Store not found
        </h1>
        <p className="text-muted">
          We could not find a store at this address.
        </p>
      </div>
    </main>
  );
}
