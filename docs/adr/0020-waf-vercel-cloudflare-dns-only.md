# 20. Put the application firewall on Vercel, and leave Cloudflare as DNS only

Date: 2026-11-05 · Status: accepted

## Context

The app already runs on Vercel, with Cloudflare in front of DNS and image assets (ADR-0013). A second firewall at Cloudflare would have to proxy the hostname, terminate TLS, and sit in front of Vercel. That fights the hosting decision and is a production change this ticket does not make.

Vercel documents the current firewall limits at [vercel.com/pricing](https://vercel.com/pricing) and [the WAF usage page](https://vercel.com/docs/vercel-firewall/vercel-waf/usage-and-pricing) (checked 2026-11-05):

- Custom rules: Hobby 3, Pro 40, Enterprise 250. DDoS mitigation, IP blocking, and custom rules are included. Pro IP blocking is 40 addresses. Pro system bypass rules are 10.
- WAF rate limiting is usage-priced. Pro's published rate-limit line starts at $0.50 per 1 million allowed requests. Managed OWASP rulesets are Enterprise only.
- This platform is already on Vercel Pro (ADR-0013), so the 40 custom rules are the ones available without a plan change.

## Decision

Use the Vercel Web Application Firewall. Keep Cloudflare DNS-only for the application hostnames: the Cloudflare proxy stays off, so Cloudflare does not terminate TLS or apply its own WAF to the app.

No Vercel, DNS, or plan setting is changed by this ticket. The owner applies the firewall.

## Owner steps

1. Open the Vercel project, then Firewall.
2. Add custom rules for the paths that do not already have an application limit: `/api/auth`, `/api/webhooks/stripe`, `/api/stripe/connect`, and `/api/invite/accept`. Start with log-only, then block once the audit log is quiet.
3. Leave the managed OWASP ruleset off unless the project moves to Enterprise.
4. Do not turn on the Cloudflare proxy for the app hostname. Image and asset hostnames stay as they are in ADR-0013.
5. Do not preload HSTS, and do not enforce the full Content-Security-Policy, until a browser pass confirms Stripe.js and the report-only policy. Those stay owner actions outside this ticket.

## Consequences

- Application rate limits in `app_rate_limits` stay the source of truth for search, chat, invites, and payment setup. The Vercel rules are a second layer, not a replacement.
- A Cloudflare proxy added later would have to be re-decided, because it would hide the visitor address Vercel writes into `x-forwarded-for`.
