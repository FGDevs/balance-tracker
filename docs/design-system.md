# Design System — Component Recipes & Tailwind Config

Token definitions, color palette, typography, radii, and money-display patterns live in `CLAUDE.md §14.1–14.4 + §14.6`. This file holds the canonical Tailwind class strings for plain-HTML components and the canonical Tailwind config.

The live config is at `tailwind.config.js`; the live CSS variables are at `src/theme/variables.scss`. Treat this doc as a reference for new components, not as an additional source of truth.

---

## Component Recipes (plain HTML + Tailwind)

Reuse these class strings verbatim across the app.

### Hero section (dashboard top, page headers)
```html
<section class="bg-hero text-on-dark px-6 pt-10 pb-8 rounded-b-3xl">
  <p class="text-xs tracking-[0.18em] uppercase text-on-dark-soft text-center">Eyebrow</p>
  <h1 class="font-display text-3xl text-center mt-2">
    Title <span class="italic text-accent-warm">accent</span>
  </h1>
</section>
```

### Card
```html
<div class="bg-card rounded-2xl p-5 shadow-card">
  <p class="text-xs tracking-[0.18em] uppercase text-ink-muted font-semibold">Eyebrow</p>
  <h3 class="font-display text-lg text-ink mt-1">Card title</h3>
  <p class="text-sm text-ink-soft mt-1">Description copy.</p>
</div>
```

### Chip / pill badge
```html
<span class="inline-flex items-center gap-1.5 rounded-full bg-chip-green-bg text-chip-green-ink
             text-xs font-medium px-3 py-1.5">
  <svg class="w-3 h-3">…</svg> Label
</span>
```
Five canonical chip variants: `green` (success/healthy), `coral` (warn/spend), `sky` (info/duration), `amber` (highlight/CTA-soft), `cream` (neutral).

### Segment tabs (e.g. day picker)
```html
<div class="flex gap-2 overflow-x-auto">
  <button class="rounded-full px-4 py-1.5 text-sm font-medium
                 bg-ink text-on-dark">Active</button>
  <button class="rounded-full px-4 py-1.5 text-sm font-medium
                 bg-transparent text-ink border border-ink/15">Inactive</button>
</div>
```

### Primary button (CTA)
```html
<button class="rounded-xl bg-accent text-on-dark font-semibold px-5 py-3
               shadow-[0_2px_8px_-2px_rgba(217,122,60,0.4)]
               active:scale-[0.98] transition">Action</button>
```

### Ghost / secondary button
```html
<button class="rounded-xl bg-transparent text-ink border border-ink/15
               font-medium px-5 py-3">Action</button>
```

### Input
```html
<input class="w-full rounded-xl bg-card border border-ink/10 px-4 py-3
              text-ink placeholder:text-ink-muted
              focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20" />
```

### Banner / inline alert (warm orange)
```html
<div class="bg-banner text-on-dark px-5 py-3 text-sm">
  <span class="font-semibold">Heading:</span> body text.
</div>
```

### FAB
Uses allowed `ion-fab` + `ion-fab-button`, themed via CSS vars — `ion-fab-button` inherits `--ion-color-primary` = accent orange.

---

## Canonical Tailwind Config

```js
// tailwind.config.js
module.exports = {
  content: ['./src/**/*.{html,ts}'],
  theme: {
    extend: {
      colors: {
        hero:           'var(--color-hero)',
        'hero-soft':    'var(--color-hero-soft)',
        app:            'var(--color-app)',
        card:           'var(--color-card)',
        banner:         'var(--color-banner)',
        ink:            'var(--color-ink)',
        'ink-soft':     'var(--color-ink-soft)',
        'ink-muted':    'var(--color-ink-muted)',
        'on-dark':      'var(--color-on-dark)',
        'on-dark-soft': 'var(--color-on-dark-soft)',
        accent:         'var(--color-accent)',
        'accent-warm':  'var(--color-accent-warm)',
        'chip-green-bg': 'var(--chip-green-bg)', 'chip-green-ink': 'var(--chip-green-ink)',
        'chip-coral-bg': 'var(--chip-coral-bg)', 'chip-coral-ink': 'var(--chip-coral-ink)',
        'chip-sky-bg':   'var(--chip-sky-bg)',   'chip-sky-ink':   'var(--chip-sky-ink)',
        'chip-amber-bg': 'var(--chip-amber-bg)', 'chip-amber-ink': 'var(--chip-amber-ink)',
        'chip-cream-bg': 'var(--chip-cream-bg)', 'chip-cream-ink': 'var(--chip-cream-ink)',
      },
      fontFamily: {
        display: ['Fraunces', 'Georgia', 'serif'],
        sans:    ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 2px 12px -4px rgba(61, 36, 24, 0.08)',
      },
    },
  },
  plugins: [],
};
```

---

## Color Tokens (mirror of `src/theme/variables.scss`)

```css
:root {
  /* Surfaces */
  --color-hero:        #3d2418;   /* dark chocolate — hero/header bg */
  --color-hero-soft:   #4a2e1d;   /* lighter chocolate — hero gradient end */
  --color-app:         #faf3ea;   /* cream — app body bg */
  --color-card:        #ffffff;   /* card surface */
  --color-banner:      #cc6c3e;   /* warm orange alert/banner */

  /* Text */
  --color-ink:         #2c1810;   /* primary text on light */
  --color-ink-soft:    #6b4f3a;   /* secondary text on light */
  --color-ink-muted:   #a08570;   /* labels, captions, hints */
  --color-on-dark:     #fdf9f3;   /* primary text on hero */
  --color-on-dark-soft:#d9c7b3;   /* secondary on hero */

  /* Accents */
  --color-accent:      #d97a3c;   /* orange — primary CTAs, active pills */
  --color-accent-warm: #e9b067;   /* golden amber — display headings */

  /* Pastel chip palette (bg + matching ink) */
  --chip-green-bg:  #dff5e1;  --chip-green-ink:  #2f7a3d;
  --chip-coral-bg:  #fde2e0;  --chip-coral-ink:  #b54a3c;
  --chip-sky-bg:    #dde8f4;  --chip-sky-ink:    #3a6a9a;
  --chip-amber-bg:  #fbe9c9;  --chip-amber-ink:  #9a6a1f;
  --chip-cream-bg:  #f3e7d3;  --chip-cream-ink:  #6b4f3a;

  /* Semantic (mapped onto Ionic vars so allowed Ionic components inherit) */
  --ion-color-primary: var(--color-accent);
  --ion-color-success: #2f7a3d;
  --ion-color-danger:  #b54a3c;
  --ion-color-warning: #e9b067;
  --ion-background-color: var(--color-app);
  --ion-text-color:       var(--color-ink);
}
```
