type SignOut = () => Promise<{ error: unknown }>;

/** Ends the Better Auth session, then leaves for sign-in. Returns false, staying put, when the session may still be live. */
export async function signOutAdmin(signOut: SignOut, leave: (path: string) => void): Promise<boolean> {
  try {
    const result = await signOut();
    if (result.error) return false;
  } catch {
    return false;
  }
  leave("/admin/sign-in");
  return true;
}
