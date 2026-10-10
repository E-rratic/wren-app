# Wren — Technical Documentation

**Project type:** Client-side Progressive Web App (PWA)
**Stack:** Vanilla HTML, CSS, JavaScript (ES6+) — no framework, no build step, no backend
**Lines of code:** ~150 (HTML) / ~330 (CSS) / ~420 (JS)

---

## 1. Why this architecture

The core requirement was: **free forever, private by default, easy to deploy.** That ruled out anything needing a server:

| If I had used... | Problem |
|---|---|
| A backend (Node/Django/Firebase) + database | Costs money at scale, and means health data leaves the device — the opposite of the privacy goal |
| A framework needing a build step (React, Vue) | Adds tooling complexity and a build pipeline for zero functional benefit at this scale |
| A native Android/iOS app | Requires app store fees ($25 one-time for Play Store, $99/year for Apple) and separate codebases per platform |

Instead, Wren is a **static site**: HTML + CSS + JS files served as-is. This means:
- Hosting is free anywhere that serves static files (GitHub Pages, Netlify, Vercel).
- There is no server to secure, patch, or pay for — because there is no server.
- It works as a website *and*, via the PWA manifest + service worker, installs like a native app on Android and iOS with an offline-capable icon on the home screen.

---

## 2. File structure and responsibilities

```
index.html      Structure — all screens exist in the DOM at once; JS toggles visibility
style.css       Presentation — design tokens (colors/type/spacing) + layout
app.js          Behavior — state, business logic, rendering, event handling, crypto
manifest.json   Tells the OS this is an installable app (name, icon, colors, start page)
sw.js           Service worker — caches the app shell so it works with no internet
icon.svg        App icon (vector, so it scales cleanly to any size)
```

There's no separate templating engine or component library — `index.html` contains every view (home, calendar, insights, settings, and two modals) as `<section>`/`<div>` elements. JavaScript shows/hides them by toggling a CSS class (`.hidden`). This is a deliberate simplicity trade-off: for an app this size, a component framework would add more complexity than it removes.

---

## 3. Data model

All data is one JavaScript object, kept in memory as `state` and persisted to `localStorage`:

```js
{
  version: 1,
  onboarded: true,
  settings: {
    avgCycleLength: 28,   // user-declared default, used until real history exists
    avgPeriodLength: 5,
    anchorDate: "2026-05-01"  // fallback reference date if no logs exist yet
  },
  logs: {
    "2026-05-01": { flow: "medium", mood: "calm", symptoms: ["cramps"], notes: "" },
    "2026-05-02": { flow: "light", mood: null, symptoms: [], notes: "" }
    // one entry per day the user has logged anything for
  }
}
```

**Design choice — logs are the single source of truth.** Rather than storing "period start/end" as separate records that could drift out of sync with daily logs, the app *derives* period date-ranges by scanning `logs` for consecutive days where `flow !== 'none'` (see `derivePeriods()` in `app.js`). This avoids a whole class of bugs where two data structures disagree about the same fact.

---

## 4. The cycle-prediction algorithm

This is the mathematical core of the app, in `cycleStats()` and `phaseForDate()`:

1. **Derive periods** from logs: group consecutive flow-logged days into `{start, end}` ranges.
2. **Average cycle length** = mean of the gaps between the start dates of the last 6 periods (falls back to the user's stated default if fewer than 2 periods are logged).
3. **Average period length** = mean of `(end − start + 1)` across the last 6 periods.
4. **Anchor date** = the start of the most recent period (or the onboarding date if nothing is logged yet).
5. **Next predicted period** = `anchor + avgCycleLength` days.
6. **Ovulation estimate** = `nextPredictedPeriod − 14 days`. The 14-day figure is the standard luteal-phase length estimate used by essentially all cycle-tracking apps (the luteal phase — after ovulation, before the next period — is physiologically much more constant than the follicular phase, so counting backward from the *next* period is more reliable than counting forward from the *last* one).
7. **Fertile window** = ovulation date − 5 days to ovulation date + 1 day (sperm can survive up to ~5 days; the egg is viable for about a day).

For any arbitrary date (used to color the calendar), `phaseForDate()` uses modular arithmetic: it takes the number of days between that date and the anchor, mod `avgCycleLength`, to figure out "day N of the cycle" for months in the past or future, without having to simulate every cycle in between.

**Explicit limitation documented in the README:** this is a statistical estimate from the user's own history, not a medical prediction — same caveat that applies to every period app on the market.

---

## 5. The privacy/encryption feature

This is the piece that goes beyond "just don't have a server" — it protects data *at rest on the device itself*, in case someone else picks up the phone.

- **Without a passcode:** `state` is saved as plain JSON in `localStorage`.
- **With a passcode set:** the entire `state` object is encrypted before it's saved, using the browser's built-in `SubtleCrypto` API (`window.crypto.subtle`) — no external crypto library needed.

The scheme (`deriveKey`, `encryptAndStore`, `tryDecrypt` in `app.js`):

1. **PBKDF2** turns the user's passcode into a cryptographic key. It's deliberately slow (150,000 iterations) so that brute-forcing the passcode by guessing is computationally expensive.
2. A random **salt** (16 bytes) is generated per setup, so the same passcode never produces the same key twice across different installs.
3. **AES-GCM** (256-bit) encrypts the JSON blob using that key and a random 12-byte **IV** (initialization vector, so identical data never produces identical ciphertext twice).
4. `{salt, iv, ciphertext}` — all safe to store in the open — is what actually sits in `localStorage`. The passcode itself is **never stored anywhere**, only used transiently to derive the key.
5. On unlock, the app re-derives the key from the entered passcode + stored salt and attempts decryption. AES-GCM is *authenticated* encryption — if the passcode is wrong, decryption fails outright (rather than silently producing garbage), which is how the app tells a correct passcode from an incorrect one without ever storing the passcode or a hash of it.

This means: even someone with full access to the phone's file system can't read the health data without the passcode, and there's no passcode-recovery backdoor to attack.

---

## 6. Rendering approach

There's no virtual DOM or reactive framework. The pattern is intentionally simple and explicit:

1. Something changes `state` (e.g., the user saves a log).
2. The app calls `saveState()` (persists to `localStorage`, encrypting first if a passcode is active).
3. The app calls `renderAll()` (or a specific `renderX()` function), which re-reads `state` and rebuilds the relevant DOM section from scratch.

This "re-render the whole section on any change" approach is less efficient than a diffing framework at large scale, but for a UI this size it's simpler to reason about and debug — there's exactly one place data flows from (`state`) to the screen, per view.

---

## 7. Offline support (PWA mechanics)

- `manifest.json` declares the app's name, icon, and colors so the OS can install it like a native app ("Add to Home Screen").
- `sw.js` is a **service worker** — a script the browser runs in the background, separate from the page. On first load it caches the five app-shell files (`index.html`, `style.css`, `app.js`, `manifest.json`, `icon.svg`). On every subsequent load, it serves those files from cache first and only falls back to the network if the cache doesn't have something — so the app opens instantly and works with no signal at all. Since there's no backend to fetch data from anyway (everything's in `localStorage`), the app is fully functional offline, not just "offline-tolerant."

---

## 8. Testing performed

- **Syntax validation:** `node --check app.js` and `node --check sw.js` to catch parse errors before deployment; `manifest.json` validated as parseable JSON.
- **Algorithm testing:** the cycle-derivation and prediction math (`derivePeriods`, average cycle length, ovulation date calculation) was extracted and run standalone against a simulated 3-cycle, 28-day dataset to confirm the averaging and date math produced correct results before wiring it into the UI.
- **Manual UI testing** in-browser: onboarding flow, logging, calendar navigation across months, passcode set/unlock/remove, export/import round-trip.

What hasn't been done yet (worth mentioning to your teacher as next steps): no automated unit test suite (e.g., Jest) and no cross-browser/device matrix testing beyond manual checks — reasonable next additions for a more mature version.

---

## 9. Known limitations

- Ovulation/fertile-window estimates use a fixed 14-day luteal phase for everyone; real luteal phases vary somewhat person to person. A future version could let temperature/symptom tracking refine this per-user.
- No cross-device sync (by design, for privacy) — data is tied to one browser/device unless manually exported and imported.
- The service worker caches on a fixed list of files; adding new files later requires bumping the `CACHE` version string in `sw.js` so old caches get cleared.
