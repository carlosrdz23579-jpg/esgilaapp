/** Colores corporativos configurables: cambiar --brand en index.css */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: { extend: { colors: { brand: { DEFAULT: 'rgb(var(--brand) / <alpha-value>)' } } } },
  plugins: [],
};
