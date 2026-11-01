export function demoFlowsEnabled(env: {
  NODE_ENV?: string;
  VERCEL_ENV?: string;
  NEXT_PUBLIC_DEMO_FLOWS?: string;
}): boolean {
  if (env.VERCEL_ENV === "production") return false;
  return (
    env.NEXT_PUBLIC_DEMO_FLOWS === "1" ||
    env.NODE_ENV === "development" ||
    env.VERCEL_ENV === "preview"
  );
}
