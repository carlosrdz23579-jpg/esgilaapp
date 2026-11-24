import { useState } from 'react';
import { supabase } from '../lib/supabase';
import type { EmpLite } from '../lib/attendanceData';
import { effectiveFor, type Schedule } from './Companies';
import { Modal } from './ui';

const WD = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const addDays = (iso: string, n: number) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** Pasar personas a nómina semanal (p. ej. sueldo fijo semanal). Crea su calendario de pago individual. */
export function Weekly({ companyId, emps, scheds, onClose, onDone }:
  { companyId: string; emps: EmpLite[]; scheds: Schedule[]; onClose: () => void; onDone: () => void }) {
  const today = new Date().toLocaleDateString('en-CA');
  const freqOf = (e: EmpLite) => effectiveFor(scheds, { id: e.id, department_id: e.department_id ?? '', group_id: e.group_id ?? null }, today)?.frequency ?? 'sin calendario';
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [weekday, setWeekday] = useState(6);
  const [from, setFrom] = useState(addDays(today, -84));
  const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');

  async function save() {
    if (!sel.size) return setMsg('Elige al menos una persona.');
    setBusy(true); setMsg(null);
    const { error } = await supabase.from('pay_schedules').insert([...sel].map(id => ({
      company_id: companyId, scope: 'empleado', employee_id: id, frequency: 'semanal', weekly_weekday: weekday,
      weekend_rule: 'antes', cutoff: 'dia_de_pago', effective_from: from, reason: 'Nómina semanal' })));
    setBusy(false);
    if (error) return setMsg(error.message);
    onDone();
  }
  const list = emps.filter(e => !q || e.full_name.toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal wide title="Pasar personas a nómina semanal" onClose={onClose}>
      <p className="text-sm text-slate-600">Quienes elijas dejan su calendario actual y cobran cada semana. Su semana termina el día de pago y se le paga ese día (si no le toca trabajar, su día laborable anterior). Se puede revertir en Empresas → Calendarios de pago.</p>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="text-xs">Día de pago<select className="block rounded-lg border px-2 py-1.5 text-sm" value={weekday} onChange={e => setWeekday(+e.target.value)}>
          {WD.map((d, i) => <option key={i} value={i}>{d}</option>)}</select></label>
        <label className="text-xs">Desde<input type="date" className="block rounded-lg border px-2 py-1.5 text-sm" value={from} onChange={e => setFrom(e.target.value)} />
          <span className="text-[11px] text-slate-500">Puede ser pasado si aún no hay nóminas autorizadas en esas fechas.</span></label>
        <input className="ml-auto rounded-lg border px-2 py-1.5 text-sm" placeholder="Buscar…" value={q} onChange={e => setQ(e.target.value)} />
      </div>
      <div className="max-h-[50vh] overflow-auto rounded border">
        {list.map(e => (
          <label key={e.id} className="flex items-center gap-2 border-b px-3 py-1.5 text-sm last:border-0">
            <input type="checkbox" checked={sel.has(e.id)} onChange={ev => { const n = new Set(sel); if (ev.target.checked) n.add(e.id); else n.delete(e.id); setSel(n); }} />
            {e.full_name}<span className="ml-auto text-xs text-slate-400">hoy: {freqOf(e)}</span></label>))}
      </div>
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      <button disabled={busy || !sel.size} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50" onClick={save}>Pasar {sel.size || ''} a semanal</button>
    </Modal>
  );
}
