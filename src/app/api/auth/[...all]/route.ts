import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";
import { authPrisma } from "@/lib/db";

const { GET, POST: basePost } = toNextJsHandler(auth);

export { GET };

export async function POST(request: Request) {
  const response = await basePost(request);

  const url = new URL(request.url);
  if (url.pathname.includes("/two-factor/verify-totp") && response.ok) {
    try {
      const cloned = response.clone();
      const body = await cloned.json();
      if (body.token) {
        const session = await authPrisma.session.findFirst({
          where: { token: body.token },
        });
        if (session) {
          await authPrisma.session.update({
            where: { id: session.id },
            data: { twoFactorVerified: true },
          });
          await authPrisma.session.deleteMany({
            where: {
              userId: session.userId,
              id: { not: session.id },
              twoFactorVerified: false,
            },
          });
        }
      }
    } catch {
      // Never break the auth flow if post-verify bookkeeping fails
    }
  }

  return response;
}
