type SignOut = () => Promise<{ error: unknown }>;

/** Ends the Better Auth session, then leaves for `signInPath`. Returns false, staying put, when the session may still be live. */
export async function signOutTo(signInPath: string, signOut: SignOut, leave: (path: string) => void): Promise<boolean> {
  try {
    const result = await signOut();
    if (result.error) return false;
  } catch {
    return false;
  }
  leave(signInPath);
  return true;
}
