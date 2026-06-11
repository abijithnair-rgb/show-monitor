/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,jsx}',
    './components/**/*.{js,jsx}',
    './lib/**/*.{js,jsx}',
  ],
  theme: {
    extend: {
      colors: {
        // chatbot green-and-white theme tokens
        theme: {
          solid: '#1D9E75', // primary brand green
          bg: '#E8F7F0', // light tint for bot bubbles / chips
          fg: '#0B5D44', // dark green text
          border: '#B7E4D0', // soft green border
        },
      },
    },
  },
  plugins: [],
};
