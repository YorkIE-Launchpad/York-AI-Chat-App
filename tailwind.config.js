/** @type {import('tailwindcss').Config} */

/**
 * Theme colors that support Tailwind opacity modifiers (e.g. bg-mcp/10).
 * Uses relative color syntax so alpha is applied to the color itself —
 * color-mix(..., transparent) treats transparent as black and looks wrong in light mode.
 */
function themeColor(cssVar) {
  return `rgb(from var(${cssVar}) r g b / <alpha-value>)`;
}

module.exports = {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Use CSS variables for theme-aware colors
        background: {
          DEFAULT: themeColor('--color-background'),
          secondary: themeColor('--color-background-secondary'),
        },
        surface: {
          DEFAULT: themeColor('--color-surface'),
          hover: themeColor('--color-surface-hover'),
          active: themeColor('--color-surface-active'),
          muted: themeColor('--color-surface-muted'),
        },
        border: {
          DEFAULT: themeColor('--color-border'),
          muted: themeColor('--color-border-muted'),
          // Already includes alpha in the CSS variable — don't wrap
          subtle: 'var(--color-border-subtle)',
        },
        accent: {
          DEFAULT: themeColor('--color-accent'),
          hover: themeColor('--color-accent-hover'),
          // Already includes alpha in the CSS variable — don't wrap
          muted: 'var(--color-accent-muted)',
        },
        mcp: {
          DEFAULT: themeColor('--color-mcp'),
        },
        text: {
          primary: themeColor('--color-text-primary'),
          secondary: themeColor('--color-text-secondary'),
          muted: themeColor('--color-text-muted'),
        },
        success: themeColor('--color-success'),
        warning: themeColor('--color-warning'),
        error: themeColor('--color-error'),
      },
      fontFamily: {
        sans: ['Plus Jakarta Sans', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'Menlo', 'monospace'],
      },
      boxShadow: {
        'soft': 'var(--shadow-soft)',
        'card': 'var(--shadow-card)',
        'elevated': 'var(--shadow-elevated)',
      },
      borderRadius: {
        'lg': '8px',
        'xl': '10px',
        '2xl': '14px',
        '3xl': '16px',
      },
      backgroundImage: {
        'grid-pattern': `url("data:image/svg+xml,%3Csvg width='40' height='40' viewBox='0 0 40 40' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23d4d2cc' fill-opacity='0.4'%3E%3Cpath d='M0 0h1v40H0V0zm39 0h1v40h-1V0z'/%3E%3Cpath d='M0 0h40v1H0V0zm0 39h40v1H0v-1z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
      },
      animation: {
        'fade-in': 'fadeIn 0.2s ease-out',
        'slide-up': 'slideUp 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
        'spin-slow': 'spin 2s linear infinite',
        'expand': 'expand 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        expand: {
          '0%': { opacity: '0', maxHeight: '0' },
          '100%': { opacity: '1', maxHeight: '500px' },
        },
      },
    },
  },
  plugins: [],
}
