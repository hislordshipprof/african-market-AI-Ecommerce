import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: "african-markets",
  // Vercel must stay in cloud mode. `INNGEST_DEV` cannot turn signature checks off there.
  isDev: process.env.VERCEL ? false : undefined,
});
