/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{html,ts}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Legacy palette (primary/background/glass/status/text hexes) deleted
        // 2026-06-12: the last classes consuming it lived in styles.scss and
        // were removed with the glass-era components (grep over src/**/*.{html,ts}
        // found no remaining utility usage).

        // Orion neobank palette (new horizontal swap UI)
        // Each utility maps to a CSS variable in _tokens.scss so runtime
        // theming stays the single source of truth.
        'orion': {
          'bg':              'var(--orion-bg)',
          'surface':         'var(--orion-surface)',
          'surface-2':       'var(--orion-surface-2)',
          'surface-3':       'var(--orion-surface-3)',
          'border':          'var(--orion-border)',
          'border-strong':   'var(--orion-border-strong)',
          'text':            'var(--orion-text)',
          'muted':           'var(--orion-muted)',
          'subtle':          'var(--orion-subtle)',
          'accent':          'var(--orion-accent)',
          'accent-hover':    'var(--orion-accent-hover)',
          'accent-tint':     'var(--orion-accent-tint)',
          'success':         'var(--orion-success)',
          'success-tint':    'var(--orion-success-tint)',
          'warning':         'var(--orion-warning)',
          'warning-tint':    'var(--orion-warning-tint)',
          'danger':          'var(--orion-danger)',
          'danger-tint':     'var(--orion-danger-tint)',
          'health-safe':     'var(--orion-health-safe)',
          'health-low':      'var(--orion-health-low)',
          'health-medium':   'var(--orion-health-medium)',
          'health-high':     'var(--orion-health-high)',
          'health-critical': 'var(--orion-health-critical)',
        },
      },
      fontFamily: {
        // `font-display` is still consumed by the body rule in styles.scss.
        'display': ['Manrope', 'sans-serif'],
        // Orion neobank typography — single sans (Manrope); mono is for
        // addresses/hashes only (see .orion-mono in _components.scss).
        'orion': ['Manrope', 'system-ui', '-apple-system', 'sans-serif'],
        'orion-mono': ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        'DEFAULT': '0.5rem',
        'lg': '1rem',
        'xl': '1.5rem',
        '2xl': '2rem',
        '3xl': '2.5rem',
      },
      // Legacy boxShadow (glass/glow) and backdropBlur extensions deleted
      // 2026-06-12 with the glass-era classes in styles.scss — the orion
      // system is flat: no glows, no blur.
      animation: {
        // Only the toast entry animation survived the orion migration; the
        // rest of the motion system lives in _animations.scss (orion-*).
        'slide-up': 'slideUp 0.3s ease-out',
      },
      keyframes: {
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(20px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
}
