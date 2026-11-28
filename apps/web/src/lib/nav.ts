/** Navegar entre módulos desde cualquier pantalla (p. ej. "Nueva venta" en la ficha abre Caja con la alumna). */
export function goTo(module: string, data?: Record<string, string>) {
  if (data) for (const [k, v] of Object.entries(data)) localStorage.setItem(`esgila:${k}`, v);
  window.dispatchEvent(new CustomEvent('esgila:go', { detail: module }));
}
/** Lee y borra un dato dejado por goTo. */
export function takeNavData(key: string): string | null {
  const v = localStorage.getItem(`esgila:${key}`); if (v !== null) localStorage.removeItem(`esgila:${key}`); return v;
}
