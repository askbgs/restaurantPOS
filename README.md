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

**Admin → Settings** also sets the **login screen background**: upload a photo of your restaurant, or keep the built-in one. It's resized to 1920 px, softly faded behind the PIN pad, and fades in when the screen opens.

**Admin → Settings → Restaurant details on bills**: address (up to 3 lines), phone, email, website, VAT/business registration no. and a bill footer message. These print at the top of every bill, receipt and refund slip. **Restaurant logo**: upload once. It shows in the app header and on the login screen, and prints on bills: the browser converts it to a dithered black & white image sized for 58/80 mm thermal printers, with a preview of the printed result.

**Admin → Settings** controls the restaurant name, terminal name, currency, tax and service charge, and the late-ticket time for every terminal. **Load Asian menu** replaces the menu with Short Eats, Sri Lankan, Indian, Chinese, Thai, Japanese, Korean, Desserts and Drinks. Dishes that appear on past orders are kept but hidden, so history stays correct.

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

## Shifts, voids, reports and printing

### Shift & cash drawer (Shift tab)
- Open a shift with the opening float. **New orders and payments need an open shift**, so every sale is counted in a drawer. With no shift open, the Floor and Order screens show an "Open shift" banner. Orders already open from an earlier shift can still be finished.
- **Cash in / Cash out** (paid-outs) need a reason and Manager or Cashier approval.
- The Shift tab shows live figures: sales, payments by method, refunds, voids and the cash that should be in the drawer.
- **Close shift**: count the drawer, either by entering the total or with the Rs 5000 → Rs 1 note and coin counter. The app shows over, short or balanced, saves the result and prints the **Z report**. **Print X report** prints the figures so far without closing.
- Expected cash = float + cash sales − cash refunds + cash in − cash out.

### Items without a kitchen ticket
- **Per dish:** in Admin → Menu items, untick **Send to kitchen** for ready-made items (bottled drinks, cakes, pre-made short eats). Adding them to an order marks them **Served · no KOT** straight away.
- **Per order line:** tap **No KOT** on an unsent line, or choose **Already prepared** in the Options box, when a dish is already cooked.
- These items are billed and reported like any other. Once served, removing one needs a Manager-approved **Void**, the same as a sent item. Each per-line "No KOT" is recorded in the audit log.

### Stock, recipes & suppliers (Stock tab, Managers)
- **Stock levels:** ingredients with a unit (kg, g, l, ml, pcs, pack, bottle, bunch), current stock, reorder level, order-up-to level, weighted average cost, value and usual supplier. Each ingredient shows its full stock history. **Record waste** or **Adjust** with a reason.
- **Recipes & cost:** what goes into one portion of each dish, with live cost, food-cost % and profit as you type. The list flags dishes with no recipe, dishes over 35% food cost, and how many portions current stock can make.
- **Stock comes off when a bill is paid:** recipe quantity × quantity sold. Voided items are excluded. Add-ons are not deducted.
- **Low stock:** the Stock tab shows how many items need reordering. Dishes whose ingredients have run out show **Low on ingredients** on the Order screen. This is a warning only and doesn't block the sale.
- **Reorder list:** low items grouped by supplier, with suggested amounts (up to the order-up-to level) and an estimated cost. Print it, or press **Receive this order** to get a pre-filled delivery form.
- **Receive goods:** record each delivery with supplier, invoice no., date and lines (enter either the unit cost or the line total). Stock goes up and the average cost is recalculated. Pay now or on credit, by cash from the drawer (it is taken out of the open shift's cash and can't exceed the cash that should be in the drawer), other cash, bank, card or cheque.
- **Suppliers:** contact details, total bought, paid and the **balance owed**, recent deliveries, and **Record payment**.
- **Stock count:** enter what's on the shelves. Only filled rows change, and each difference is recorded with its value. You can print a blank count sheet.
- **Reports:** a *Food cost & stock* section with food sales, cost of ingredients used, food cost %, gross profit, waste, count differences and goods received, plus *Profit by dish* and a *Waste* list (also in the CSV).
- **Sample data:** new installs start with 36 ingredients, 4 suppliers and recipes for 32 dishes. Existing installs get a **Load sample ingredients & recipes** button while the stock list is empty.
- Every delivery, payment, waste, adjustment, count and recipe change goes into the audit log.

### Voids, refunds and manager approval
- **Before a dish is sent**, staff can remove it freely with −.
- **After it's sent**, **Void** on the line needs a reason and a Manager PIN. A Manager doesn't need to enter a PIN. The kitchen gets a VOID slip, and the bill total updates.
- **Void order** (after anything is sent) needs a reason and a Manager PIN.
- **Refund** a paid bill (full or part, cash/card/wallet) from History. It needs a reason and a Manager PIN and prints a refund slip with a signature line. Cash refunds come out of the open shift's drawer.
- **Audit log** (Admin → Audit log) records voids, refunds, discount changes, bill prints and reprints, shift open/close, cash in/out, sign-ins (including wrong PINs) and every admin change, with who did it and who approved it. It is read-only.

