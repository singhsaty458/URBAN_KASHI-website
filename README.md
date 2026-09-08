# URBAN KASHI — Independent menswear storefront

A **locally implemented full-stack ecommerce storefront** owned independently by URBAN KASHI: React/TypeScript, Express and its own SQLite database. **No POS integration, shared database, shared accounts, or calls to the neighbouring POS application; no synchronization ever.** Owner-supplied existing POS barcodes can be imported as text through CSV, without connecting to POS. No actual POS export file has been supplied or imported for verification. All work stays in this website workspace, never the adjacent POS project.

## Office-device execution hold — 8 September 2026

Following the reported corporate security alert, work on this office laptop is limited to **local source review and text edits until explicit IT approval**. The run, test, admin-creation, network-preview and deployment instructions below are reference instructions, not permission to execute them on this device. Do not start/restart services, run terminal commands or tests/builds, install/download dependencies, make app/browser/network requests, or change accounts/database contents during the hold. Do not bypass endpoint controls or change transports to work around a blocked operation. Have IT review the existing test transport workaround before any test rerun.

The latest static review checked admin authorization, direct photo uploads and sold-out lifecycle source/tests. It did **not** verify the running app, the owner's current admin role, uploaded files or new test results. See the [approval-gated verification checklist](docs/PAYMENTS_AND_CATALOGUE.md#approval-gated-verification-checklist).

## Run locally

Requires **Node.js 24+** and npm. On Windows PowerShell use `npm.cmd` if execution policy blocks `npm.ps1`.

1. Install dependencies: `npm.cmd install`.
2. Build: `npm.cmd run build`.
3. Start the compiled website and API: `npm.cmd start`.
4. Open **http://127.0.0.1:8080**.

Alternatively, run `npm.cmd run dev`: Vite serves the UI on **http://127.0.0.1:5173**, proxying API requests to the independent server on port 8080. Restart/rebuild as appropriate after configuration changes.

If 8080 is already occupied, do **not** stop a POS process. Change `PORT` in your private environment using [.env.example](.env.example) as the template. For development, update the Vite proxy to match. The standalone production build only needs one port.

## What works

- Original modern fashion homepage with charcoal/champagne styling, bold typography, full-width editorial photography and responsive category cards. Inspired by contemporary clothing storefront patterns, not a copied Shopify theme or a Shopify integration.
- Three-slide moving hero with pan/zoom, previous/next/slide controls and a persistent **Pause motion** preference; a gently moving two-photo lookbook. Autoplay pauses on hover, keyboard focus, hidden tabs and offscreen content. Reduced-motion users get static photography with working manual slide controls.
- Real catalogue-powered **Your next rotation** tabs, four-piece selections, product/wishlist links and loading/error/empty states. Homepage styling is scoped; accounts, checkout, admin and inventory behavior remain unchanged.
- Locally bundled fonts and demo photographs, accessible bag/search/navigation dialogs and reduced-motion support. Hero/lookbook photographs are editorial placeholders, not automatic photos of newly imported stock.
- Bilingual अर्बन काशी / URBAN KASHI branding with a crisp gold trishul, locally bundled Noto Serif Devanagari and upright `rotateY` animation; reduced-motion disables the turn.
- Menswear catalogue: category, search, price sort, availability filter and product detail galleries.
- Sizes, stock-aware quantities, persistent local bag and wishlist; 10 units per product/size and 20 distinct bag lines.
- Customer registration, sign-in, sign-out and owner-only order history.
- **COD and optional Razorpay Checkout** with validated addresses, server-calculated prices, transactional stock reservations and idempotent retries. Online checkout is disabled unless complete server configuration is present; authorization or a browser callback alone never proves payment.
- Free shipping at ₹2,499; otherwise ₹99. All amounts use **integer INR rupees**.
- Admin dashboard: product creation/editing/hiding, variant stock, order list and controlled status transitions.
- Direct main/gallery photo uploads, server-side WebP compression and reference-safe unused-upload cleanup.
- All-sizes-zero listings show **Sold out** on their image for 48 hours, then soft-archive; admin records, barcodes, orders and referenced photos remain intact.
- CSV preview/confirmation import, custom sizes, brand/design/colour metadata, barcode/SKU text and historical order snapshots.
- Cancellation before shipping restores stock once. No client-supplied totals are trusted.

