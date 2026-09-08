# Implementation plan and handoff

## Scope

Independently owned URBAN KASHI menswear ecommerce website. Separate data, auth, inventory, orders and server process. No connection to or synchronization with the neighbouring POS, ever; never modify that project. Owner-supplied existing POS barcodes may be manually imported as CSV text. No actual POS export file has been supplied, so real-export compatibility is not verified.

## Design direction

- Original premium editorial composition rather than a cloned paid theme.
- Warm ivory paper, charcoal/olive surfaces, terracotta accents; locally hosted DM Sans, Cormorant Garamond and Noto Serif Devanagari.
- Bilingual logo and crisp gold trishul are a new vector interpretation, not a genuine recovered original. Only the upright trishul turns using `rotateY`; lettering remains still and reduced-motion disables animation.
- Downloadable [public/brand-logo.svg](public/brand-logo.svg) is static, with font-dependent Unicode text, not outlines or embedded fonts.
- Responsive asymmetric hero, collection cards, curated products, brand story, campaign panel and purposeful footer.
- Scroll reveals, hover motion and dialog transitions, with reduced-motion and keyboard support.
- All demo content identified; no fabricated customer ratings, purchase counts, countdown scarcity or success claims.

## Architecture

Browser (React + Router) → same-origin Express JSON API → separate SQLite database.

- React UI, account/cart state and same-origin API client.
- Shared typed product/user/cart/address/order/payment contracts.
- Express validation/auth, SQLite migrations, stock transactions, CSV import and Razorpay adapter.
- API regressions use temporary SQLite databases; browser workflows use isolated port 4180 and a temporary database, never the real store.
- Locally served demonstration images, fonts, logo and CSV template.

## Build phases

1. **Workspace and contracts:** scaffold React/TypeScript, package scripts and isolated SQLite configuration.
2. **Commerce backend:** migrations, products, hashed sessions, customer accounts, owner-only order queries and admin authorization.
3. **Storefront:** catalogue filters, product details/sizes, local wishlist/bag and responsive animated editorial pages.
4. **Checkout:** validated delivery details, COD, server-side integer rupee calculation, stock transaction and retry idempotency.
5. **Operations:** admin product/stock editing and order transitions with once-only cancellation restocking.
6. **Validation:** production build, API tests, desktop/mobile browser tests, screenshot inspection and error recovery.
7. **Handoff:** local server, launch tasks, setup/readiness documentation and private administrator setup.

## Implemented enhancements

- **Catalogue:** one slug per design + colour, one CSV row per size, flexible size labels, brand/design, barcode/SKU and immutable order snapshots. Admin preview and explicit confirmation precede transactional upsert; missing products/sizes are preserved. Stock is absolute website allocation, not a POS stock feed.
- **Import operations:** Excel barcode/SKU columns must be Text before entering/importing codes → CSV UTF-8 → admin preview → review warnings/approve → confirm. CSV only, no XLSX upload. Maximum 1,000 data rows and 2 MiB for the entire JSON request including escaping. Server limits: barcodes ≤128 characters and SKUs ≤160.
- **Payments:** COD remains available; optional Razorpay hosted Checkout requires all three protected server configuration values. Every advertised mode is conditional on merchant KYC/activation and eligibility. Paid status requires server-verified capture and clean refund evidence, not a browser claim.
- **Recovery:** durable reservations and guarded provider-order creation prevent blind retry after unknown outcomes. The order page has Check payment status but no resume-payment button. Stuck pending orders require provider review; stock stays reserved until safe admin pre-shipment cancellation. Late capture keeps cancellation intact and requires refund.
- **Refunds:** partial/incomplete/ambiguous evidence persists `paymentReview`, blocking confirmation/shipment and online revenue inclusion. A complete collection of processed refunds may aggregate to the full order amount when provider flags/totals agree. An uncaptured refunded authorization does not fabricate `paid_at`. Stale captures cannot clear refund holds or reverse a verified refund; shipped → delivered remains available to record delivery. Refunds never automatically cancel/restock orders.
- **Security:** raw-body signed webhook with durable event deduplication, server-side provider reads, private credentials, constrained provider CSP and atomic inventory updates. Automated tests use fake gateways or mocked HTTP, never external verification.

## Validation status

**Production build passed; 129 API tests and 30 desktop/mobile browser tests passed.** Browser payment flows use intercepted test contracts, not a real gateway. No live or sandbox Razorpay payment, external webhook delivery, real refund or actual POS export has been tested. Local test success does not establish merchant eligibility or external Checkout/CSP compatibility. A SQLite backup was created before migration; the website was restarted on 8080 and health, catalogue, disabled-payment configuration, template and vector-logo endpoints returned HTTP 200.

## Boundaries and remaining operational work

- POS sync, shared databases or shared credentials.
- Razorpay merchant onboarding, test/live credentials and external verification are not supplied by the application. No automatic capture-request/refund-request workflow, provider-order cancellation, reservation expiry job or reconciliation scheduler is implemented.
- Courier labels/tracking, transactional email, verified tax invoices and password recovery are not implemented.
- AI image generation or virtual try-on without an actual configured provider.
- Production fulfilment or approved legal policies. These need owner-supplied business details.

## Future production work

Actual product photography/specifications and size charts → approved customer policies/contact → HTTPS and backup/restore validation → owner-controlled Razorpay test keys, public HTTPS signed webhook and enabled capture → sandbox payment/refund/failure verification → eligible live methods only after merchant approval → final browser, real-device and load testing → launch. Never send secrets in chat. See [docs/PAYMENTS_AND_CATALOGUE.md](docs/PAYMENTS_AND_CATALOGUE.md) for setup, refund holds and manual-review procedures.