# Patch policy

Sources, in this order: GitHub advisories via Dependabot alerts (the owner enables Dependabot), Next.js security advisories, and `pnpm audit --prod`.

Response times: a critical or actively exploited advisory within 48 hours, a high advisory within 7 days, a moderate advisory at the next weekly pass, and a low advisory monthly.

The builder of the dependency ticket patches it. Verification is `pnpm typecheck`, the affected tests, the affected e2e specs, `scripts/ci-local.sh`, and hosted CI by adding the `run-ci` label.

Reachability: an advisory is a runtime fix only when the vulnerable package is imported by the Next.js server or the storefront client. A package that appears only as a test, build, or CLI peer is not in the request path and waits for the dependency ticket.

Checked 2026-11-05 with `pnpm audit --prod` on this branch. Nine advisories: 2 critical, 6 moderate, 1 low. Nothing was upgraded in #309. The brief expected every advisory to arrive through Better Auth's optional vitest peer. The audit also found glob and minimatch through Inngest's OpenTelemetry GCP detector, and deepmerge through the shadcn CLI. Those are still not request handling.

| Severity | Package | How it is reached | Why it is not a runtime fix here |
|---|---|---|---|
| critical (2) | tinypool | `better-auth` optional `vitest` peer | Test runner only. Not in the production server bundle. |
| moderate | vitest, `@vitest/mocker` (3 advisories) | same optional peer | Test runner only. |
| moderate | glob, minimatch | `inngest` → OpenTelemetry GCP detector, and `shadcn` → `ts-morph` for minimatch | Build and telemetry tooling. Not request handling. |
| low | deepmerge | `shadcn` | CLI tooling, not the storefront bundle. |

Triage: do not bump these for a security ticket whose job is the request boundary. A later dependency ticket can upgrade Better Auth's vitest peer, Inngest's telemetry tree, and the shadcn CLI together, with the suites that import them.

Review the audit again when those packages change. A critical advisory that appears in the Next.js server bundle, Prisma, Better Auth's runtime, or the Stripe SDK is fixed or explicitly accepted before release. An advisory that exists only under a test, build, or CLI peer can wait for that dependency ticket.