## Add existing products — one at a time

1. Create an owner admin if needed using the private CLI described under **Administrator access** below. There is no default password. Sign in at **http://127.0.0.1:8080/account**, then open **http://127.0.0.1:8080/admin**.
2. **Products & inventory → New product**. Fill name, unique slug, brand, design, category, colour, price and description. Use one product listing for each design + colour.
3. For each size row, enter the size, separately allocated website stock, the exact existing POS barcode and SKU. Use **Add size** for additional sizes; do not convert barcodes to numbers.
4. Use **Upload main photo** or **Upload gallery photos**: non-animated JPEG, PNG or WebP, at most **10 MiB and 40 million pixels per file**. Gallery selections upload sequentially, one file at a time, with server-confirmed previews and automatically filled paths; up to 12 gallery photos. HTTPS image URLs and safe same-site paths remain editable alternatives. A blank gallery uses the main image.
5. Keep **Active** checked to publish. **Featured** prioritizes the item in the homepage edit, which displays at most four matching pieces. Click **Create product** or **Save product** to attach uploaded paths; uploading alone does not save the product. Direct uploads need no rebuild. Cancelling leaves the saved product unchanged; any completed but unattached uploads follow the cleanup policy below.
6. Before trading, edit the seeded demo listings and uncheck **Active**. This hides them without deleting historical order records. Do not leave demo photography or stock presented as your real catalogue.

### Photo storage and sold-out lifecycle

The server receives raw binary image files, validates and decodes them, then stores **WebP at quality 82**, fitted within **1600 × 1600 px without upscaling**. Originals are not retained. Image content is stored as files, not database blobs/base64; product records store paths and the upload registry stores metadata. These files **use real disk storage**—compression is not zero storage.

The default private photo directory is **data/product-images**, beside the default SQLite database. `UPLOADS_PATH` is a server-only override; leaving it blank is valid and selects the database-sibling default. Keep it outside public/static directories. Managed uploads have a fixed default **200 MiB quota**; trusted integrations can override `AppOptions.uploadsQuotaBytes`, but **there is no quota environment variable**.

Uploads older than **24 hours** are eligible for cleanup only if unreferenced. Deletion requires a second reference check **at least 60 seconds later**. References from any product (including hidden/archived products) or historical order image retain the file. Archiving a product does not delete its photos; replacing/removing a path only makes the old upload eligible if nothing else references it.

When **every size has zero stock**, the server records the sold-out time. An Active listing shows **Sold out on its image for 48 hours**, then automatically soft-archives and disappears from the storefront while remaining in admin. Variants, barcodes, order snapshots and referenced images are preserved. Positive restock before the deadline clears the timer. Once archived, restock alone (including cancellation-restored stock) does not publish it: restock at least one size **and explicitly select Active** before saving. CSV republishing similarly requires positive stock and explicit `active=true`.

Maintenance runs every **60 seconds** for archiving and image cleanup. Lifecycle checks also run at request time and startup, catching up expired sold-out timers after downtime; this is not a payment reconciliation or reservation-expiry job.

## Product import — multiple products at once

1. Admin sign-in → download [public/catalogue-template.csv](public/catalogue-template.csv). Dummy rows ko real products/photos se replace karein; no real POS export has been supplied.
2. Excel mein barcode aur SKU columns **Text** rakhein **before** entering/importing codes. Leading zeros lost ho gaye toh website restore nahi kar sakti. Server limits: barcodes up to **128 characters**, SKUs up to **160**.
3. **One row per size**, one shared slug per **design + colour**; different colours need different slugs. Allocate website stock separately—no POS sync.
4. Save as **CSV UTF-8**. Upload is **CSV only, not XLSX**. Maximum **1,000 data rows** and **2 MiB for the entire JSON request**, including CSV escaping overhead; split large files below that limit.
5. Admin → **Preview / जाँचें** → fix row errors, review warnings → tick approval → **Confirm import**. Stock values replace supplied sizes' absolute website stock; old exports can incorrectly replenish sold/reserved stock.

