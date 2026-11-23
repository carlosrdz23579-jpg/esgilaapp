import { useEffect } from 'react';

/** Ventana encima de la página. Se cierra con la ×, con Esc o dando clic fuera. */
export function Modal({ title, onClose, children, wide }: { title: React.ReactNode; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4 print:static print:bg-white" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`w-full ${wide ? 'max-w-5xl' : 'max-w-2xl'} space-y-4 rounded-2xl bg-white p-5 shadow-xl`}>
        <div className="flex items-center justify-between gap-3"><h3 className="text-lg font-semibold">{title}</h3>
          <button onClick={onClose} aria-label="Cerrar" className="text-2xl leading-none text-slate-500 hover:text-slate-800">×</button></div>
        {children}
      </div>
    </div>
  );
}

/** Horas de 15 en 15 minutos (sin escribir a mano). */
export const QUARTERS = Array.from({ length: 24 * 4 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`);
export function TimeSelect({ value, onChange, className, from = '05:00', allowAny }:
  { value: string; onChange: (v: string) => void; className?: string; from?: string; allowAny?: boolean }) {
  const opts = QUARTERS.filter(q => q >= from);
  const extra = value && !opts.includes(value) ? [value] : [];      // una checada real (16:04) se conserva si se corrige otra
  return (
    <select className={className ?? 'rounded-lg border border-slate-300 px-2 py-1.5 text-sm'} value={value} onChange={e => onChange(e.target.value)}>
      {allowAny && <option value="">—</option>}
      {[...extra, ...opts].sort().map(q => <option key={q} value={q}>{q}</option>)}
    </select>
  );
}

/** Horas pagables en medias horas: 0:00, 0:30 … 14:00. */
export const HALF_HOURS = Array.from({ length: 29 }, (_, i) => i * 30);
export const hm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
