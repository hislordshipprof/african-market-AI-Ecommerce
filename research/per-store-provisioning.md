# Per-store provisioning: domain, email, storage, database and the control plane

Researched 2026-11-25. Every web source below was read on that date. Repo facts were read from the code on `main` at `cbb7b0d3`.
Tags: `[verified: ...]` was checked at the named source. `[UNVERIFIED]` was not checked, or only a search summary was seen. `[ESTIMATE]` is my arithmetic from stated assumptions, not a measurement.

## Summary

1. **Isolation today is strong for data and domains, partial for compute fairness, weak for AI spend.** Row-level security covers every store table; only the courier dispatch function has a per-store Inngest concurrency key; AI spend is one platform-wide ledger; most rate limits are per IP.
2. **Web address:** every store gets `slug.platform.com` from one Vercel wildcard domain, with Cloudflare kept as DNS (`_acme-challenge` delegated). A store's own domain is a Pro feature, added by the existing Vercel API code, with the store setting the DNS record. We do not buy domains for stores in v1. Cloudflare for SaaS is not needed.
3. **Email:** one verified platform sending subdomain (`mail.platform.com`) in Resend. Each email says "Store Name <store-slug@mail.platform.com>" with Reply-To the store's own address. Stores get no mailbox. A store's own sending domain is a later Pro option.
4. **Storage:** one catalogue bucket and one private proof bucket, one server-side credential. Prefix keys per store for anything a store owns. No bucket per store.
5. **Database:** keep the shared Neon database with RLS. Add a CI guard that fails if a table with `store_id` lacks RLS. A database per store is never worth it before a store has a contract that demands it.
6. **Control plane:** one idempotent `store/provision` Inngest job with a step table, and a matching `store/deprovision` job. Pieces exist (store create, invite, courier registration, domain add); the state table, the retry view and deprovision do not.
7. **Changes to earlier decisions:** (a) ADR-0020 says production is on Vercel Hobby. Hobby allows 50 domains per project and is for "personal or non-commercial use". Move to Pro before the first paying store. (b) ADR-0017 says Resend free tier. Free allows 100 emails a day. Move to Resend Pro before the first paying store. (c) ADR-0016 says Inngest at $50 to $100 a month at 1,000 stores; ADR-0012's own amendment already says that is too low. (d) ADR-0016 needs per-store concurrency keys on the order-driven functions, as courier dispatch already has.
8. **Per-store provisioning costs about $0.** Cost comes from orders (jobs, email, SMS), not from stores.
9. **Total monthly platform cost [ESTIMATE]:** about $160 at 10 stores and about $200 to $270 at 100 stores. At 1,000 stores about $1,100 to $2,000, or about $1.10 to $2.00 a store.
10. **Biggest findings in the code:** the domain code hard-codes the CNAME value and treats Vercel's `verified` as "DNS works"; both need a fix before a store points a real domain (section 1).

11. **Pricing (section 8):** at 250 orders a store, no plan loses money (margin about 89 to 94% typical). The risk is a Pro store at its full AI cap on Sonnet with almost no orders (about minus $187 on subscription alone). Fix: a dollar cap per store. Unchecked: Stripe Connect may charge us about $31 a store a month.
12. **Alternatives (section 9):** keep the current stack. Self-hosting saves $60 to $100 a month at 10 stores and nothing at 100. Switch email to SES and Inngest to self-hosted at hundreds of stores.

## Decisions (owner, 2026-11-25)

1. **Platform name: Globe Grocer. Domain: `globegrocer.com`** (owner, 2026-11-27, replacing Globemart), bought through Cloudflare Registrar (T1) at $11.17 a year on 2026-11-27, in the Cloudflare account that holds the R2 buckets. Set up the same day: Vercel project `african-market-ai-ecommerce` has `globegrocer.com` (primary), `www` (308 to the apex) and `*.globegrocer.com`; Cloudflare DNS has CNAMEs for `@`, `www` and `*` to the project's own Vercel CNAME (DNS only) and `_acme-challenge` NS to `ns1/ns2.vercel-dns.com`; production env has `PLATFORM_ROOT_DOMAIN=globegrocer.com` and `BETTER_AUTH_URL=https://globegrocer.com`, live from the next production build. Email, same day: Cloudflare Email Routing forwards `hello@globegrocer.com` to the owner's mailbox (MX, SPF and DKIM records added by Cloudflare); `mail.globegrocer.com` is verified in Resend (us-east-1; DKIM TXT, `send.mail` and `rsend.mail` CNAMEs) in the account whose key production already uses; `_dmarc` is `v=DMARC1; p=none;`. `EMAIL_FROM` is `Globe Grocer <noreply@mail.globegrocer.com>` in production, live from 2026-11-27. The team wanted a name that fits stores that are African, Asian, Caribbean, Latin and more. Stores live at `slug.globegrocer.com` (for example `markola.globegrocer.com`); store email sends from `slug@mail.globegrocer.com`.
   **Why not Globemart:** `globemart.com` is a live B2B marketplace with seller and buyer pages, so the name could be confused with it, and only `globemart.market` ($34.20 a year) was free. `globegrocer.com` had no registry record on 2026-11-27, and a web search found no "Globe Grocer" trademark. Other free `.com` names checked: `homeaisles.com`, `heritageaisle.com`, `kinaisle.com`, `globeaisle.com`; `rootsgrocer.com` was free but "Roots Market" is a filed mark for natural food stores. A USPTO search was not run `[UNVERIFIED]`.
2. **Stack for the first stores: keep Vercel; Cloudflare for domain, DNS and storage.** Budget $50 to $100 a month in production.

