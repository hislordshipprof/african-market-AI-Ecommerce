"use client";

import { createAuthClient } from "better-auth/react";
import { twoFactorClient, magicLinkClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [twoFactorClient(), magicLinkClient()],
});