## Online payments and operational limits

Configure the empty server-only Razorpay entries in [.env.example](.env.example) through a protected private environment. Never send passwords, API secrets or webhook secrets in chat. Only the public key ID reaches Checkout. Start with owner-controlled **test keys**, a **public HTTPS signed webhook**, and capture enabled in Razorpay; follow [docs/PAYMENTS_AND_CATALOGUE.md](docs/PAYMENTS_AND_CATALOGUE.md).

UPI, Cards, Netbanking, Wallets, EMI and Pay Later are conditional on merchant KYC/activation, transaction/customer eligibility and provider availability—not guaranteed enabled methods. No live or sandbox payment has been tested against Razorpay.

Partial, ambiguous or incomplete refund evidence sets `paymentReview`: confirmation/shipment and online revenue inclusion are blocked even if the stored payment status remains paid. Fully verified processed refunds can aggregate to the full amount; uncaptured refunded authorizations do not invent a `paidAt` timestamp. Already-shipped orders may still be recorded as delivered. Refunds are manual in the provider Dashboard; cancellation never issues a refund request.

The order page offers **Check payment status**, but **no resume-payment button**. A stuck pending/unknown payment keeps stock safely reserved; do not pay again or release stock based only on a timeout. Support must review the provider outcome, reconcile or recover via a verified webhook, then an admin may cancel a pre-shipment order to restore stock once. Late capture after cancellation requires a refund and never revives fulfilment.

Wishlist and bag belong to the browser/device; they are not synchronized between devices. Customer orders and inventory persist in the independent database.

## Administrator access

**There are no default admin credentials and no production test accounts.**

### Separate administrator portal

- **Admin sign-in:** `/admin/login`; after verified administrator authentication, `/admin` opens product management.
- **Customer portal:** `/account`; customer registration does not create administrators.
- A signed-in customer can switch accounts through admin sign-in. Wrong credentials or a customer-only account leave the existing session unchanged and do not open inventory.
- The panel supports creating/viewing/editing products, main/gallery photo uploads, sizes/stock and order management. To remove a listing from public view, edit it and clear **Active**. This is non-destructive removal, not permanent deletion; historical orders and photos remain preserved.

### Private owner setup (new or existing email)

**Run only in an approved environment after the execution hold is lifted.** The `admin:setup` script is a private interactive operator tool, not a browser endpoint. Run `npm.cmd run admin:setup` from the **website root**, never the POS project. It displays the database path, asks for the owner email/name, and requires typing `ADMIN <entered-email>` before asking for a new hidden password twice.

This flow **creates an admin if the email is new**, or **promotes the existing website account and replaces its password** if it already exists. It preserves the existing account ID and order history, and revokes that account's old sessions. Use a unique password (10–72 UTF-8 bytes, a letter and a number); do not send it through chat. No password is generated, hardcoded, printed, or committed by this implementation.

For isolation, interactive setup accepts only an **existing database within this website's private data directory** (default `data/store.sqlite`, or `DATABASE_PATH` resolving inside that directory). It refuses a missing database or a path outside that directory, including the neighbouring POS. Externally stored production databases need a separately reviewed operator procedure; do not copy/reset a database just to satisfy this restriction.

After successful setup in an approved environment, sign in at `/admin/login` using the **email and new password entered during setup**. The new route needs the updated frontend build and backend deployment; source edits alone do not update an already-running compiled website.

**Latest approved verification (8 September 2026):** after the user confirmed an IT-approved environment, the production build passed, **20 targeted admin-access/lifecycle API tests passed**, and **4 desktop/mobile admin-login browser tests passed**. The website alone was restarted on port 8080. A fresh browser confirmed `/admin/login` renders the form (no 404); the new login endpoint validates requests and unauthenticated inventory remains blocked. A SQLite-aware website database backup was created before restart/account setup. The earlier full-suite counts below are historical, not a new full-suite run. Owner password entry/account provisioning is a separate interactive step and is not implied by these test results.

