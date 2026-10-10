# Wren — a free, open-source, private cycle tracker

Wren is a period-tracking app built to be **as easy to use as Flo, as private as Euki, and free forever**. It's a single-page web app (installable as a PWA on Android and iPhone) with no backend, no account, no analytics, and no ads. There is nothing to pay for because there is no server to run.

## Why this shape

| Concern | How Wren handles it |
|---|---|
| Ease of use | One-thumb navigation, a big "today" ring, one-tap logging, a real calendar |
| Privacy | Everything stays in the browser's local storage on the device. Nothing is ever sent anywhere. |
| Extra privacy (à la Euki) | Optional passcode lock. When set, the entire data file is encrypted (AES-GCM, key derived from the passcode via PBKDF2) before it touches disk. |
| Cost — for you | Static files only. Host free on GitHub Pages, Netlify, Vercel, or Cloudflare Pages. |
| Cost — for users | 100% free, no in-app purchases, nothing to unlock. |
| Open source | MIT-licensed. Anyone can read the code, audit the privacy claims, or fork it. |

## How it works (plain terms)

- You tell it your last period start date — that's it. It quietly assumes a 28-day cycle and 5-day period to start (the most common averages), then automatically switches to averaging *your* actual logged cycles the moment it has two or more, without ever asking you to state a cycle length yourself.
- Calendar: tap any day to log it, same as before. Or tap **Select range**, then press-and-drag across several days (with your finger or mouse) to select a whole stretch at once — the same log screen opens (flow, mood, symptoms, notes) and whatever you set applies to every day in that range. Great for backfilling old cycles quickly. Tap **Cancel select** to go back to normal one-day-at-a-time tapping.
- It predicts your next period by averaging your last few cycles (falls back to your stated average until it has real data).
- The calendar colors in: **actual period days**, **predicted period days**, and an estimated **fertile window** (ovulation date − 5 days to ovulation + 1 day, with ovulation estimated as 14 days before the next predicted period — the standard luteal-phase estimate every tracker uses; it's an estimate, not a diagnosis).
- Insights tab shows your average cycle/period length, cycle history, and your most logged symptoms.
- Settings: set/remove a passcode, turn mood-tracking on or off, export your data as a JSON file you keep yourself, import it back in, or wipe everything.

## File structure

```
cycle-app/
├── index.html      the whole UI (onboarding, home, calendar, insights, settings, modals)
├── style.css        design system — colors, type, layout
├── app.js           state, cycle math, rendering, event handling, encryption
├── manifest.json    makes it installable as an app on phones
├── sw.js            service worker — caches the app shell so it works offline
└── icon.svg         app icon
```

No build step, no npm install, no framework. Open `index.html` directly in a browser to try it locally.

## Deploying for free

Any static host works since it's just five files. Two easy options:

### Option A — GitHub Pages (recommended, fully free forever)
1. Create a GitHub repo (e.g. `wren-app`) and push this folder to it.
2. In the repo, go to **Settings → Pages**.
3. Under "Build and deployment", set **Source: Deploy from a branch**, branch `main`, folder `/ (root)`.
4. Save. Your app will be live at `https://<your-username>.github.io/wren-app/` within a minute or two.

### Option B — Netlify (drag-and-drop, no git needed)
1. Go to [app.netlify.com/drop](https://app.netlify.com/drop).
2. Drag the `cycle-app` folder onto the page.
3. It deploys instantly to a free `*.netlify.app` URL. You can add a custom domain later, still free.

Either way, once it's live, anyone can visit the URL on their phone and tap **"Add to Home Screen"** (Android: Chrome menu → Install app; iPhone: Share → Add to Home Screen) to get a full-screen, offline-capable app icon — no App Store or Play Store needed, so no $25 Play Store fee either.

## Roadmap — where to take it next

**v1 (this build) — done**
- Onboarding, home ring, calendar, logging, insights, passcode lock, export/import, offline PWA shell.

**v1.1 — polish**
- Reminders (local notifications only — the Notifications API, still no server) for upcoming periods/fertile window.
- Editable app-wide theme (some users may prefer a different palette).
- A "panic/quick-hide" gesture for extra discretion, like Euki's hide feature.

**v1.2 — smarter predictions**
- Track basal body temperature and cervical mucus as optional fields for people doing fertility awareness, with a proper temperature-shift ovulation detection instead of the fixed 14-day estimate.
- Irregular-cycle handling (wider prediction ranges when cycle length varies a lot, rather than one number).

**v2 — reach more people without breaking the privacy model**
- Optional, fully end-to-end-encrypted sync between a user's own devices (e.g. using a self-hosted or user-supplied storage backend) so switching phones doesn't lose data — sync stays opt-in and encrypted client-side so even the sync server never sees plaintext.
- Localization/multi-language support.
- Accessibility pass: screen-reader labels throughout, larger text mode.

**Longer term**
- Publish to F-Droid (the open-source Android app store) by wrapping the PWA with something like Capacitor or Trusted Web Activity — free, no review fee, and it keeps the app auditable.

## A note on the health estimates

Cycle and fertility predictions here (like in every period app, paid or free) are statistical estimates based on your own logged history — they are not medical advice and shouldn't be relied on as birth control or fertility treatment guidance. Worth saying that plainly somewhere in the app too (e.g. in Settings) if you plan to share this with others.

## License

MIT — do anything you want with this, including relicensing your fork, as long as you keep it free for end users' core tracking features in spirit. (Pick whatever license you're most comfortable with; MIT is just a sensible open-source default.)
