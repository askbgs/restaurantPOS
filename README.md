# Restaurant POS & KOT (Ember & Bao)

A restaurant point-of-sale and kitchen order ticket (KOT) system built from the Claude Design
"Restaurant POS" mock-up. One Node.js service serves the API and the web app, with PostgreSQL behind it.

## What it does

| Screen | Features |
|---|---|
| **Floor** | Tables by area (Main hall / Patio / Bar counter) with live status: Free, Ordering, In kitchen, Food ready, Dining, Bill printed. Shows guests, minutes seated and running total. The off-floor queue on the right lists takeaway, delivery and counter orders. |
| **Order** | Start an order (Dine-in, Takeaway, Delivery, Counter), menu categories, dish search, tap to add, and an **Options** dialog (spice level, add-ons, course, kitchen note, qty). The ticket groups lines by course, with a guest stepper and edits for unsent lines. |
| **Review KOT** | Previews the tickets before sending, either **per station** (Wok / Steam / Grill / Cold / Bar) or as a **single ticket**. **Hold mains & desserts** sends them to *On hold* until the kitchen fires them. Add-on tickets are flagged. |
| **Kitchen** | KDS board with New → Cooking → Ready → cleared, plus an On hold column ("Fire now"). Station filter with live counts. Tap an item to tick it off. Tickets cooking longer than `LATE_MINUTES` turn red and show LATE. |
| **Bill** | Discount (None / 10% / Staff 20%), service charge on/off, tip, split 2–4 ways, and Card / Cash / Wallet with a change calculator. Warns about unsent items. **Print bill** prints an 80 mm receipt. **Charge** sends any unsent items to the kitchen, closes the order and frees the table. |
| **Admin** (Managers only) | **Menu items**: add or edit dishes with price, category, station, tags, spice option, add-ons and a **photo**; hide a dish from the menu. Photos are resized to 800 px in the browser and stored in Postgres, so they survive redeploys. **Categories** set the default course. **Floor & tables**: add areas and tables, set seats, hide tables. **Stations** set the KOT routing and printer label. **Staff**: names, roles, PINs, and turning sign-in off. |
| **History** | Today's orders with type filter, paid count and amount collected. A detail panel shows the items and kitchen tickets. |

Other features:
- Staff sign in with a PIN. Sessions are stored in Postgres in an HttpOnly cookie.
- Live updates across every terminal: Postgres `LISTEN/NOTIFY` feeds Server-Sent Events, so it still works if Railway runs more than one instance.
- Money is stored as integer cents. Totals are always calculated on the server.

Demo PINs: **1234** Ravi K. (Captain), **0000** Manager, **1111** Kitchen. *Change these in Admin → Staff before going live.*

Admin safeguards:
- Dishes and tables that appear on past orders can't be deleted, only hidden.
- A category, area or station that is still in use can't be deleted.
- A table with an open order can't be hidden.
- PINs must be unique.
- There must always be at least one active Manager.
- Changing someone's PIN or turning off their sign-in signs them out on every terminal.
- Menu changes reach every terminal straight away.

## Deploy on Railway

1. Push this folder to a GitHub repo.
2. In Railway, go to **New Project → Deploy from GitHub repo** and pick the repo.
3. In the same project, choose **+ New → Database → PostgreSQL**.
4. Open the app service, go to **Variables**, and add:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - (optional) `RESTAURANT_NAME`, `TERMINAL_NAME`, `CURRENCY_SYMBOL`, `TAX_LABEL`, `TAX_RATE`, `SERVICE_RATE`, `LATE_MINUTES`, `TZ_DISPLAY` (see `.env.example`).
5. Under **Settings → Networking**, click **Generate Domain**.

On first boot the app creates the tables and seeds the demo floor, stations, menu and staff.
`railway.json` sets the start command and the `/healthz` health check.

## Run locally

```bash
npm install
cp .env.example .env   # set DATABASE_URL
export $(grep -v '^#' .env | xargs) && npm start
# open http://localhost:3000
```

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `CURRENCY_SYMBOL` | `Rs ` | Use `$` to match the mock-up |
| `TAX_LABEL` / `TAX_RATE` | `VAT` / `0.18` | Fraction. Check against the current rate |
| `SERVICE_RATE` | `0.10` | Service charge fraction |
| `LATE_MINUTES` | `12` | Cooking time before a ticket shows LATE |
| `TZ_DISPLAY` | `Asia/Colombo` | Used for times and the "today" filter |

How totals are calculated: subtotal − discount = base. Service, tax and tip are each a percentage of the base.

## Project layout

```
server/index.js    Express API, auth, SSE, static hosting
server/admin.js    manager-only admin API
server/db.js       pg pool, migrations, LISTEN/NOTIFY, PIN hashing
server/schema.sql  tables (staff, areas, dining_tables, stations, categories,
                   menu_items, item_addons, orders, order_items, kots)
server/seed.js     demo data
public/            web app (index.html, app.js, styles.css) — no build step
```

## Not included yet

- Physical printing. KOTs show their target printer, and bills print through the browser.
  A thermal-printer bridge (ESC/POS) can subscribe to the same events.
- Reports beyond today's history.
