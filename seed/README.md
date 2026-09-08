# Sanitized catalogue snapshot

`catalogue.sqlite` is a **newly constructed schema-v3 database containing only catalogue products and variants**, including prices, website stock, barcodes/SKUs, visibility and lifecycle timestamps. These catalogue fields are intentionally published; review free-text product descriptions and commercial inventory before sharing future snapshots. This is not a full private-store backup.

- **Empty:** customers/admin accounts, password hashes, sessions, orders/addresses, payment events and upload registry.
- **Never copied:** private database pages, deleted records, backups, WAL/SHM files, environment values, or arbitrary source tables/triggers.
- Bundled `/images/` references use the committed assets in `public/images`. The exporter refuses remote URLs and private upload references; it does not publish signed URLs or silently omit required uploaded photos.
- The seed marker prevents extra demo products being added on startup. Existing demo products/images remain placeholders, not verified real inventory.
- No default administrator exists. The owner must privately create an account after restoring.

## Use on a new installation only

1. Keep this committed snapshot unchanged. With the website stopped, copy it to the new installation's private `data/store.sqlite` **only if that database and its WAL/SHM files do not already exist**. Never overwrite a working store or use this snapshot to restore customer/order history.
2. Use `../.env.example` as the configuration template and configure secrets privately. The exporter does not load or publish private environment files.
3. Install dependencies, build and start using the root README instructions. Create the owner admin using the private CLI and review stock before selling.

## Regenerate in an approved environment

`npm.cmd run data:export:sanitized` reads **only this website's default database**, read-only, with a consistent SQLite read transaction. It builds a fresh in-memory database using the application's schema, explicitly transfers catalogue fields, checks empty private tables and integrity, then uses SQLite's backup API to produce the single-file snapshot here. It never migrates or writes the source database and deliberately ignores `DATABASE_PATH` and dotenv.

An existing snapshot is not overwritten automatically: review/remove only the old generated snapshot before re-exporting. Do not remove the private store database. Review the new catalogue content before committing. Dependencies/build output/test artifacts remain excluded because they are reproducible and may contain machine-specific or private runtime data.