import { useEffect, useRef, useState } from 'react';
import { usePrefs } from '../lib/prefs';
import { Icon } from './icons';

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

/** Menú que se despliega bajo un botón; se cierra al dar clic fuera o con Esc. */
export function Dropdown({ open, onClose, button, children, align = 'right' }: { open: boolean; onClose: () => void; button: React.ReactNode; children: React.ReactNode; align?: 'left' | 'right' }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', h); document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [open, onClose]);
  return (
    <div ref={ref} className="relative">
      {button}
      {open && <div className={`absolute ${align === 'right' ? 'right-0' : 'left-0'} z-40 mt-2 w-64 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-xl`}>{children}</div>}
    </div>
  );
}

/** Pestañas de un módulo: se pueden reordenar arrastrándolas (cada quien su orden) y las de
 *  configuración del módulo van escondidas en el engrane. */
export function ModuleTabs({ id, tabs, settings = [], value, onChange, right }: { id: string; tabs: [string, string][]; settings?: [string, string][];
  value: string; onChange: (k: string) => void; right?: React.ReactNode }) {
  const { prefs, set } = usePrefs(); const [drag, setDrag] = useState<string | null>(null); const [gear, setGear] = useState(false);
  const saved = prefs.tabs[id] ?? [];
  const ordered = [...tabs].sort((a, b) => (saved.indexOf(a[0]) + 1 || 99) - (saved.indexOf(b[0]) + 1 || 99));
  const drop = (target: string) => {
    if (!drag || drag === target) return;
    const keys = ordered.map(t => t[0]); const from = keys.indexOf(drag); const to = keys.indexOf(target);
    keys.splice(from, 1); keys.splice(to, 0, drag); set({ tabs: { ...prefs.tabs, [id]: keys } }); setDrag(null);
  };
  const inSettings = settings.find(s => s[0] === value);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap gap-1 rounded-2xl bg-slate-100 p-1">
        {ordered.map(([k, l]) => <button key={k} draggable onDragStart={() => setDrag(k)} onDragOver={e => e.preventDefault()} onDrop={() => drop(k)} onDragEnd={() => setDrag(null)}
          onClick={() => onChange(k)} title="Arrastra para acomodar"
          className={`rounded-xl px-3.5 py-1.5 text-sm transition ${value === k ? 'bg-white font-semibold text-brand shadow-sm' : 'text-slate-600 hover:text-slate-900'} ${drag === k ? 'opacity-40' : ''}`}>{l}</button>)}
      </div>
      {inSettings && <span className="flex items-center gap-1.5 rounded-xl bg-brand/10 px-3 py-1.5 text-sm font-semibold text-brand">
        <Icon name="gear" className="h-4 w-4" />{inSettings[1]}<button onClick={() => onChange(ordered[0][0])} aria-label="Cerrar ajustes"><Icon name="x" className="h-3.5 w-3.5" /></button></span>}
      <div className="ml-auto flex items-center gap-2">
        {right}
        {settings.length > 0 && <Dropdown open={gear} onClose={() => setGear(false)} button={
          <button onClick={() => setGear(!gear)} title="Ajustes de este módulo" className={`grid h-9 w-9 place-items-center rounded-xl border border-slate-200 bg-white transition hover:bg-slate-50 ${inSettings ? 'text-brand' : 'text-slate-500'}`}>
            <Icon name="gear" className="h-[18px] w-[18px]" /></button>}>
          <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Ajustes</p>
          {settings.map(([k, l]) => <button key={k} onClick={() => { onChange(k); setGear(false); }}
            className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-100 ${value === k ? 'font-semibold text-brand' : ''}`}>{l}</button>)}
        </Dropdown>}
      </div>
    </div>
  );
}
