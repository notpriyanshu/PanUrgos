# PanUrgos download signup — design

Date: 2026-11-17 · Status: draft for approval

## Intent

Every PanUrgos Studio download should come from a verified account, so we know how many real people have the product. The site is static (GitHub Pages at panurgos.com); accounts need a small backend. Chosen platform: **Cloudflare**.

## Goals

- A visitor can't get the installer without a verified email.
- An accurate user count: verified accounts, and downloads per platform.
- Stay true to the brand: collect the minimum, store no tracking data, and say plainly what's kept.

## Non-goals (for now)

- Passwords, social login or user profiles.
- Paid licences, teams or the Sovereign organisation product.
- Stopping someone who builds from the public source. The code is MIT; the gate counts downloads, it doesn't protect the code.

## Anti-goals

- No analytics scripts, ad pixels or third-party trackers on the site.
- No selling or sharing emails.
- No storing IP addresses or device fingerprints.

## Approaches considered

| Approach | Trade-off | Verdict |
|---|---|---|
| **Cloudflare Worker + D1 + private file store + Resend email** | Free at this scale, we own the data, real verification | **Chosen** |
| Supabase (auth + database + storage) | Fastest auth, but free storage caps files at 50 MB (installer is 120 MB) | Rejected |
| Email form service, then show a public link | Quick, but anyone can share or find the link, and it adds a third-party form | Rejected |

## How it works

1. **Download button** opens a panel on the site: email address + platform (Windows / macOS / Linux) + a consent line linking the privacy page.
2. The site sends `POST /signup` to the Worker. The Worker:
   - creates or finds the user in **D1** (a small Cloudflare database),
   - creates a single-use token valid for 30 minutes,
   - emails a magic link through **Resend**, from `downloads@panurgos.com`.
3. The visitor clicks the link: `https://panurgos.com/download/?t=<token>`. The page calls the Worker, which:
   - checks the token (unused, not expired),
   - marks the email verified and records a download for that platform,
   - streams the installer from private storage with a download filename.
4. Returning users repeat step 1; they get a fresh link. No passwords exist to leak.
5. macOS and Linux sign-ups are recorded, and the email says those builds are coming and that we'll write when they're ready (only if they ticked the box to be told).

## Data kept (D1)

- `users`: email, created_at, verified_at, platform, notify_opt_in.
- `downloads`: user_id, platform, version, at.
- `tokens`: hashed token, user_id, expires_at, used_at. Expired tokens are deleted daily.

Nothing else: no IP, no user agent, no cookies.

## Abuse limits

- Per-email cooldown: one link per 2 minutes, five per day.
- Cloudflare's built-in rate limiter by IP, applied in memory and never stored.
- Emails are validated for format; disposable-domain blocking is left out for now.

## Where the installer lives

The Worker streams the file, so the storage stays private. Two options:

- **R2** (Cloudflare file storage): free up to 10 GB with no download fees, but Cloudflare asks for a payment card to switch R2 on. Recommended.
- **Private GitHub release** in a private repo, read with a token kept as a Worker secret: free with no card, slightly more moving parts.

## Hosting the API

The Worker runs at `panurgos-api.<account>.workers.dev`, called from panurgos.com (CORS limited to panurgos.com). DNS stays at GoDaddy. Moving the domain's DNS to Cloudflare later would allow `api.panurgos.com`, but isn't required.

## Email

Resend sends from `downloads@panurgos.com`. That needs a few DNS records at GoDaddy (SPF, DKIM and a bounce MX on a sending subdomain), which I can add. The existing DMARC record stays.

## Site changes

- Download cards open the signup panel instead of linking anywhere.
- New `/download/` page that redeems the link and starts the download.
- New `/privacy/` page: what's collected, why, how long, how to delete (email us and we delete).
- Rewrite "No account. No sign-in. No email." and "You were not tracked here." to the truth: one email for downloads; no tracking, no cookies, no analytics.
- The site's content-security policy allows exactly one extra host: the Worker.

## User count

A protected `/stats` endpoint (secret key) returns verified users and downloads by platform and day. A tiny dashboard page can come later.

## What you need to do

1. Create a free **Cloudflare** account; sign in to it in the browser pane.
2. Create a free **Resend** account (3,000 emails a month, 100 a day).
3. Decide: R2 with a card on file, or the private-GitHub-release route.
4. Provide a contact address for the privacy page (deletion requests).

## Left to the builder

Exact copy and styling of the signup panel and emails, table indexes, token length (32 random bytes, stored as SHA-256), and test plan.
