/** Runs once per server start. The database check is Node-only; the edge runtime has no database client. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { refuseUnsafeDatabaseLogin } = await import("./lib/runtime-login");
  await refuseUnsafeDatabaseLogin(process.env);
}
