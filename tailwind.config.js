/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./public/**/*.{html,js}",
    "./src/**/*.{html,js}"
  ],
  theme: {
    extend: {
      colors: {
        'glow-purple': '#a855f7',
        'glow-pink': '#ec4899',
        'glow-blue': '#3b82f6',
        'glow-cyan': '#06b6d4',
      },
      animation: {
        'gradient-rotate': 'gradient-rotate 3s linear infinite',
        'float': 'float 6s ease-in-out infinite',
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
      }
    },
  },
  plugins: [],
}