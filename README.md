# Bisbag Creations — Firebase setup & deployment

Customers browse the store → place an order → it is **saved in Firebase** and they send it to you on WhatsApp.
You manage everything in `admin.html`. Store and admin are connected live: change a price or stock in the admin and the
open store updates instantly; a customer places an order and a "New order" alert pops up in your admin.
There is no online payment. You confirm price, delivery and payment on WhatsApp.

## What's in the folder

| File                                                   | Purpose                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| `index.html`                                           | The store                                                                |
| `admin.html`                                           | Admin dashboard (sign in with Firebase email + password)                 |
| `firebase-config.js`                                   | **You paste your Firebase keys here**                                    |
| `bb-data.js`                                           | Shared Firebase data layer (used by store and admin)                     |
| `firestore.rules`                                      | Security rules (**you paste your admin UID into this, then publish it**) |
| `products.js`                                          | 24 sample products (used to fill an empty catalogue)                     |
| `vercel.json`, `404.html`, `sitemap.xml`, `robots.txt` | Hosting + SEO                                                            |

Until the keys are pasted, the site runs in **demo mode** (everything works but only inside your own browser).

## Firebase setup (about 10 minutes)

1. **Create a project:** console.firebase.google.com → _Add project_.
2. **Firestore:** Build → _Firestore Database_ → _Create database_ → start in **production mode** → pick a location close to Nigeria (e.g. `europe-west1`, or `africa-south1` if listed). The location cannot be changed later.
3. **Authentication:** Build → _Authentication_ → _Get started_ → _Sign-in method_ → enable **Email/Password**. Then the _Users_ tab → **Add user** (your admin email + a strong password). **Copy the "User UID"** it shows.
4. **Web app keys:** Project settings (gear) → _General_ → _Your apps_ → **Web (`</>`)** → register → copy the config object. Paste it into `firebase-config.js` (keep `measurementId: "G-QEM9F15FWJ"`).
5. **Rules:** open `firestore.rules`, replace `PASTE_ADMIN_UID_HERE` with your UID, then Firestore → _Rules_ → paste the whole file → **Publish**. (The console highlights any mistake.)
6. **Allow your website to sign in:** Authentication → _Settings_ → _Authorized domains_ → add your Vercel domain(s) (`your-project.vercel.app` and your custom domain). `localhost` is already allowed.

## Run it on your computer (VS Code)

Install the **Live Server** extension → right-click `index.html` → _Open with Live Server_. Admin: `http://127.0.0.1:5500/admin.html`.
First sign-in → **Products** → _Import 24 sample products_ (or _Start empty_). Edit them to your real products, then upload photos.

## Deploy

1. Push the folder to GitHub.
2. Vercel → _Add New → Project_ → import the repo → Framework Preset **Other**, leave build settings empty → Deploy. (No environment variables needed; the Firebase keys are public by design. Security comes from `firestore.rules`.)
3. Add your domain in Vercel → Settings → Domains, and add it to Firebase _Authorized domains_ (step 6).

## Before announcing — replace these

- `www.bisbagcreations.com` → your real domain in `index.html` (canonical + og tags), `sitemap.xml`, `robots.txt`.
- Add `og-image.jpg` (1200×630) to the root for link previews.
- **Placeholder facts:** "500+ bags sold", "4.9★", " years", the Team section, and the sample products' names, prices, stock, ratings and review counts. Set ratings/reviews to 0 to hide them.
- Admin → Settings: WhatsApp number, announcement bar, Lagos delivery fee, other-state minimum, specific city/area fee rules, coupon, and social links. Location-based delivery rates are shown at checkout and do not become free based on order total.

## How it works

- **Orders:** saved to Firestore (`orders`), then the customer taps _Send order on WhatsApp_. If Firebase is unreachable, the order still goes out through the WhatsApp message with the same order ID.
- **Receipts:** Admin → Orders → Receipt printer → enter the order ID. The printable receipt includes customer, item, total, order status, and payment state whether payment is pending or received.
- **Stock:** taken off when you set an order to _Processing_ (or later); returned if you cancel or delete it.
- **Photos:** resized in the browser and stored in Firestore (`productImages`), so you stay on the free Spark plan. (Firebase Storage now needs the paid Blaze plan.)
- **Price check:** pending orders whose prices don't match your catalogue show **⚠ check prices** in the admin.

## Limits to know

- Free Spark plan: 50,000 reads and 20,000 writes per day. The store reads ~2 documents per visit plus product photos (thumbnails are cached in the browser).
- Anyone can submit an order (that is the point of a store). The rules only allow well-formed orders, but they cannot rate-limit. If you ever get spam, turn on Firebase **App Check** and set a budget alert.
- This package was tested against a simulated Firebase. Test with your real project: place a test order, watch it appear in the admin, then delete it.
# bisbagcreations
