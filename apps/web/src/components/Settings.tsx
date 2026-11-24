import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { TimeSelect } from './ui';

const field = 'rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand';
const DAYS: [number, string][] = [[1, 'Lunes'], [2, 'Martes'], [3, 'Miércoles'], [4, 'Jueves'], [5, 'Viernes'], [6, 'Sábado'], [0, 'Domingo']];
interface Slot { start: string; end: string; teachers: number }
interface Cfg {
  warmup_schedule: Record<string, Slot[]>; late_tolerance_min: number; late_deduction_bps: number;
  warmup_deduction_min: number; planning_deadline_day: number; planning_max_uploads: number;
}
const COLS = 'warmup_schedule,late_tolerance_min,late_deduction_bps,warmup_deduction_min,planning_deadline_day,planning_max_uploads';

/** Configuración por sucursal: todo lo que antes estaba fijo. */
export default function Settings() {
  const { companyId, companies, can } = useAuth();
  const [co, setCo] = useState(companyId !== 'all' ? companyId : companies[0]?.id ?? '');
  useEffect(() => { if (companyId !== 'all') setCo(companyId); }, [companyId]);
  const [cfg, setCfg] = useState<Cfg | null>(null); const [saved, setSaved] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null); const [busy, setBusy] = useState(false);
  const canEdit = can('settings', 'configure');

  const load = useCallback(async () => {
    if (!co) return;
    const { data, error } = await supabase.from('companies').select(COLS).eq('id', co).single();
    if (error) return setMsg({ ok: false, text: error.message });
    setCfg(data as Cfg); setSaved(JSON.stringify(data)); setMsg(null);
  }, [co]);
  useEffect(() => { load(); }, [load]);
  const dirty = !!cfg && JSON.stringify(cfg) !== saved;

  async function save() {
    if (!cfg) return;
    for (const [d, list] of Object.entries(cfg.warmup_schedule))
      for (const s of list) if (s.end <= s.start) return setMsg({ ok: false, text: `${DAYS.find(x => String(x[0]) === d)?.[1]}: la hora de fin debe ser después del inicio.` });
    setBusy(true);
    const clean = { ...cfg, warmup_schedule: Object.fromEntries(Object.entries(cfg.warmup_schedule).filter(([, v]) => v.length > 0)) };
    const { data, error } = await supabase.from('companies').update(clean).eq('id', co).select('id');
    setBusy(false);
    if (error) return setMsg({ ok: false, text: error.message });
    if (!data?.length) return setMsg({ ok: false, text: 'No se guardó: necesitas permiso de Configuración.' });
    setMsg({ ok: true, text: 'Configuración guardada.' }); load();
  }

  const setDay = (d: number, list: Slot[]) => cfg && setCfg({ ...cfg, warmup_schedule: { ...cfg.warmup_schedule, [String(d)]: list } });
  const day = (d: number) => cfg?.warmup_schedule[String(d)] ?? [];

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-xl bg-white p-3 shadow-sm">
        <label className="text-sm">Sucursal <select className={field} value={co} onChange={e => { if (!dirty || window.confirm('Hay cambios sin guardar. ¿Descartarlos?')) setCo(e.target.value); }}>
          {companies.map(c => <option key={c.id} value={c.id}>{c.trade_name}</option>)}</select></label>
        {dirty && <span className="text-sm text-amber-700">Cambios sin guardar</span>}
        {canEdit && <span className="ml-auto flex gap-2">
          {dirty && <button className="rounded-lg border px-3 py-1.5 text-sm" onClick={load}>Descartar</button>}
          <button disabled={!dirty || busy} className="rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50" onClick={save}>Guardar</button></span>}
      </div>
      {!canEdit && <p className="rounded bg-slate-100 p-2 text-sm text-slate-600">Puedes ver la configuración; para cambiarla necesitas Configuración → Configurar.</p>}
      {msg && <p className={`rounded p-2 text-sm ${msg.ok ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700'}`}>{msg.text}</p>}
      {cfg && <fieldset disabled={!canEdit} className="space-y-4">

        <section className="space-y-2 rounded-xl bg-white p-4 shadow-sm">
          <h3 className="font-semibold">🔥 Calentamiento</h3>
          <p className="text-xs text-slate-500">Qué días hay calentamiento, a qué hora y cuántos maestros lo dirigen. Lo que quites aquí deja de aparecer en el calendario; la rotación semanal se acomoda a estos días.</p>
          <div className="divide-y rounded-lg border">{DAYS.map(([d, name]) => {
            const list = day(d);
            return (
              <div key={d} className="flex flex-wrap items-start gap-3 p-2">
                <label className="flex w-32 items-center gap-2 pt-1.5 text-sm font-medium">
                  <input type="checkbox" checked={list.length > 0} onChange={e => setDay(d, e.target.checked ? [{ start: '16:00', end: '17:00', teachers: 1 }] : [])} />{name}</label>
                <div className="flex-1 space-y-1">
                  {list.length === 0 && <p className="pt-1.5 text-xs text-slate-400">Sin calentamiento</p>}
                  {list.map((s, k) => (
                    <div key={k} className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="text-xs text-slate-400">{k + 1}º</span>
                      <TimeSelect value={s.start} onChange={v => setDay(d, list.map((x, j) => j === k ? { ...x, start: v } : x))} /> a
                      <TimeSelect value={s.end} onChange={v => setDay(d, list.map((x, j) => j === k ? { ...x, end: v } : x))} />
                      <select className={field} value={s.teachers} onChange={e => setDay(d, list.map((x, j) => j === k ? { ...x, teachers: +e.target.value } : x))}>
                        {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n} maestro{n > 1 ? 's' : ''}</option>)}</select>
                      <button type="button" aria-label="Quitar" className="text-red-700" onClick={() => setDay(d, list.filter((_, j) => j !== k))}>×</button>
                    </div>))}
                  {list.length > 0 && list.length < 4 && <button type="button" className="text-xs text-brand" onClick={() => {
                    const last = list[list.length - 1]; setDay(d, [...list, { start: last.end, end: last.end, teachers: last.teachers }]); }}>+ otro calentamiento este día</button>}
                </div>
                {list.length > 0 && <select className="text-xs text-brand" value="" onChange={e => {
                  const to = e.target.value === 'todos' ? DAYS.map(x => x[0]).filter(x => x !== d && day(x).length > 0) : [+e.target.value];
                  setCfg({ ...cfg, warmup_schedule: { ...cfg.warmup_schedule, ...Object.fromEntries(to.map(t => [String(t), list.map(x => ({ ...x }))])) } });
                }}>
                  <option value="">Copiar a…</option><option value="todos">Todos los días con calentamiento</option>
                  {DAYS.filter(x => x[0] !== d).map(([x, n]) => <option key={x} value={x}>{n}</option>)}</select>}
              </div>);
          })}</div>
        </section>

        <section className="grid gap-3 rounded-xl bg-white p-4 shadow-sm sm:grid-cols-3">
          <h3 className="font-semibold sm:col-span-3">⏱️ Asistencia y nómina</h3>
          <label className="text-sm">Tolerancia antes de retardo
            <select className={`${field} block w-full`} value={cfg.late_tolerance_min} onChange={e => setCfg({ ...cfg, late_tolerance_min: +e.target.value })}>
              {[0, 5, 10, 15, 20, 25, 30].map(n => <option key={n} value={n}>{n} minutos</option>)}</select>
            <span className="text-xs text-slate-500">Llegar o salir dentro de este margen no cuenta.</span></label>
          <label className="text-sm">Rebaja por cada retardo
            <select className={`${field} block w-full`} value={cfg.late_deduction_bps} onChange={e => setCfg({ ...cfg, late_deduction_bps: +e.target.value })}>
              {[0, 1000, 2000, 2500, 3000, 4000, 5000, 7500, 10000].map(n => <option key={n} value={n}>{n / 100} % de una hora</option>)}</select>
            <span className="text-xs text-slate-500">Se pagan todas sus horas; esto se descuenta aparte.</span></label>
          <label className="text-sm">Día sin calentamiento activo (coaches)
            <select className={`${field} block w-full`} value={cfg.warmup_deduction_min} onChange={e => setCfg({ ...cfg, warmup_deduction_min: +e.target.value })}>
              {[0, 15, 30, 45, 60].map(n => <option key={n} value={n}>{n === 0 ? 'No se descuenta' : `se descuentan ${n} min`}</option>)}</select></label>
          <p className="text-xs text-slate-500 sm:col-span-3">Los cambios aplican a las nóminas que calcules después; las ya autorizadas no cambian. Los días y horas de pago están en Empresas → Calendarios de pago.</p>
        </section>

        <section className="grid gap-3 rounded-xl bg-white p-4 shadow-sm sm:grid-cols-3">
          <h3 className="font-semibold sm:col-span-3">📚 Planeaciones</h3>
          <label className="text-sm">Fecha límite de la planeación mensual
            <select className={`${field} block w-full`} value={cfg.planning_deadline_day} onChange={e => setCfg({ ...cfg, planning_deadline_day: +e.target.value })}>
              {Array.from({ length: 28 }, (_, i) => i + 1).map(n => <option key={n} value={n}>Día {n} del mes anterior</option>)}</select></label>
          <label className="text-sm">Envíos permitidos por parte
            <select className={`${field} block w-full`} value={cfg.planning_max_uploads} onChange={e => setCfg({ ...cfg, planning_max_uploads: +e.target.value })}>
              {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
        </section>
      </fieldset>}
    </div>
  );
}