### Reports (Managers)
- Today, Yesterday, Last 7 days, Last 30 days, This month, or a custom range.
- Headline figures: net sales, orders, average bill and per cover, discounts, service charge and tax, voids and refunds.
- Charts and tables: sales by day, busy hours, by category, top 10 and slowest dishes, order types, payments, staff (sales, average bill, voids), table turnover (average minutes per table) and the full void and refund lists.
- **Export CSV** opens in Excel with every section. **Print / PDF** prints the report page, or you can save it as a PDF.

### Thermal printing (Admin → Printers)
1. Add each printer:
   - **Network**: `192.168.1.50:9100` (most LAN Xprinter/Epson models).
   - **Windows shared USB**: share the printer in Windows, then use `\\localhost\XP80`.
   - **Linux USB**: `/dev/usb/lp0`.
   - Choose 80 mm or 58 mm paper.
2. Choose the **bill printer** (bills, receipts, refund slips, Z reports), the **default kitchen printer**, and optionally a printer per station.
3. On a PC on the shop network (Node.js 18+), download `print-bridge.js` from that page and run the command shown there:
   ```
   node print-bridge.js --server https://your-app.up.railway.app --token <token>
   ```
   If you set up the bridge before the logo feature, download `print-bridge.js` again. The old bridge prints bills without the logo.
   The bridge holds an open connection and prints within about a second. Jobs are queued in Postgres, so nothing is lost if the PC is off; they print when the bridge reconnects. Failed jobs retry automatically and can be retried from the jobs list.

What prints:
- New KOTs (held tickets print when fired, marked FIRE NOW).
- VOID slips.
- Bills, receipt and bill reprints.
- Refund slips.
- X and Z reports.
- Test pages.

If no printer is configured, the browser print dialog is used as before.

To start the bridge automatically when Windows starts, put the command in a `.bat` file in the Startup folder, or use `pm2` / NSSM.

## Deploy on Railway

1. Push this folder to a GitHub repo.
2. In Railway, go to **New Project → Deploy from GitHub repo** and pick the repo.
3. In the same project, choose **+ New → Database → PostgreSQL**.
4. Open the app service, go to **Variables**, and add:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - (optional) `RESTAURANT_NAME`, `TERMINAL_NAME`, `CURRENCY_SYMBOL`, `TAX_LABEL`, `TAX_RATE`, `SERVICE_RATE`, `LATE_MINUTES`, `TZ_DISPLAY` (see `.env.example`).
5. Under **Settings → Networking**, click **Generate Domain**.

On first boot the app creates the tables and seeds the demo floor, the kitchen stations (Wok, Curry, Tandoor, Grill, Steam, Cold, Bar), the Asian menu and the staff.
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
| `CURRENCY_SYMBOL` | `Rs ` | Default only. Admin → Settings overrides these values |
| `TAX_LABEL` / `TAX_RATE` | `VAT` / `0.18` | Fraction. Check against the current rate |
| `SERVICE_RATE` | `0.10` | Service charge fraction |
| `LATE_MINUTES` | `12` | Cooking time before a ticket shows LATE |
| `TZ_DISPLAY` | `Asia/Colombo` | Used for times and the "today" filter |

How totals are calculated: subtotal − discount = base. Service, tax and tip are each a percentage of the base.

## Project layout

```
server/index.js    Express API, auth, SSE, static hosting
server/admin.js    manager-only admin API + audit log
server/printing.js print queue, receipt layouts, bridge API
server/reports.js  sales + food-cost reports
server/inventory.js  ingredients, recipes, stock ledger, suppliers, purchases
server/inventory-sample.js  sample ingredients and recipes
bridge/print-bridge.js  runs on a shop PC, sends ESC/POS to printers
server/db.js       pg pool, migrations, LISTEN/NOTIFY, PIN hashing
server/schema.sql  tables (staff, areas, dining_tables, stations, categories,
                   menu_items, item_addons, orders, order_items, kots)
server/seed.js     demo data
public/            web app (index.html, app.js, styles.css) — no build step
```

## Not included yet

- Sinhala and Tamil text on thermal printers. The printer code page is ASCII, so those characters print as '?'.
- Add-ons (extra cheese, fried egg…) don't deduct stock. Only the dish recipe does.
- Unit conversion between purchase and recipe units. Each ingredient uses one unit (e.g. buy and use chicken in kg).
- Editing or cancelling a saved delivery. Correct mistakes with a stock adjustment and a supplier payment.
