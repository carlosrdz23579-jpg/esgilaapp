// El dinero siempre se maneja en centavos enteros; aquí solo se convierte para mostrar/capturar.
export function pesosToCents(input: string): number | null {
  const m = input.trim().replace(/,/g, '').match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const cents = BigInt(m[1]) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(cents);
}

export function formatMXN(cents: number | bigint | string): string {
  const c = BigInt(cents);
  const neg = c < 0n; const v = neg ? -c : c;
  const whole = (v / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}$${whole}.${(v % 100n).toString().padStart(2, '0')}`;
}