### Create-only alternative

Run `npm.cmd run admin:create` in your own interactive terminal to create a **new** admin account. Enter the admin email, display name, and a password at the hidden prompts. Do not paste passwords into an AI chat. Use 10–72 UTF-8 bytes, including a letter and a number. The CLI refuses to overwrite or promote any existing account, including an existing customer.

An existing customer is restricted because admin endpoints require the server-side **admin role**; sign-in alone does not grant it. The current account role has **not been verified during this static review**. If an authorized administrator previously granted owner access and revoked old sessions, sign out and sign back in with that account's existing password, then open **/admin** in an approved environment. Signing in again does not promote a customer. If access remains restricted, have the authorized operator verify the account role and intended website database; do not recreate/reset the database or bypass authentication. Existing-account promotion requires a separately authorized private operation, not the creation CLI or a public promotion API. No real account identifiers or credentials belong in source or documentation.

Use the photo controls above for product imagery. There is no product-delete endpoint: manual hiding and automatic sold-out soft-archiving preserve history, while genuinely unreferenced uploads have their own delayed cleanup policy.

## Demo data and photography — replace before launch

**All 12 seeded products, prices, stock, discounts, product names/specifications and photographs are demonstration placeholders.** Photographs do not guarantee the listed garment's colour, construction or material; some are reused, including in the occasionwear category. They are not actual URBAN KASHI product photos. No customer reviews, sales statistics, payment confirmations or AI results are fabricated.

