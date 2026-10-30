# 14. Neon Postgres with Prisma, row-level security and Postgres search

Date: 2026-10-30 · Status: accepted

## Context
One shared database holds every store's data (ADR-0005). Serverless functions open many short connections. Search must handle local food names and typos ("ugu", "egushi") across 2–5M listings at target scale (ADR-0012).

## Decision
- **Database:** **Neon** serverless Postgres. Always connect through its **pooled** endpoint, with a separate direct connection only for migrations. Each pull request gets a database branch for its preview deploy.
- **ORM:** **Prisma 7** with migrations in git. Hot read paths (search, product grid) may use typed raw SQL.
- **Store isolation:** Postgres **row-level security** on every store-owned table. A Prisma client extension runs each request's queries inside a transaction that first sets the current store (`set_config('app.store_id', …, true)`). The app's database role is not the table owner and cannot bypass RLS. CI includes cross-store read and write tests that must fail.
- **Search:** Postgres full-text search plus `pg_trgm` for typo tolerance plus our synonym table for local names, indexed per store. **pgvector** embeddings for the AI's product matching.

## Consequences
- RLS costs one extra statement per transaction. Keep transactions short and avoid many small transactions per request.
- Index every foreign key and `(store_id, …)` lookup. Check slow queries with `EXPLAIN ANALYZE` before launch and when tables pass 1M rows.
- Neon is plain Postgres, so RDS/Aurora remains a migration path if steady load makes it cheaper.
- Move search to Typesense only if measured p95 search latency exceeds 300 ms.
- **Two database logins.** The table owner role runs migrations and seeds (via `DIRECT_URL`). A separate `app_runtime` role — created by plain SQL, not the Neon console (whose roles join `neon_superuser` and gain BYPASSRLS) — connects at runtime through the pooled `DATABASE_URL`. `app_runtime` is NOSUPERUSER, NOBYPASSRLS, and is not the table owner, so it cannot `ALTER TABLE … DISABLE ROW LEVEL SECURITY` or bypass policies. It accesses tables through its membership in `app_user` (granted by a migration) and `SET LOCAL ROLE app_user` in every transaction. `APP_RUNTIME_PASSWORD` is required in production and preview; local dev falls back to `DATABASE_URL`.