| Service | Provider | What we get | Monthly `[ESTIMATE]` |
|---|---|---|---|
| Domain `globegrocer.com` | Cloudflare Registrar | At-cost price and renewals: $11.17 a year (Cloudflare search, 2026-11-27) | about $1 |
| DNS | Cloudflare | `globegrocer.com` and `*.globegrocer.com` point to Vercel | $0 |
| Site hosting | Vercel Pro | Every storefront and admin; certificates for every store address; store own domains at no per-domain fee. Hobby is "non-commercial personal use only" (https://vercel.com/docs/plans/hobby) | $20 |
| Database | Neon Launch, pay as you go | One shared database with RLS and backups | about $5 to $15 |
| Store email | Resend Pro | No daily cap (Free stops at 100 a day), 50,000 a month (https://resend.com/pricing) | $20 |
| Background jobs | Inngest Hobby | 50,000 executions a month. Two stores at 250 orders is about 48,600 (30,600 idle plus 36 an order, ADR-0012), so cut the idle cron runs to keep headroom (T20) | $0 |
| Photo storage | Cloudflare R2 | Free egress | $0 at this size |
| Bot protection | Cloudflare Turnstile | Sign-up, onboarding and checkout | $0 |
| Team-only test site | Cloudflare Zero Trust Access | Up to 50 users | $0 |
| Platform inbox | Cloudflare Email Routing | `hello@globegrocer.com` forwards to the owner's mailbox | $0 |
| **Total** | | | **about $47 to $58** |

Per-order costs (Stripe card fees, SMS, AI, courier) are paid from the 3% service fee (section 8), not from this budget.

Rejected: moving everything to Cloudflare Workers saves about $40 a month but means porting 23 Inngest functions to Queues and Workflows and checking 53 files that use Node APIs, about 3 to 6 weeks `[ESTIMATE]` on checkout and payment code. Revisit only if hosting cost grows; Vercel is $20 to $400 a month even at 1,000 stores (section 7).

## Open questions for the owner

1. **Stripe Connect fee:** confirm in the Stripe dashboard whether Connect charges us per active account (up to about $31 a store a month). This is the biggest unchecked cost (section 8).
2. **AI spend cap:** set a dollar cap per store per month, for example $5 Starter and $25 Pro (section 8, T11).
3. **Scope:** which of T1 to T20 to build now, and in what order (ticket list at the end).

Decided earlier:
- **Store custom domains (decided 2026-11-25, owner may override):** connecting a store's own domain is Pro-only; the store buys it, as on Shopify; Pro does not bundle a free domain; every store gets `slug.<platform domain>` free; no separate `.shop` domain per store (section 1).
- **Email:** start on Resend; move to Amazon SES only at hundreds of stores (sections 2 and 9).
- **Plan upgrades:** Vercel Pro and Resend Pro before the first paying store (T2).

## How well does isolation hold today? (answer to the owner's question)

| Resource | Isolated per store today? | Evidence |
|---|---|---|
| Customer and order data | Yes, by Postgres RLS | 67 of 100 tables have a `store_id` column; all 67 have `ENABLE ROW LEVEL SECURITY` in migrations; 85 tables have `FORCE`. The 13 tables without RLS have no `store_id` (auth, rate limits, geocode cache, assistant spend, WhatsApp inbound) `[verified: script over prisma/schema.prisma and prisma/migrations, 2026-11-25]`. Two tables have RLS enabled but not `FORCE`: `audit_logs` and `stores`. No `DISABLE ROW LEVEL SECURITY` appears in migrations; one `DROP POLICY` on `store_collection_listings` was replaced in the same migration `[verified: grep; final policy text not read]`. `whatsapp_inbound_messages` and `assistant_file_turns` have no `store_id` and no RLS; check they hold no store-owned content `[UNVERIFIED]`. I did not read each policy's predicate `[UNVERIFIED]`. |
| Host to store | Yes | `src/proxy.ts` deletes inbound `x-store-slug` and `x-custom-domain` headers, then sets them from the host. `Store.customDomain` is `@unique` `[verified: src/proxy.ts, prisma/schema.prisma:13]`. |
| Stripe money | Yes | One connected account per store, `Store.stripeAccountId` is `@unique` `[verified: schema.prisma:53]`. |
| Photos and proofs | By database ownership, not by key prefix | Proof keys are `delivery-proof/<orderId>/...`, read through a route that checks the tracking token on the store (ADR-0013 amendment). Catalogue keys are `catalog/<id>` and shared `[verified: src/lib/r2.ts]`. |
| Email reputation | No, shared | All stores send from one sender. |
| Background jobs | Partly | Of the 22 `createFunction` calls, two set concurrency: `directory/store-request-notices` with `limit: 1` (global), and the courier dispatch function in `src/lib/delivery/courier-functions.ts:115` with `key: "event.data.storeId", limit: 1`. No other function has a store key `[verified: grep of src for concurrency, throttle, createFunction, 2026-11-25]`. |
| AI spend | No per-store dollars | `ASSISTANT_SPEND_CAP_USD` is one default of $10 a day for the platform; the spend tables have no `store_id` `[verified: src/lib/assistant/spend.ts, RLS script]`. Per-store chat counts exist as plan caps (ADR-0021). |
| Rate limits | Mostly per IP, browser or token; one per store | Keys read in `src`: `search:ip`, `mcp:ip`, `assistant:ip`, `checkout-quote:ip`, `payment:ip`, `substitution:token`, `issue-report:token`, a per-order message limit, and `copilot-push:<storeId>`. The copilot gate takes a caller-supplied key `[verified: grep of takeRateLimit]`. The tables at `schema.prisma:176-184` (`courier_quote_days`, a report counter) and `:191-199` (`store_content`, an RLS test fixture) are not caps. |

## 1. Store web address

### Options

| | (a) Subdomain on platform domain | (b) Store's own domain on Vercel | (c) Cloudflare for SaaS |
|---|---|---|---|
| Example | `mama-ngozi.platform.com` | `mamangozi.com` | `mamangozi.com` through Cloudflare |
| Per-store cost | $0. One wildcard certificate covers every first-level subdomain. | $0 on Vercel Pro. The store pays its registrar. | 100 hostnames free, then $0.10 each. |
| Limit | Wildcard on all plans. | Hobby 50 per project; Pro unlimited, soft limit 100,000. | 50,000 per zone on Free, Pro, Business. |
| Certificate | One Let's Encrypt wildcard, DNS challenge. | One certificate per domain, HTTP challenge, once DNS points at Vercel. | Cloudflare terminates TLS. |
| Automation | None per store, after one-time setup. | Add domain by API, show DNS records, poll, remove. | Add custom hostname by API; store sets CNAME. |
| Fit with ADR-0020 | Yes (DNS only). | Yes (DNS only). | No: it proxies the hostname, which ADR-0020 rejects. The docs page I read does not say Vercel works as the origin `[UNVERIFIED]`. |

Sources: Vercel multi-tenant limits https://vercel.com/docs/platforms/multi-tenant-platforms/limits (last updated 2026-09-08, read 2026-11-25); concepts https://vercel.com/docs/platforms/multi-tenant-platforms/concepts; Cloudflare for SaaS plans https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/ ; overview https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/.

### Wildcard with Cloudflare as DNS (the exact steps)
From https://vercel.com/docs/domains/working-with-domains/add-a-domain (read 2026-11-25):
1. Add `*.platform.com` to the Vercel project.
2. In the Vercel team Domains page, open `platform.com`, click **Enable Vercel DNS**. Keep Cloudflare nameservers at the registrar.
3. In Cloudflare, add two `NS` records: name `_acme-challenge`, values `ns1.vercel-dns.com.` and `ns2.vercel-dns.com.`.
4. In Cloudflare, add `CNAME` `*` pointing to `cname.vercel-dns-0.com.`, DNS only (grey cloud).
5. Keep the NS records forever; Vercel uses them to renew.

Vercel's warning: delegating the challenge "can prevent other hosting providers from issuing or renewing certificates that use the same challenge name". We use one host, so this does not bite.

Cloudflare Registrar can sell `platform.com`; Vercel needs only the nameserver records above. Wildcard routing does not touch explicit records such as MX, DKIM and DMARC at the same zone, but test them after setup `[UNVERIFIED]`.

### Isolation: does one store's domain serve another store's data?
`resolveHost` in `src/lib/slug.ts` maps: root domain to marketplace; `x.platform.com` to slug `x` (reserved and non-routable labels refused); anything else to "custom-domain". `findStoreByDomain` then matches `customDomain` exactly, and the column is unique `[verified: src/lib/slug.ts, src/lib/get-store.ts]`. Vercel only routes hostnames added to the project, so a stranger's domain cannot reach the app. Findings:
- **Cookies across store subdomains.** Vercel says that without a Public Suffix List entry, `tenant1.acme.com` can set a cookie for `acme.com` that `tenant2.acme.com` receives, and recommends the PSL, `__Host-` cookies and no `Domain` attribute (https://vercel.com/docs/platforms/multi-tenant-platforms/configuring-domains). Better Auth is configured without `crossSubDomainCookies` `[verified: src/lib/auth.ts:471-475 shows only useSecureCookies and ipAddress]`, so session cookies are host-only. Store pages serve store-owned text (names, descriptions), so add the PSL entry as defence in depth. PSL review time is not guaranteed.
- **Slug takeover.** A deleted store's slug can be claimed by someone else, and old links and emails would then show the new store. Reserve released slugs for a period (Vercel does not say what period; our choice).
- **Reserved labels.** `RESERVED_SLUGS` has www, admin, api, app, mail, static, assets, cdn, vercel. Add the labels you will use for DNS (for example `send`, `status`, `docs`, `smtp`, `mx`).
- **Unset root domain.** In `resolveHost`, when `PLATFORM_ROOT_DOMAIN` is unset, any host that is not `*.vercel.app` or `localhost` resolves by its first label as a slug and never as a custom domain. So `mamangozi.com` would be read as slug `mamangozi`. Production must have the variable set before any store domain is added (T1).
- `findStoreByDomain` does not check `customDomainVerifiedAt`. This is safe only because Vercel will not route an unattached host.

### Bugs and gaps in `src/lib/vercel-domains.ts` and `domain-service.ts` (read, not run)
- The CNAME shown to the owner is hard-coded `cname.vercel-dns.com`. Vercel's page says "Each project has a unique CNAME record" (example `d1d4fc829fe7bc7c.vercel-dns-017.com`) and uses `cname.vercel-dns-0.com` for wildcards, and apex domains use an A record. Read the per-domain DNS values from Vercel instead. `[verified: add-a-domain page; code line "cname: 'cname.vercel-dns.com'"]`.
- `verified` from `POST /v10/projects/{id}/domains` means "verified for use with the project" (ownership), with a `verification` TXT challenge when the domain is in use elsewhere (https://vercel.com/docs/rest-api/projects/add-a-domain-to-a-project). It does not by itself say DNS points at Vercel. The code sets `customDomainVerifiedAt` from it and magic links follow that field (#711). A store whose DNS is not yet pointed could get magic links on a dead domain. Needs a probe against a real Vercel project before trusting it `[UNVERIFIED]`.
- The response `verification` array is never returned to the owner.
- No `www` handling. Vercel recommends adding both names and redirecting one.
- No plan check in `addDomainToStore`; ADR-0021 makes own-domain a Pro feature. The route sits under `/api/admin/...` `[verified: path]`.
- Rate limits are documented twice and disagree: 100 domain additions per hour per team on the multi-tenant limits page, 100 per minute in the REST API table (https://vercel.com/docs/limits). Plan for the stricter one. ADR-0013 already queues adds.

### Buying domains for stores
- **Cloudflare Registrar API:** exists, in beta. The docs page says: search, check, register; only a subset of extensions (`.com`, `.dev`, `.app` shown; `.uk` not); renewals, transfers and contact updates not yet in the API; premium domains cannot be registered by API; charged to the account's default payment profile; non-refundable (https://developers.cloudflare.com/registrar/registrar-api/). A cap of 100 domains per account appeared in a search summary only and is not on the docs page `[UNVERIFIED]`. At-cost pricing is stated at https://developers.cloudflare.com/registrar/.
- **Vercel Registrar API:** `POST /v1/registrar/domains/{domain}/buy` needs years, `expectedPrice` and a full registrant contact (https://vercel.com/docs/rest-api/domains-registrar/buy-a-domain). Prices were not read `[UNVERIFIED]`.
- **Recommendation:** the store registers its own domain and keeps it. If we register in our account, the store depends on us to transfer it out, and the registrant contact has to be the store. If owners ask for "buy it for me", build it later as a store-paid, store-as-registrant action through one of the two APIs, with a price confirmation step. Do not decide this now.

### Recommendation
(a) for every store from day one. (b) as the Pro feature, with the fixes above. Skip (c).

## 2. Store email

### Options

| | (a) One platform sending domain | (b) Subdomain per store | (c) Store's own domain |
|---|---|---|---|
| From | `Mama Ngozi <mama-ngozi@mail.platform.com>`, Reply-To the store | `orders@mama-ngozi.mail.platform.com` | `orders@mamangozi.com` |
| Resend domains used | 1 | 1 per store | 1 per store with own domain |
| Plan needed | Free or Pro | Pro has 10 domains; Pro plus $20 per extra 100, or Scale (1,000 included) | Same as (b) |
| Reputation | Shared by all stores | Isolated per store | Isolated per store |
| DNS work | Once | 3 to 4 records per store in Cloudflare by API (Resend returns MX, SPF TXT, DKIM TXT) | The store adds them; one wrong record leaves it unverified |
| Store effort | None | None | DNS access |

Sources: Resend pricing https://resend.com/pricing ; limits https://resend.com/docs/knowledge-base/account-quotas-and-limits ; create domain https://resend.com/docs/api-reference/domains/create-domain ; domains intro https://resend.com/docs/dashboard/domains/introduction (all read 2026-11-25).

Verified facts:
- Free: 3 domains, 3,000 emails a month, **100 a day**. Pro $20: 50,000 emails, 10 domains. Pro $35: 100,000, 10 domains. Scale from $90: 100,000 emails, 1,000 domains. Pro and Scale can add 100 domains for $20 a month. API limit 10 requests per second per team, shared. No per-domain sending limits stated.
- Resend recommends sending from subdomains to separate reputation.
- The create-domain response lists the records. Return path defaults to the `send` subdomain, so SPF and DKIM sit on `send.` and `resend._domainkey.` and do not collide with the store's existing mail host. An existing SPF on the apex stays untouched `[verified: create-domain page]`.
- Whether a subdomain counts as a separate domain against the quota is not stated `[UNVERIFIED]`; assume it does.

**Free is too small.** One store with 25 orders a day sends about 100 emails a day (order emails plus staff notices, per ADR-0012's "about four notifications"). ADR-0017 says "Resend (free tier)". Move to Pro before the first paying store.

### What Shopify does
When a store has not authenticated a domain, Shopify rewrites the sender to a per-store address on its own domain (`store+123@shopifyemail.com`). With an authenticated domain (CNAMEs for DKIM and SPF, plus a DMARC record of at least `v=DMARC1; p=none`) mail goes from the store's own address. Replies go to the store's contact address. Shopify says Gmail and Yahoo have required authentication and DMARC for branded senders since 2024-02-01. It can set the DNS automatically for Cloudflare, GoDaddy and IONOS. Source: https://help.shopify.com/en/manual/intro-to-shopify/initial-setup/setup-your-email (read via fetch and search summary 2026-11-25). Our (a) is the same shape as Shopify's default; our (c) is Shopify's authenticated path.

### Repo state
`ResendSender` already takes a per-message `from` and `replyTo`; order emails call `quotedFrom(storeName, fromAddress)`; but order notifications set no `replyTo` (only purchase orders and support actions do) `[verified: grep of replyTo and quotedFrom]`. `EMAIL_FROM` is unset until the platform domain exists (spec, #804).

### Inbound mail: do stores need mailboxes?
No for v1. Reply-To to the owner's own Gmail is enough. If owners later want `store@platform.com` forwarded: Cloudflare Email Routing (https://developers.cloudflare.com/email-routing/limits/, read 2026-11-25) allows 200 routing rules per domain and **200 destination addresses per account**, shared across domains, and 30 domains per zone (as written on that page). Each owner must verify their destination. The page I read does not state a price for routing `[UNVERIFIED]`. Forwarding cannot reply from the alias on Shopify's equivalent either (Shopify page above). Do not build it until a store asks. Note the destination cap: it limits this to about 200 owners per Cloudflare account.

### Recommendation
(a) now, with: verify `mail.platform.com` in Resend; From `Name <slug@mail.platform.com>` (a per-store local part lets bounces and replies be traced to a store, like Shopify's `store+123`); Reply-To the store email on every store-facing message; DMARC `p=none` at start, tighten after a clean month; Resend webhook for bounces and complaints counted per store; pause a store that crosses a complaint threshold. Use a second subdomain for system mail (sign-in links, invites) so a store's complaints do not block those. (c) later for Pro stores that want their own domain and send volume. (b) is not worth it: it needs a paid domain slot and 3 to 4 DNS records per store for reputation isolation we do not need while mail is transactional.

## 3. Storage

| | Prefix per store, shared bucket | Bucket per store |
|---|---|---|
| Count limit | None | Default 100,000 per account; $0.10 a month each above that |
| Per-bucket cost | n/a | Included up to 100,000 |
| Access enforcement | Our code builds the key; our server holds the one credential | API tokens can be scoped to named buckets |
| Browser direct upload | Temporary credentials accept `prefixes` | Token per bucket |
| Deprovision | List and delete by prefix | Delete bucket |
| Extra work | Key helper | Bucket create/config by REST API; REST limit 1,200 requests per 5 minutes per account |

Sources: https://developers.cloudflare.com/r2/platform/limits/ ; https://developers.cloudflare.com/r2/pricing/ (storage $0.015 per GB-month, egress free, 10 GB free) ; https://developers.cloudflare.com/r2/api/s3/tokens/ (tokens scoped by bucket; prefix scoping not stated there) ; https://developers.cloudflare.com/r2/api/s3/temporary-credentials/ (prefix and object scoping, `ttlSeconds`, short lifetimes advised). All read 2026-11-25.

Today: the app has one account-wide credential in env (`R2_ACCOUNT_ID`, key, secret), one catalogue bucket, one private proof bucket. Only `catalog-image.ts` calls `uploadToR2`, for the shared catalogue `[verified: grep]`. Proofs and issue photos are keyed by order id.

**Recommendation:** keep two buckets and one server-side credential. Put any file a store owns (logo, own photos, exports) under `stores/<storeId>/...`, and keep proofs under the order id but add the store id: `delivery-proof/<storeId>/<orderId>/...` for new keys, so deprovision and cost reports can work by prefix. Browsers never get the account credential; if direct upload is added, use a temporary credential limited to `stores/<storeId>/` with a short `ttlSeconds`. A bucket per store buys no isolation we use, because the server holds every key anyway. Presigned-URL scoping on R2 was not read `[UNVERIFIED]`; ADR-0013's amendment already avoids signed URLs for proofs.

## 4. Database

| | Shared Neon database with RLS (today) | Neon project per store |
|---|---|---|
| Neon limit | n/a | Projects: 100 on Free and Launch, 1,000 on Scale (more on request) |
| Cost | Usage only | Free: 100 CU-hours and 1 GB each; Launch $0.106 per CU-hour, $0.35 per GB-month |
| Directory, search, platform admin, fee ledger | One query | Fan out to every database |
| Migrations | Once | Once per store, with failure handling |
| Isolation | Policy plus role | Hard boundary |

Source: https://neon.com/pricing (read 2026-11-25). Branches are 10 per project on Launch, 25 on Scale, so branch per store is not an option either.

RLS check (section above): every table with `store_id` has RLS enabled in migrations. ADR-0014's runtime role `app_runtime` is not the owner and has no bypass; cross-store tests exist in `src/lib/store-isolation.test.ts` (skipped without a database) and `src/lib/platform-tables-rls.integration.test.ts` `[verified: files exist; not run]`. Gap: nothing in CI enumerates the catalogue and fails when a new table gets `store_id` but no policy `[verified: grep for pg_policies and relrowsecurity found only migration-specific tests]`.

**Recommendation:** stay shared. A dedicated project is worth it only for a single store with a contract that requires it, or one store whose load hurts the others for a measured reason. Add the CI guard (ticket T9).

## 5. Everything else per tenant

| Resource | State | Recommendation |
|---|---|---|
| Stripe Connect | One account per store (`stripeAccountId` unique). | No change. Money isolation is already per tenant. |
| WhatsApp (ADR-0010) | Store's own number through Embedded Signup; store pays Meta. Shared Meta app, inbound routed by `phone_number_id`. | Marginal cost to us $0. Meta quality limits per store were not researched `[UNVERIFIED]`. |
| AI spend | Platform-wide $10 a day default; per-store chat counts by plan (ADR-0021: 1,000 and 5,000 a month). | Add `store_id` to spend rows and a per-store daily dollar cap, so one store cannot use the whole day's budget. |
| Rate limits | `app_rate_limits` keyed by IP. | Add store-keyed limits on assistant, MCP catalogue and checkout so a busy store cannot starve the shared limit. |
| Inngest | Store key only on courier dispatch (`courier-functions.ts:115`, limit 1). | Add `concurrency: { key: "event.data.storeId", limit: N }` to order-driven functions. Docs: "the limit applies separately to each evaluated value"; a function can have up to 2 concurrency constraints (https://www.inngest.com/docs/guides/concurrency, read 2026-11-25). Plan ceilings still apply: Free 5 concurrent steps; Pro 100, then $25 per 25 more (https://www.inngest.com/pricing). A per-store key stops one store using all slots; it does not add slots. |
| Cron fan-out | Digest and report page 100 stores a step, serially. | Fine now. A slow store delays the rest of its page. Accept, or split to one event per store (costs more executions; ADR-0012). |
| Logs | Vercel runtime logs: 1 hour on Hobby, 1 day on Pro (https://vercel.com/docs/plans/hobby). Drains are Pro only. | Put `storeId` in every structured log line and every Sentry event as a tag (Sentry tagging not researched `[UNVERIFIED]`). |

## 6. The control plane

### What exists
- `approveStoreApplication` (`src/lib/store-application/service.ts`): one transaction creates the store in status `setup`, claims the application, writes the owner invite and audit rows. After commit: invite email, then `requestCourierRegistration` (queued; a daily retry finds stores still unregistered) `[verified: read]`.
- `registerStoreCouriers`: registers each provider once, saves failures on the store and never throws.
- `addDomainToStore`, `getDomainStatus`, `removeDomainFromStore` with audit rows, called from a platform-admin route.
- Stripe Connect onboarding is owner-driven (ADR-0020 names `/api/stripe/connect`).
- No deprovision or offboarding code `[verified: grep for offboard, deprovision, deleteStore, closeStore: none]`.

### Proposed `store/provision` job
One Inngest function, event id `store-provision-<storeId>` (24-hour dedupe, as with `order/authorized`), one row per step in a `store_provisioning_steps` table (`store_id`, `step`, `status`, `attempts`, `error`, `done_at`). Each step reads its own row first and skips if done. A failed step never blocks the others that do not depend on it.

| # | Step | Does | Idempotent because | Depends on |
|---|---|---|---|---|
| 1 | Reserve | Slug check against reserved and released slugs; store row `setup` | Unique slug | none |
| 2 | Address | Nothing to call: the wildcard already serves `slug.platform.com`. Optionally fetch the URL to confirm | Read only | 1 |
| 3 | Email identity | Set sender `slug@mail.platform.com`, Reply-To from owner email. No API call under option (a) | Pure data | 1 |
| 4 | Storage | Nothing to create. Record the prefix `stores/<id>/` | Pure data | 1 |
| 5 | Owner invite | Existing invite email, with the Resend idempotency key | Existing | 1 |
| 6 | Courier registration | Existing `registerStoreCouriers` | Skips if already registered | 1 and address |
| 7 | Stripe | Owner-driven; job records status from the `account.updated` webhook | Stripe account id stored | 5 |
| 8 | WhatsApp | Owner-driven (Embedded Signup); record status | Phone number id unique | 5 |
| 9 | Custom domain (Pro) | `addDomain`, show records from Vercel, poll verification, re-poll daily | Vercel returns "exists" for a repeat add; treat as success | 7 and Pro plan |
| 10 | Activate | Status `setup` to `active` when the owner's go-live checklist passes | Conditional update | 5, 6, 7 |

Add an admin view listing stores with a failed or stuck step and a Retry button. The daily courier retry is the model.

### Proposed `store/deprovision` job
Triggered by an owner request or a platform admin. Orders and fee rows are financial records; do not delete them `[retention period UNVERIFIED, ask the accountant]`.

| # | Step | Does |
|---|---|---|
| 1 | Suspend | Status `suspended` (exists); stop crons for the store |
| 2 | Export | Owner downloads orders and customers |
| 3 | Hold | 30-day wait (our choice), reversible |
| 4 | Domain | `removeDomainFromStore` (exists); tell owner to remove DNS |
| 5 | Email | Nothing under (a); remove the Resend domain if option (c) was used |
| 6 | Storage | Delete `stores/<id>/` objects; keep proof photos while disputes are possible |
| 7 | Stripe | Close the connected account only once its balance is zero (not researched `[UNVERIFIED]`) |
| 8 | Data | Remove personal data, keep order and ledger rows. Some foreign keys have no `onDelete: Cascade` (for example `schema.prisma` lines 197, 439, 460), so a plain store delete would fail or orphan rows |
| 9 | Slug | Reserve the slug for a period before release |

### How others do it
- **Vercel Platforms:** one codebase, one deployment, tenants found by host; wildcard for subdomains, per-tenant custom domains added by SDK and verified; one wildcard certificate plus one certificate per custom domain; delete the domain from the project and the account on cancel (https://vercel.com/docs/platforms/multi-tenant-platforms/concepts and `.../configuring-domains`). We match this. Vercel also describes a multi-project mode (a project per tenant) for tenants needing custom code; we do not.
- **Shopify:** a `myshopify.com` address at signup, then a bought or connected domain; email authentication with automatic Cloudflare DNS (help pages above). The domain-connect shortcut is a possible later feature for stores whose DNS is on Cloudflare.
- **Squarespace:** a store connecting a third-party domain adds a verification CNAME (unique code to `verify.squarespace.com`), a `www` CNAME and four A records for the root; if the verification record is missing the domain unlinks after 15 days (search summary of https://support.squarespace.com/hc/en-us/articles/205812378-Connect-a-third-party-domain-to-your-Squarespace-site `[UNVERIFIED]`, not read in full). Takeaway: show owners exact records, check them for them, and say what happens if they are wrong.

## 7. Cost table

### Assumptions (change these and the table moves)
- A store does 250 orders a month. ADR-0012's amendment measured about 36 Inngest executions per order and about 30,600 idle executions a month for the whole platform (https://www.inngest.com/docs/usage-limits/inngest per ADR-0012). I use 250 orders a month a store, so 1,000 stores is 250,000 orders; ADR-0012's seeded load was 300,000.
- About 4 emails per order, so 1,000 emails per store per month.
- Vercel and Neon usage lines are my estimates. ADR-0012 measured Neon only on a local database, never on Neon.
- Excluded: Stripe fees, courier, SMS, WhatsApp, AI model cost, tax. Those are per order and sit in ADR-0021.

### Prices used (all read 2026-11-25)
- Vercel Pro $20 a month plus $20 per developer seat; Pro usage: 1 TB transfer, 10M requests included; $2 per extra 1M requests; $0.60 per 1M function invocations (https://vercel.com/pricing). Whether the first seat is inside the $20 was not clear `[UNVERIFIED]`.
- Neon Launch: $0.106 per CU-hour, $0.35 per GB-month, no base (https://neon.com/pricing).
- Resend: Free $0; Pro $20 (50k) or $35 (100k); Scale $650 (1M) (https://resend.com/pricing).
- Inngest: Free 50k executions; Pro $99 with 1M, overage $50 per 1M in the table or tiered down to $15 in the FAQ, so I show a range (https://www.inngest.com/pricing).
- R2: $0.015 per GB-month, free egress (https://developers.cloudflare.com/r2/pricing/).
- Cloudflare DNS and Email Routing: no charge found on pages read; Cloudflare for SaaS not used.
- Domain: platform domain about $10 a year at Cloudflare's at-cost price; the exact price was not read `[UNVERIFIED]`.

### Monthly cost

| Line | 1 store | 10 stores | 100 stores | 1,000 stores |
|---|---:|---:|---:|---:|
| Vercel Pro plan and one seat | $20 | $20 | $20 | $20 |
| Vercel usage over included `[ESTIMATE]` | $0 | $0 | $0 to $50 | $100 to $400 |
| Neon `[ESTIMATE]` | $10 to $20 | $20 | $40 to $60 | $150 to $400 |
| Resend (1k emails per store) | $20 (Pro, since Free caps at 100 a day) | $20 (Pro) | $35 (Pro 100k) | $650 (Scale 1M) |
| Inngest (idle + 36 per order) | $0 (about 40k, Free) | $99 (120k) | $99 (about 0.93M) | $200 to $500 (about 9M) |
| R2 `[ESTIMATE]` | $0 | $0 | $1 | $2 to $10 |
| Platform domain | $1 | $1 | $1 | $1 |
| **Total** | **about $51 to $61** | **about $160** | **about $196 to $266** | **about $1,120 to $1,980** |
| Per store | $51 to $61 | $16 | $1.96 to $2.66 | $1.12 to $1.98 |

Reading it:
- The fixed floor is about $159 a month (Vercel $20, Neon about $20, Resend Pro $20, Inngest Pro $99) from the 10th store. Store 1 is already on Vercel Pro (commercial use) and Resend Pro, so it costs $51 to $61; Inngest stays on Free until about 40k executions.
- Cost per added store is orders, not provisioning. A store's subdomain, sender address and storage prefix cost $0.
- Starter is $49 and Pro $99 (ADR-0021). At 1,000 stores on Starter ($49,000 a month) the platform cost is about 2 to 4% of subscriptions `[ESTIMATE]`.
- If we added a Resend domain per store (options b or c) for every store: at 100 stores Pro $35 plus one $20 add-on (110 domains) is $55, +$20 over the recommended setup; Scale $90 is the other route. At 1,000 stores Scale at 1M emails already includes 1,000 domains, so a store each is at the ceiling.
- If we used Cloudflare for SaaS for 1,000 own domains: 900 over the free 100 at $0.10 is $90 a month. Vercel Pro costs $0 for those, so (c) loses.
- Store-owned custom domains cost the store its registrar fee (not read `[UNVERIFIED]`).

## 8. Does our pricing cover it?

Short answer: **at 250 orders a store a month, no plan loses money, because the 3% customer service fee earns about $337 a store, far more than the subscription.** The subscriptions alone cover infrastructure but not a store that runs its full AI cap on the Sonnet model. Three things can hurt: the Stripe Connect fee model (unchecked, up to about $31 a store), the courier card-fee loss on Pro, and the AI cap being a count, not dollars.

### Assumptions (change them and the table moves)
- Plans: Starter $49, Pro $99 (`PLAN_PRICES_USD` in `src/lib/billing/plan.ts`). Mix 70% Starter, 30% Pro; one store is Starter.
- Basket: $45 of goods (stated; I did not find an average in the seed). Service fee 3% of goods, minimum $0.99, maximum $2.99 (`ADR_0021_SERVICE_FEE` in `src/lib/order/platform-fee.ts`), so $1.35 an order, **$337.50 a store a month** at 250 orders. The customer pays it; the store pays 0% commission.
- Pilot offer: first 5 stores, 3 months free (`PILOT_STORE_CAP`, `PILOT_FREE_MONTHS` in `src/lib/billing/service.ts`). Left out of the steady-state table; its cost is $147 per Starter store and $297 per Pro store of subscription not collected, plus the store's running costs, so about $0.7k to $1.5k for five stores.
- Platform card fee: we bear 2.9% on the service fee ($9.79 a store) and on courier fees (`platform-fee.ts` header). Pro only has courier delivery; I assume 30% of Pro orders go by courier at the ADR's $8.99 example fee, so $19.55 a store a month. The courier price itself is passed through.
- Stripe on our subscription charge: 2.9% + 30¢ card fee plus Stripe Billing 0.7% (https://stripe.com/pricing, read 2026-11-25): $2.06 on Starter, $3.86 on Pro.
- SMS: 3 parts an order at Telnyx $0.004 plus an average carrier fee about $0.0045 (AT&T $0.0035, Verizon and T-Mobile $0.0045, others none) (https://telnyx.com/pricing/messaging, read 2026-11-25), so about $0.0085 a part, **$6.38 a store**. 10DLC registration fees were not on the page `[UNVERIFIED]`. Email is inside the platform cost of section 7, so it is not counted twice.
- Platform fixed cost per store: section 7's midpoints divided by store count: $56, $160, $231, $1,550 for 1, 10, 100, 1,000 stores.
- AI cost per shopper chat `[ESTIMATE]`: tokens per chat were not measured. ADR-0021 states $0.001 to $0.01 a chat on Haiku 5.5 (the #146 eval ran about $0.001 a case). I use $0.003 typical and $0.01 worst on Haiku. For Sonnet 5.5 I use $0.05 (about 18k input and 1.5k output tokens). Prices are in `src/lib/assistant/cost.ts` and match Anthropic's page: Haiku 5.5 $0.10 in, $0.50 out per million tokens (up to 100k-token prompts); Sonnet 5.5 $2 in, $10 out; Haiku's price is 5 times higher past a 100,000-token prompt (https://platform.claude.com/docs/en/about-claude/pricing, read 2026-11-25). The default model is Haiku when `ASSISTANT_MODEL` is unset (`src/lib/assistant/model.ts`). Store assistant (Pro): 600 owner chats a month, $0.005 typical, $0.01 worst on Haiku.
- Typical use: 300 shopper chats a month on Starter, 600 on Pro. Full cap: 1,000 (Starter) and 5,000 (Pro) (ADR-0021).
- Courier: pass-through, not a cost.

### Stripe Connect fees: the biggest unchecked number
Stripe's Connect page lists two models (https://stripe.com/connect/pricing, read 2026-11-25). If Stripe sets the users' pricing, the platform pays no Connect fees. If we set the pricing (we do: `application_fee_amount` on destination charges, spec section 10), the platform pays **$2 per monthly active account, plus 0.25% + 25¢ per payout**. Which model our account is on, and whether payouts to a store count as "payout volume" for our destination-charge flow, was not checked `[UNVERIFIED]`. At $11,250 of goods a store a month paid weekly that is about **$31 a store a month** ($2 + $28.13 + $1.08). ADR-0021 does not list this cost. The table shows both cases. Ask Stripe, in writing, which model applies before the first paying store.

### Per store per month at 250 orders (steady state, 100-store allocation of $2.30)

| | Starter typical | Starter full AI cap, Haiku | Starter cap, Sonnet | Pro typical | Pro cap, Haiku | Pro cap, Sonnet |
|---|---:|---:|---:|---:|---:|---:|
| Subscription | $49.00 | $49.00 | $49.00 | $99.00 | $99.00 | $99.00 |
| Service fee | $337.50 | $337.50 | $337.50 | $337.50 | $337.50 | $337.50 |
| **Revenue** | **$386.50** | $386.50 | $386.50 | **$436.50** | $436.50 | $436.50 |
| Stripe on subscription | $2.06 | $2.06 | $2.06 | $3.86 | $3.86 | $3.86 |
| Card fee on service fee | $9.79 | $9.79 | $9.79 | $9.79 | $9.79 | $9.79 |
| Courier card fee | $0 | $0 | $0 | $19.55 | $19.55 | $19.55 |
| SMS | $6.38 | $6.38 | $6.38 | $6.38 | $6.38 | $6.38 |
| AI | $0.90 | $10.00 | $50.00 | $4.80 | $56.00 | $280.00 |
| Platform share | $2.30 | $2.30 | $2.30 | $2.30 | $2.30 | $2.30 |
| **Cost** | **$21.4** | $30.5 | $70.5 | **$46.7** | $97.9 | $321.9 |
| **Margin** | **$365 (94%)** | $356 (92%) | $316 (82%) | **$390 (89%)** | $339 (78%) | $115 (26%) |
| Margin if Connect fees are $31.21 | $334 (86%) | | | $359 (82%) | | |

(Computed from the assumptions above; I ran the arithmetic in a throwaway script, not in the app.)

### The same, for all stores (70/30 mix; one store is Starter)

| Stores | Revenue | Margin, typical | Margin, all at full AI cap on Haiku | Margin, all at cap on Sonnet | Margin, typical plus Connect fees |
|---|---:|---:|---:|---:|---:|
| 1 | $387 | $311 (81%) | $302 (78%) | $262 (68%) | $280 (73%) |
| 10 | $4,015 | $3,588 (89%) | $3,371 (84%) | $2,419 (60%) | $3,276 (82%) |
| 100 | $40,150 | $37,249 (93%) | $35,076 (87%) | $25,556 (64%) | $34,128 (85%) |
| 1,000 | $401,500 | $373,248 (93%) | $351,518 (88%) | $256,318 (64%) | $342,040 (85%) |

### Where it can lose money
- **Subscription only (a store with almost no orders):** Starter keeps $43.70 with typical AI and $34.60 at full cap on Haiku, but loses $5.40 at full cap on Sonnet. Pro keeps $88.00 typical and $36.80 at cap on Haiku, but **loses about $187 at full cap on Sonnet** (5,000 chats at $0.05, plus the owner's assistant). So the Sonnet cap, not the subscription price, is the risk.
- **Pilot stores** earn only the service fee for 3 months by design.
- **Pro courier share:** each courier order costs us 2.9% of the courier fee, about $0.26. At 30% courier share that is $19.55 a store; at 100% it is $65. The ADR-0021 example shows the same $0.26 loss.
- **Platform AI cap:** `ASSISTANT_SPEND_CAP_USD` defaults to $10 a day for all stores together (about $300 a month), and the spend tables have no `store_id` (`src/lib/assistant/spend.ts`). At 100 stores on typical use ($90 to $500 a month) that platform cap will stop the assistant for everyone on busy days. That is an availability problem more than a margin problem.

### What would fix it (recommended, in order)
1. **Cap AI by dollars per store, not only by chat count** (ticket T11): for example $5 a month on Starter and $25 on Pro on Haiku, and no Sonnet for shopper chat without an eval. A count cap hides a 20x price difference between models.
2. **Ask Stripe which Connect model applies** and put the answer in ADR-0021. If it is $31 a store, it is still under 10% of the service fee, so no price change; but it must be in the margin sheet.
3. **Courier card fee:** either add the 2.9% to the courier quote shown at checkout, or accept $19.55 a Pro store a month. Do not change ADR-0006's "no markup" without the owner.
4. **No price change needed at 250 orders.** At low volume the plans still pay for themselves. Revisit the $49 price only if the owner wants a lower entry price, for example $29, which would still be profitable on subscription alone (about $23 after Stripe, platform share and typical AI).

### Compared with other builders (read 2026-11-25)

| | Monthly | Online card rate | Notes |
|---|---:|---|---|
| Ours: Starter / Pro | $49 / $99 | Store pays 2.9% + 30¢ on its goods (card fee split, ADR-0021). Customer pays a 3% service fee, $0.99 to $2.99 | No commission to the store |
| Shopify Basic / Grow / Advanced | $39 / $105 / $399 monthly; $29 / $79 / $299 on yearly billing | 2.9% + 30¢ on Basic; extra 2% on Basic if a third-party gateway is used | https://www.shopify.com/pricing. Shopify Basic is $10 cheaper than Starter, but has no grocery features, assistant or courier. |
| Square Online (Square) Free / Plus / Premium | $0 / $49 / $149 per location | 3.3% + 30¢ on Free; 2.9% + 30¢ on Plus and Premium | https://squareup.com/us/en/pricing (Free and Plus read; Premium from a search summary, [UNVERIFIED]) |
| Wix Core / Business / Business Elite | $29 / $39 / $159 on yearly billing; $36 / $46 / $172 monthly | Not checked | Wix's own pages through a search summary only; its pricing page did not load [UNVERIFIED] |
| Instacart | Not published for retailers | Not published | Its pricing pages cover customer fees only. Third-party blogs say 5 to 10% or 15 to 30% of the order [UNVERIFIED]. |
| Weee! third-party sellers | Not published | Not published | One unofficial source says 10% [UNVERIFIED]. |

On our $11,250 a month of goods, a 10% marketplace take would be $1,125 and a 15 to 30% take $1,690 to $3,375, against our $49 to $99 plus a $337 fee that the shopper pays. The pitch holds if the numbers are right, but the marketplace rates above are not from the marketplaces, so do not print them.

## 9. Cheaper or open-source alternatives

Method: each provider's price from its own page (read 2026-11-25), lock-in depth from grepping `src`, EUR prices not converted. Hetzner prices are in EUR and exclude VAT; I use $1 = €1 as a rough stand-in `[ASSUMPTION]`.

### Lock-in depth (read from the code)

| Provider | How wrapped | Files touched | Switch effort |
|---|---|---|---|
| Vercel | No `@vercel/*` package; `vercel.json` only skips builds. Uses Vercel's domain API (`vercel-domains.ts`), `x-vercel-forwarded-for` header (`auth.ts`), `VERCEL_*` env checks, `unstable_cache`/`revalidateTag` (29 files use `next/cache` or `VERCEL_*`; 5 use `unstable_cache`) | 29 | Medium. Next.js self-hosts, but cache sharing across several instances needs a cache handler `[UNVERIFIED]`, and wildcard TLS, DDoS cover and deploys become ours |
| Neon | Plain Postgres through `@prisma/adapter-pg` and `pg`; no Neon driver. Roles by plain SQL (ADR-0014). Per-PR database branches are a Neon feature | `db.ts`, env | Low for the data; medium for preview databases |
| Resend | One file `src/lib/email/send.ts` (`ResendSender`), plus the Resend `Idempotency-Key` the digest retry relies on (spec #467) | 1 | Low, but idempotency must be rebuilt |
| Inngest | 22 functions via `inngest`'s `createFunction`; durable timers, cron, concurrency (ADR-0016) | `src/lib/inngest/*`, `courier-functions.ts` | High to rewrite; none to self-host the same server |
| R2 | S3 client with an endpoint and keys; one file `r2.ts` plus audit scripts | 4 | Low: change endpoint and credentials |
| Telnyx | Behind `SmsSender` in `notifications/sms.ts` | 1 | Low |
| Anthropic | `@ai-sdk/anthropic` in `assistant/model.ts`; a patch file for `@ai-sdk/anthropic` exists; price table in `cost.ts` | 2 to 3 | Low for another Claude model; medium for another vendor (re-run evals) |
| Better Auth | Open source, in-repo | n/a | Already open source |
| Stripe | Connect destination charges, Billing, `stripe` SDK in `src/lib/stripe`, `src/lib/billing` | many | High; see below |

### Option by option

| Service | Today (10 / 100 stores) | Alternative and its price | Operations burden | Verdict |
|---|---|---|---|---|
| **Vercel** | $20 / $20 to $70 | **Hetzner VPS with Coolify or Dokploy.** US locations only (Hillsboro, Ashburn): CPX11 2 vCPU 2 GB €17.99, CPX21 3 vCPU 4 GB €32.49, CPX31 4 vCPU 8 GB €62.99, CPX41 8 vCPU 16 GB €120.99, 1 to 4 TB traffic (https://www.hetzner.com/cloud/regular-performance/). EU is cheaper (CPX32 €35.99) but far from US shoppers. About $35 at 10 stores, $130 to $250 at 100 (two app servers plus a database server). Coolify and Dokploy are open source (licences not stated on the pages I read `[UNVERIFIED]`); Dokploy lists scheduled Postgres backups to S3-compatible storage. **Cloudflare Workers** $5 a month, 10M requests, no egress (https://developers.cloudflare.com/workers/platform/pricing/); ADR-0013 rejected it for adapter churn and Node middleware. **Netlify** Pro $20 with 3,000 credits at 20 credits a GB (https://www.netlify.com/pricing/). **Railway** Hobby $5, Pro $20 plus $20 per vCPU-month and $10 per GB-month (https://railway.com/pricing). Render not checked. | Self-host: we patch the OS and Docker, run on-call, build zero-downtime deploys, wildcard TLS by DNS challenge, and own DDoS (ADR-0020 keeps Cloudflare DNS-only). Netlify and Railway: same shape as Vercel, no saving. | **Keep.** The VPS only wins on cash above roughly $300 a month of Vercel usage, and costs engineering time. Reconsider past 300 stores. Not Workers (ADR-0013 stands). |
| **Neon** | about $20 / $40 to $60 | **Supabase** Pro from $25 with 8 GB disk and a $10 credit covering a Micro instance (1 GB RAM, shared); Small is $15; daily backups kept 7 days; point-in-time recovery $100 a month (https://supabase.com/pricing). About $25 / $30. **Self-hosted Postgres** on the same VPS: $0 extra at 10 stores. | Supabase: managed, same Postgres. Self-hosted: we are the DBA (backups, upgrades, restore tests). | **Keep.** A saving of $10 to $30 does not pay for a migration and loses PR database branches. Re-quote at 100 stores. Hetzner managed Postgres was not found `[UNVERIFIED]`. |
| **Resend** | $20 / $35 | **Amazon SES** $0.10 per 1,000 emails; dedicated IP $24.95 a month; deliverability dashboard $0.07 per 1,000 (https://aws.amazon.com/ses/pricing/). About $1 / $10. **Postmark** Basic $15 for 10,000, overage $1.80 per 1,000; Pro $16.50, $1.30 per 1,000 (https://postmarkapp.com/pricing): dearer than Resend at 100k emails. Self-hosted mail: not advised. | SES: we handle bounce and complaint feeds, sandbox exit, no idempotency key (rebuild dedupe) `[UNVERIFIED for SES]`. | **Keep through 100 stores. Switch to SES near 300 stores** (about 300k emails, when Resend's bill passes about $250 and SES would cost about $30). At 1,000 stores Resend Scale is $650 against about $100. One file to change. |
| **Inngest** | $99 / $99 (Free up to 50k executions) | **Self-hosted Inngest:** supported as of its 1.0 release, SQLite by default, Postgres and Redis for scale; `inngest start` is labelled Beta; no automatic cleanup of old rows; no support guarantee (https://www.inngest.com/docs/self-hosting). Same SDK; set `INNGEST_BASE_URL` and keys. About $0 to $35 a month on the VPS. License is not stated on that page `[UNVERIFIED]`; ADR-0016 says SSPL converting to Apache 2.0. **Trigger.dev** Free $0 ($5 credit), Hobby $10, Pro $50, $0.000025 a run plus per-second compute (https://trigger.dev/pricing): different model, needs a rewrite. **graphile-worker or pg-boss** on Postgres: cron, retries, up to 10,000 jobs a second (https://worker.graphile.org/); needs an always-on worker, which ADR-0016 rejected because it keeps Neon awake. | Self-host: we run the queue, Redis, retention and upgrades; if it is down, orders do not move. | **Keep Inngest.** Free until about 40k executions, then Pro $99. **Switch to self-hosted Inngest when the bill passes about $300 a month** (about 250 stores at 250 orders), if the owner accepts the on-call load. No code rewrite. |
| **R2** | $0 / $1 | **Backblaze B2** $6.95 per TB a month, egress free up to 3x stored (https://www.backblaze.com/cloud-storage/pricing); R2 is $15 per TB. **MinIO** community repo is archived and "no longer maintained" since 2026-04-25 (https://github.com/minio/minio): avoid. **Garage** is S3-compatible and light (1 GB RAM) with 3-zone replication (https://garagehq.deuxfleurs.fr/); licence not stated `[UNVERIFIED]`. | Self-hosting storage means disks, replication and repair. | **Keep.** The saving is cents at 100 stores. |
| **Telnyx SMS** | about $6.4 a store | Already the cheaper option than Twilio (ADR-0017; Twilio not re-checked). Real saving: send fewer texts. | None. | **Keep.** Make SMS default to key events (ready, out for delivery) and use push, email and WhatsApp for the rest. |
| **Anthropic** | $1 to $5 a store typical | Cheaper tiers already in code: Haiku 5.5 is $0.10 / $0.50 against Sonnet 5.5 at $2 / $10, 20 times more. Batch is 50% off for non-interactive jobs; cache hits cost 0.1x (Haiku) or 0.05x (Sonnet 5.5) of input. Open-weight models: not evaluated. | None. | **Keep Haiku as the default.** Guard prompts under 100,000 tokens (Haiku's 5x tier). Use Batch for the daily AI review and digests if they are not time-critical. |
| **Better Auth** | $0 | Already open source. | We run it. | Keep. |
| **Stripe** | card fees, Billing 0.7%, Connect fees `[UNVERIFIED]` | No equivalent for Connect with destination charges and store onboarding was researched; Adyen for Platforms, PayPal and others were not checked `[UNVERIFIED]`. | n/a | **Keep.** Stripe Billing's 0.7% is $0.34 to $0.69 a store; not worth replacing. |

### Recommended stack and total (monthly, [ESTIMATE])

| | Current stack | Recommended | Everything self-hosted (VPS) |
|---|---|---|---|
| Hosting | Vercel Pro $20 | same | Hetzner US servers, about $35 (10 stores), $130 to $250 (100) |
| Database | Neon about $20 / $40 to $60 | same | on the VPS, $0 extra, plus our DBA time |
| Email | Resend $20 / $35 | same; SES at about 300 stores | SES about $1 / $10 |
| Jobs | Inngest $0 to $99 / $99 | same; self-host at about 250 stores | self-hosted Inngest, $0 extra |
| Storage | R2 $0 / $1 | same | Backblaze about $0 / $1 |
| Other | domain $1 | same | domain $1 |
| **Total at 10 stores** | **about $160** | **about $160** | **about $60 to $100**, saves about $60 to $100 |
| **Total at 100 stores** | **about $196 to $266** | **about $196 to $266** | **about $200 to $330**, no saving |
| **Total at 1,000 stores** | **about $1,120 to $1,980** | about $500 to $1,000 after the two switches (SES about $100, self-hosted Inngest about $50 to $100) | not estimated |

Reading it:
- The self-hosted stack saves only at 10 stores, and by $60 to $100 a month against engineer time and no on-call cover. At 100 stores it costs the same or more, because Vercel and Neon scale to our traffic and a VPS is paid whether used or not.
- The two switches that matter are SES and self-hosted Inngest, both at hundreds of stores, and both are small code changes (one file; a base URL).
- The owner's "lock in" worry is answered by the table: every paid service is behind one file or an SDK, except Inngest (22 functions) and Stripe Connect (many files). Inngest can be self-hosted without a rewrite; Stripe has no alternative.

## Candidate tickets

Each has acceptance criteria (AC). Owner-only steps are marked and fit the `wizard` skill.

- **T1 (owner): Buy platform domain and set wildcard DNS.** AC: `PLATFORM_ROOT_DOMAIN` is set in production before any custom domain is added (an unset value makes `mamangozi.com` resolve as slug `mamangozi`); `https://x.platform.com` shows the app with a valid certificate; `_acme-challenge` NS records exist; an unknown slug returns the existing not-found page.
- **T2 (owner): Move Vercel to Pro and Resend to Pro before the first paying store.** AC: plan pages show Pro; ADR-0013, 0017, 0020 amended to say so.
- **T3: Public Suffix List entry and cookie check for the platform domain.** AC: PSL pull request open; test shows a store subdomain cannot set a cookie that another store's subdomain receives.
- **T4: Platform sender.** AC: `mail.platform.com` verified in Resend; `EMAIL_FROM` set; every store email says `Name <slug@mail.platform.com>` with a Reply-To of the store's contact address; DMARC record present.
- **T5: Per-store bounce and complaint counters.** AC: Resend webhook updates a per-store count; a store over the threshold has its non-essential email paused and an admin is told.
- **T6: Custom domain flow fixed.** AC: owner sees the exact A or CNAME and TXT records from Vercel, not a hard-coded value; "ownership verified" and "DNS pointing" are stored separately and magic links use the second; `www` added with a redirect; Pro-only; polling job updates status.
- **T7: Slug reservation.** AC: a released slug cannot be taken for the set period; infrastructure labels added to `RESERVED_SLUGS`.
- **T8: Store-prefixed object keys.** AC: new proof and issue-photo keys include the store id; a helper deletes all objects under a store prefix; existing keys still read.
- **T9: RLS catalogue guard in CI.** AC: a test lists every public table with `store_id` and fails if RLS, FORCE or a policy is missing; the 13 platform tables are an explicit allow-list.
- **T10: Per-store Inngest concurrency keys.** AC: order-driven functions (not only courier dispatch) set `concurrency.key` to the store id; a test shows one store's 50 queued runs do not delay another store's run.
- **T11: Per-store AI spend and rate limits.** AC: assistant and MCP rate keys include the store id as well as the IP; spend rows carry `store_id`; a per-store daily cap stops one store only; the admin spend view groups by store.
- **T12: `store/provision` job with step table and admin retry view.** AC: the approval creates the job; each step is skipped on re-run; a forced failure in step 6 leaves other steps done and shows Retry; running the job twice changes nothing.
- **T13: `store/deprovision` job.** AC: suspend, export, hold, domain removal and prefix delete run in order; orders and ledger rows survive; the slug is reserved; a re-run changes nothing.
- **T14: `storeId` in logs and Sentry tags.** AC: a log line from checkout, a job and an API route each carry `storeId`.
- **T15 (later, only if asked): Store's own sending domain.** AC: Pro store adds a domain; app creates it in Resend, shows records, verifies, then switches the sender; falls back to the platform sender on failure.
- **T16: Margin sheet and Stripe Connect fee check.** AC: Stripe confirms in writing which Connect pricing model applies; ADR-0021 lists it; a short sheet reproduces section 8's table from real order data once the pilot has 30 days.
- **T17: Dollar cap on AI per store.** AC: `assistant_spend` rows carry `store_id`; a monthly dollar cap per plan stops that store only; Sonnet is not selectable for shopper chat without an eval record.
- **T18 (later, trigger-based): SES sender.** AC: a second `EmailSender` with its own bounce and complaint feed and its own dedupe key; switched on only when Resend's monthly bill passes about $250.
- **T19 (later, trigger-based): self-hosted Inngest.** AC: a run book (backup, upgrade, retention), a staging run of all 22 functions against the self-hosted server, and a rollback to Inngest Cloud by changing `INNGEST_BASE_URL`.
- **T20: Cut idle Inngest runs to stay inside the free 50,000 a month.** AC: idle executions with zero orders measured before and after; scheduled functions run only as often as their deadline needs; two stores at 250 orders a month project under 40,000 executions.

## Not checked

- I did not run the app or any probe against Vercel, Resend, Cloudflare or Neon; no account, key, domain or resource was created.
- I did not read each RLS policy's text, Stripe's rules for closing a connected account, Resend's treatment of subdomains in its quota, Cloudflare Registrar's TLD list and price, domain prices, Sentry's limits, Meta's per-number quality limits, or retention law.
- The cost table's Vercel, Neon and Inngest-at-scale lines are estimates from my stated assumptions.
- Sections 8 and 9: tokens per AI chat, SMS per order, average basket, courier share and the Hetzner dollar price were assumed, not measured. Stripe's Connect fee model for our account, SES idempotency, Render, Twilio, Wix, Square Premium, Instacart and Weee! seller fees were not read from a primary page. I did not run the app or any code.
