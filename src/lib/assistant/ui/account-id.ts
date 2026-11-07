/**
 * The launcher is a guest control. A session read that cannot start
 * (Prisma P2028 under a busy pool) must not reject the host: the storefront
 * wraps it in Suspense, and a thrown read leaves the fallback in place for
 * the rest of that document.
 */
export async function assistantAccountId(
  readSession: () => Promise<{ user?: { id?: string | null } | null } | null>,
): Promise<string | null> {
  try {
    const session = await readSession();
    const id = session?.user?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}
