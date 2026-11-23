import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { usePersisted } from '../lib/usePersisted';

const WD = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
interface Emp { id: string; full_name: string; company_id: string; work_days: number[]; department_id: string }
interface Mark { employee_id: string; date: string; active: boolean }

/** Calendario del mes: por persona y por cada uno de sus días de trabajo, si trabajó activamente en el calentamiento.
 *  Por defecto sí. Desmarcar = ese día la primera media hora se paga a la mitad. */
export default function Warmup() {
  const { companyId, can } = useAuth();
  const now = new Date().toLocaleDateString('en-CA');
  const [month, setMonth] = usePersisted('calentamiento:mes', now.slice(0, 7));
  const [emps, setEmps] = useState<Emp[]>([]); const [marks, setMarks] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState<string | null>(null);
  const canEdit = can('warmup', 'edit');

  const days = useMemo(() => {
    const [y, m] = month.split('-').map(Number); const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return Array.from({ length: n }, (_, i) => { const iso = `${month}-${String(i + 1).padStart(2, '0')}`; return { iso, d: i + 1, w: new Date(iso + 'T12:00:00Z').getUTCDay() }; });
  }, [month]);

  const load = useCallback(async () => {
    if (companyId === 'all') return;
    setMsg(null);
    // Solo coaches: el calentamiento no aplica a Staff.
    const [e, dp] = await Promise.all([
      supabase.from('employees').select('id,full_name,company_id,work_days,department_id').eq('company_id', companyId).eq('state', 'activo').order('full_name'),
      supabase.from('departments').select('id,name').eq('company_id', companyId)]);
    if (e.error || dp.error) return setMsg((e.error ?? dp.error)!.message);
    const coach = new Set(((dp.data as { id: string; name: string }[]) ?? []).filter(d => d.name.trim().toLowerCase() === 'coach').map(d => d.id));
    const list = ((e.data as Emp[]) ?? []).filter(x => coach.has(x.department_id)); setEmps(list);
    if (!list.length) return setMarks({});
    const w = await supabase.from('warmup_latest').select('employee_id,date,active').in('employee_id', list.map(x => x.id))
      .gte('date', days[0].iso).lte('date', days[days.length - 1].iso);
    if (w.error) return setMsg(w.error.message);
    setMarks(Object.fromEntries(((w.data as Mark[]) ?? []).map(x => [`${x.employee_id}|${x.date}`, x.active])));
  }, [companyId, days]);
  useEffect(() => { load(); }, [load]);

  async function toggle(emp: Emp, iso: string) {
    const k = `${emp.id}|${iso}`; const next = !(marks[k] ?? true);
    setBusy(k); setMsg(null);
    const { error } = await supabase.from('warmup_marks').insert({ company_id: emp.company_id, employee_id: emp.id, date: iso, active: next });
    setBusy(null);
    if (error) setMsg(error.message); else setMarks({ ...marks, [k]: next });
  }

  if (companyId === 'all') return <p className="rounded-xl border border-dashed bg-white p-4 text-sm text-slate-500">Elige una sucursal en el selector de arriba.</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3 rounded-xl bg-white p-4 shadow-sm">
        <label className="text-xs">Mes<input type="month" className="block rounded-lg border border-slate-300 px-2 py-1.5 text-sm" value={month} onChange={e => e.target.value && setMonth(e.target.value)} /></label>
        <p className="text-xs text-slate-500">✓ = trabajó activamente en el calentamiento (así viene por defecto). Desmarca los días que no: se descuentan 30 minutos de su tarifa. Solo coaches, solo sus días de trabajo y hasta hoy.</p>
      </div>
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
        <table className="text-xs">
          <thead><tr className="bg-slate-100 text-slate-500"><th className="sticky left-0 bg-slate-100 px-3 py-2 text-left">Empleado</th>
            {days.map(x => <th key={x.iso} className={`px-1 py-1 text-center ${x.w === 0 ? 'text-slate-300' : ''}`}>{WD[x.w]}<br />{x.d}</th>)}<th className="px-2">Sin calent.</th></tr></thead>
          <tbody>{emps.map(emp => {
            const off = days.filter(x => emp.work_days.includes(x.w) && x.iso <= now && marks[`${emp.id}|${x.iso}`] === false).length;
            return (
              <tr key={emp.id} className="border-t">
                <td className="sticky left-0 whitespace-nowrap bg-white px-3 py-1.5 font-medium">{emp.full_name}</td>
                {days.map(x => {
                  const k = `${emp.id}|${x.iso}`; const works = emp.work_days.includes(x.w) && x.iso <= now;
                  return <td key={x.iso} className="px-1 text-center">{works
                    ? <input type="checkbox" disabled={!canEdit || busy === k} checked={marks[k] ?? true} onChange={() => toggle(emp, x.iso)} title={x.iso} />
                    : <span className="text-slate-200">·</span>}</td>;
                })}
                <td className={`px-2 text-center ${off ? 'font-semibold text-amber-700' : 'text-slate-400'}`}>{off}</td>
              </tr>);
          })}</tbody>
        </table>
      </div>
    </div>
  );
}
