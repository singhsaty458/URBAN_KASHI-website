# URBAN KASHI storefront workspace

- [x] Verify that the copilot-instructions.md file in the .github directory is created.
- [x] Clarify Project Requirements
  Independent URBAN KASHI menswear ecommerce, no POS integration. React TypeScript, Express, SQLite. Responsive animated editorial UI. COD only until a verified payment provider is configured.
- [x] Scaffold the Project
  React/Vite client, Express API, shared types and independent SQLite schema created.
- [x] Customize the Project
  Editorial storefront, accounts, wishlist/bag, COD plus gated Razorpay checkout, enriched variants/CSV import, order history, secure admin and upright rotateY trishul branding implemented.
- [x] Install Required Extensions
  No additional extensions required.
- [x] Compile the Project
  Production build, 129 API tests and 30 desktop/mobile Chromium tests passed. Payment tests use fakes/intercepted contracts, not live provider verification.
- [x] Create and Run Task
  Build, API tests, browser tests and start tasks exist in .vscode/tasks.json.
- [x] Launch the Project
  Independent website started at http://127.0.0.1:8080; health and catalogue endpoints verified.
- [x] Ensure Documentation is Complete
  README.md, IMPLEMENTATION_PLAN.md and server/README.md document architecture, admin setup, deployment and demo limitations.

## Boundaries
- All changes belong in this workspace, never the neighbouring POS project.
- Node 24 is required for built-in node:sqlite. Use npm.cmd on Windows if PowerShell blocks npm.ps1.
- Money uses integer INR rupees; server recomputes prices and validates stock in transactions.
- Customer/admin identity must be checked server-side. Never expose password hashes or session tokens in JSON.
- Demo imagery and inventory must be identified as placeholders in README. No fake payment or AI success.
- Demo fonts and images are locally served. The Kashi riverside SVG is an original illustration, not a location photograph.
- Keep browser tests on their isolated temporary database/port 4180, never the real store database.
- Online payments require all three private-server Razorpay settings; methods remain eligibility-dependent. Never claim activation without sandbox verification. Only the public key ID reaches clients.
- Verify raw signed webhooks and provider order/payment/refund evidence server-side. Payment-review holds block confirmation/shipping; cancellation is not a refund.
- POS exports are owner-supplied CSV UTF-8 files only, with text barcodes and separately allocated website stock. No direct POS reads or sync. Use one slug per design/colour and one row per size.
- Admin credentials are created by the owner with the private admin:create CLI; never add a default account or password.
