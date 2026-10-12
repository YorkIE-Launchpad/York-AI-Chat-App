/** Theme colors are CSS variables; color-mix lets opacity modifiers (bg-accent/15) work. */
const themeColor = (name) =>
  `color-mix(in srgb, var(--color-${name}) calc(<alpha-value> * 100%), transparent)`;

/** @type {import('tailwindcss').Config} */
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
          DEFAULT: themeColor('background'),
          secondary: themeColor('background-secondary'),
        },
        surface: {
          DEFAULT: themeColor('surface'),
          hover: themeColor('surface-hover'),
          active: themeColor('surface-active'),
          muted: themeColor('surface-muted'),
          raised: themeColor('surface-raised'),
        },
        border: {
          DEFAULT: themeColor('border'),
          muted: themeColor('border-muted'),
          subtle: themeColor('border-subtle'),
        },
        accent: {
          DEFAULT: themeColor('accent'),
          hover: themeColor('accent-hover'),
          muted: themeColor('accent-muted'),
          text: themeColor('accent-text'),
        },
        mcp: {
          DEFAULT: themeColor('mcp'),
        },
        text: {
          primary: themeColor('text-primary'),
          secondary: themeColor('text-secondary'),
          muted: themeColor('text-muted'),
        },
        success: themeColor('success'),
        warning: themeColor('warning'),
        error: themeColor('error'),
        info: themeColor('info'),
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