Unsplash demo images are cached locally so the preview does not rely on live third-party image calls. Source photo IDs are retained in asset names and in [server/db.ts](server/db.ts) / [src/pages/Home.tsx](src/pages/Home.tsx); source URLs follow `https://images.unsplash.com/<photo-id>`. Review [Unsplash's licence](https://unsplash.com/license) and any applicable model/property rights before commercial use. Replace them with your own catalogue photographs before launch.

Fonts are bundled through `@fontsource/dm-sans`, `@fontsource/cormorant-garamond` and `@fontsource/noto-serif-devanagari`; retain their OFL licence notices. [scripts/cache-demo-images.ts](scripts/cache-demo-images.ts) can re-fetch missing demo assets. On enterprise Windows networks, Node's `--use-system-ca` may be needed—do not disable TLS verification.

The logo is a **new crisp vector interpretation**, not a genuine recovered original or exact traced restoration. [public/brand-logo.svg](public/brand-logo.svg) is the downloadable static asset, served at `/brand-logo.svg`. Its editable Unicode text is **font-dependent, not outlined**, and it embeds no fonts. Standalone rendering depends on installed Devanagari fonts; create a separately outlined version in a vector editor if identical print output is needed. The website itself serves Noto Serif Devanagari locally.

The brand-story riverside image is an original SVG illustration inspired by Kashi, not a documentary photograph of an exact place.

The reference Instagram reel's video could not be reliably viewed. This is an **original editorial interpretation**, not a verified pixel-for-pixel copy or a reproduction of a paid theme.

## Data, security and configuration

- The private SQLite database is created on first startup; seed runs once and does not replenish sold stock on restart. See [.env.example](.env.example) for its default location.
- Schema migrations proceed through **v3**, preserving existing accounts/sessions, catalogue identifiers, orders and historical snapshots. V3 adds lifecycle timestamps and the image-upload registry. Back up before upgrading; do not replace an existing database with a fresh seed.
- Private environment configuration, database storage, dependencies, generated build and test artifacts are excluded from source control.
- An intentionally sanitized catalogue-only SQLite snapshot is documented in [seed/README.md](seed/README.md). It has no accounts, sessions, orders or payment records; use it only for a new installation, never to replace a working store. Private secrets remain uncommitted; [.env.example](.env.example) is the safe configuration template.
- `HOST` defaults to `127.0.0.1`; the site is not exposed publicly by default.
- Passwords use bcrypt (cost 12); only hashes of random session tokens are stored in SQLite. Session cookies are HttpOnly and SameSite=Lax.
- Browser API writes require `X-Requested-With: UrbanKashi`; cross-site Fetch Metadata writes are rejected. Only the exact signed raw `POST /api/payments/webhook` bypasses that header. No open CORS.
- Backend authorization checks customer/admin identity on every private endpoint.
- Helmet/CSP, request size limits, input validation, no-store API responses and rate limits are enabled.
- `COOKIE_SECURE=true` is required when deploying behind trusted HTTPS. Local HTTP needs it false.
- SQLite belongs on local persistent storage, never a public directory or a network filesystem. Use one application instance or redesign persistence/limits before scaling out.
- No password-reset emails, email verification, courier integration, tax-invoice engine, AI try-on, marketing messages, automatic refund/capture requests or automated fulfilment are implemented. Razorpay integration is implemented but merchant activation and external testing remain owner tasks.
- Shipping/returns and privacy pages are **policy drafts**, not approved legal documents. Demo orders are persisted but not actually dispatched.

See [server/README.md](server/README.md) for the API contract, session lifetime, status transitions, data limitations, proxy policy and admin setup details.

## Tests

- `npm.cmd test`: API/session/security/transaction regression suite, using temporary test databases.
- `npm.cmd run test:e2e`: Chromium desktop and Pixel-sized browser workflows; builds first and starts an isolated server on port 4180.
- Install the browser once with `npm.cmd exec playwright install chromium` if needed.
- `npm.cmd run build`: checks TypeScript and creates the frontend bundle.

Browser tests have their **own temporary database and test-only administrator**. They do not create real store accounts or modify the persistent catalogue. Coverage includes shopping/account/admin workflows, CSV and branding enhancements, and injected payment flows. Screenshots/traces are generated as uncommitted test artifacts. Mobile emulation is not a substitute for final testing on a physical Android/iPhone.

Latest reported backend validation: **154 API tests passed**, including upload and lifecycle coverage. The full **52-test desktop/mobile browser run is pending final confirmation**; it is not recorded as passed. These documentation-only changes did not rerun commands or tests. Payment service tests use injected fakes; production gateway adapter and browser payment-contract tests use intercepted/mock responses, not external provider verification. No live/sandbox payments, external webhook delivery or real refunds have been tested. The [Dockerfile](Dockerfile) is supplied; a container build has not been verified.

## Phone preview and deployment

For a phone on the same trusted Wi-Fi, set `HOST=0.0.0.0` in your private environment and allow **only the website's chosen port** through Windows Firewall on a private network. Browse `http://<laptop-LAN-IP>:8080`. The app does not require camera permission. Use HTTPS for real customers; do not expose the POS or router-forward development services.

For deployment, use a Node 24 host with persistent storage and a TLS reverse proxy, or the supplied [Dockerfile](Dockerfile) with private persistent volumes covering **both the SQLite database and the photo directory**. Keeping only the database loses uploaded photo content. Do not deploy either to an ephemeral/serverless filesystem. Coordinate SQLite-aware backups (including committed WAL state) with photo-directory backups, and test restoring both together; do not copy only a live main database file. Container images include `tsx` because the backend runs TypeScript directly. Set a precise trusted-proxy policy before enabling per-customer IP rate limits behind a proxy; the default does not trust forwarding headers.

**Before accepting real orders:** replace demo inventory/images, finalize business identity/contact and legal policies, verify pricing/tax and delivery coverage, create a private admin, configure HTTPS/cookies, use SQLite-aware backups, test restore/failure recovery, and review accessibility/security on physical devices. Before enabling live online payments, complete merchant onboarding and owner-controlled sandbox verification of Checkout, capture, signed webhooks, refunds and recovery—never trust a client-only success screen.

## Implementation record

See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the architecture and completed build phases.