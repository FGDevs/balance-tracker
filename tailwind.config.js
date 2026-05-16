/** @type {import('tailwindcss').Config} */
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
