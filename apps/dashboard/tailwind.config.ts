import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Tarmoto brand
        tarmoto: {
          cyan: '#0ED3CF',
          'cyan-light': '#5DE5E2',
          'cyan-dark': '#0AA8A5',
        },
        // Road quality scale
        quality: {
          excellent: '#22C55E',
          good: '#84CC16',
          fair: '#EAB308',
          poor: '#F97316',
          'very-poor': '#EF4444',
        },
        // Surface types
        surface: {
          asphalt: '#3B82F6',
          concrete: '#6B7280',
          cobblestone: '#A78BFA',
          gravel: '#D97706',
          dirt: '#92400E',
        },
        // UI colors
        slate: {
          850: '#172033',
          950: '#0B1120',
        },
      },
      fontFamily: {
        sans: ['Plus Jakarta Sans', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      spacing: {
        '18': '4.5rem',
        '88': '22rem',
        '100': '25rem',
        '120': '30rem',
      },
      borderRadius: {
        '4xl': '2rem',
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'slide-in-right': 'slideInRight 0.3s ease-out',
        'pulse-slow': 'pulse 3s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideInRight: {
          '0%': { opacity: '0', transform: 'translateX(20px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
