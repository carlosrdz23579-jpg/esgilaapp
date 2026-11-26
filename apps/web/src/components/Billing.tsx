import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { usePersisted } from '../lib/usePersisted';
import { formatMXN } from '../lib/money';

const field = 'rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand';
const btn = 'rounded-lg bg-brand px-3 py-2 text-sm text-white disabled:opacity-50';
const todayMx = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
export const thisMonth = () => todayMx().slice(0, 7);
export const toCents = (s: string) => Math.round(parseFloat(s.replace(/[$,\s]/g, '') || '0') * 100);
const CATS: Record<string, string> = { indumentaria: 'Indumentaria', accesorio: 'Accesorio', tiendita: 'Tiendita', evento: 'Evento', servicio: 'Servicio', otro: 'Otro' };

export interface DiscRule { company_id: string; discipline: string; is_combo: boolean; min_hours: number; max_hours: number; max_total_hours: number; min_total_hours: number | null }
export interface Plan { id: string; company_id: string; discipline: string; name: string; hours_per_week: number | null; kind: 'individual' | 'familiar';
  max_members: number | null; is_active: boolean; sort: number; price_cents: number | null; active_subs: number; use_table: boolean; table_label: string | null }

function useCompany() {
  const { companyId, companies } = useAuth();
  const [co, setCo] = usePersisted('cobranza.sucursal', companyId !== 'all' ? companyId : companies[0]?.id ?? '');
  useEffect(() => { if (companyId !== 'all') setCo(companyId); }, [companyId, setCo]);
  return [co, setCo] as const;
}

export default function Billing() {
  const { companies, can } = useAuth();
  const canCfg = can('billing', 'configure');
  const [co, setCo] = useCompany();
  const tabs: [string, string][] = [['tabla', 'Tabla de precios'], ['planes', 'Planes por disciplina'], ['grupos', 'Grupos y cupo'], ['productos', 'Productos'], ['reglas', 'Reglas, anualidad y formas de pago']];
  const [tab, setTab] = usePersisted('cobranza.tab', 'planes');
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1 border-b">
        {tabs.map(([k, l]) => <button key={k} onClick={() => setTab(k)}
          className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === k ? 'border-brand font-semibold text-brand' : 'border-transparent text-slate-500'}`}>{l}</button>)}
        <select className="ml-auto rounded border px-2 py-1 text-sm" value={co} onChange={e => setCo(e.target.value)}>
          {companies.map(c => <option key={c.id} value={c.id}>{c.trade_name}</option>)}</select>
      </div>
      <p className="text-xs text-slate-500">Los planes se asignan desde la ficha de cada alumna (Alumnas → clic en su nombre). Los cobros, saldos y caja vienen en la siguiente etapa.</p>
      {co && tab === 'tabla' && <PriceTable co={co} canCfg={canCfg} />}
      {co && tab === 'planes' && <Plans co={co} canCfg={canCfg} />}
      {co && tab === 'grupos' && <Groups co={co} canCfg={canCfg} />}
      {co && tab === 'productos' && <Products co={co} canCfg={canCfg} />}
      {co && tab === 'reglas' && <Rules co={co} canCfg={canCfg} />}
    </div>
  );
}

// ---------------------------------------------------------------- Planes
const hoursName = (h: number) => `${h} ${h === 1 ? 'hora' : 'horas'} por semana`;

function Plans({ co, canCfg }: { co: string; canCfg: boolean }) {
  const [plans, setPlans] = useState<Plan[]>([]); const [msg, setMsg] = useState<string | null>(null);
  const [from, setFrom] = useState(thisMonth());
  const [hist, setHist] = useState<{ plan: Plan; rows: { effective_month: string; price_cents: number; created_at: string }[] } | null>(null);
  const [newDisc, setNewDisc] = useState<{ name: string; combo: boolean; maxTotal: string; rows: { hours: string; price: string }[] } | null>(null);
  const [rules, setRules] = useState<DiscRule[]>([]); const [labels, setLabels] = useState<string[]>([]);
  const load = useCallback(async () => {
    const lb = await supabase.from('hour_prices_current').select('label').eq('company_id', co).not('label', 'is', null).not('price_cents', 'is', null);
    setLabels([...new Set((lb.data ?? []).map(x => x.label as string))]);
    const [p, r] = await Promise.all([supabase.from('plans_v').select('*').eq('company_id', co).order('discipline').order('hours_per_week').order('name'),
      supabase.from('discipline_rules').select('*').eq('company_id', co)]);
    if (p.error) setMsg(p.error.message); setPlans((p.data as Plan[]) ?? []); setRules((r.data as DiscRule[]) ?? []);
  }, [co]);
  async function saveRule(discipline: string, v: Partial<DiscRule>) {
    const cur = rules.find(r => r.discipline === discipline);
    const { error } = await supabase.from('discipline_rules').upsert({ company_id: co, discipline, is_combo: cur?.is_combo ?? false, min_hours: cur?.min_hours ?? 1,
      max_hours: cur?.max_hours ?? 8, max_total_hours: cur?.max_total_hours ?? 12, min_total_hours: cur?.min_total_hours ?? null, ...v, updated_at: new Date().toISOString() });
    if (error) setMsg(error.message); else load();
  }
  useEffect(() => { load(); }, [load]);
  const disciplines = [...new Set(plans.map(p => p.discipline))];

  async function addTier(discipline: string, hours: string, price: string, name?: string) {
    const h = hours ? +hours : null;
    const nm = (name?.trim() || (h ? hoursName(h) : '')).trim();
    const label = !h && !price ? labels.find(l => l.toLowerCase() === nm.toLowerCase()) ?? null : null;
    if (!h && !price && !label) return `"${nm}" no tiene horas ni está en la Tabla de precios: agrégalo ahí como renglón de texto o ponle precio propio.`;
    const { data, error } = await supabase.from('plans').insert({ company_id: co, discipline, name: (name?.trim() || (h ? hoursName(h) : '')).trim(),
      hours_per_week: h, use_table: !price && (h !== null || !!label), table_label: label, sort: plans.filter(p => p.discipline === discipline).length + 1 }).select('id').single();
    if (error) return error.message.includes('unique') ? `Ya existe "${name || hoursName(h ?? 0)}" en ${discipline}.` : error.message;
    if (price) { const r = await supabase.from('plan_prices').insert({ plan_id: data.id, effective_month: `${from}-01`, price_cents: toCents(price) }); if (r.error) return r.error.message; }
    return null;
  }
  async function setPrice(p: Plan, price: string) {
    if (!price.trim() || (toCents(price) === p.price_cents && !p.use_table)) return;
    const { error } = await supabase.from('plan_prices').insert({ plan_id: p.id, effective_month: `${from}-01`, price_cents: toCents(price) });
    if (error) return setMsg(error.message);
    if (p.use_table) { const r = await supabase.from('plans').update({ use_table: false }).eq('id', p.id); if (r.error) return setMsg(r.error.message); }
    load();
  }
  async function patch(p: Plan, v: Partial<Plan>) { const { error } = await supabase.from('plans').update(v).eq('id', p.id); if (error) setMsg(error.message); else load(); }
  async function showHist(p: Plan) {
    const r = await supabase.from('plan_prices').select('effective_month,price_cents,created_at').eq('plan_id', p.id).order('effective_month', { ascending: false }).order('created_at', { ascending: false });
    setHist({ plan: p, rows: r.data ?? [] });
  }
  async function saveDisc() {
    if (!newDisc) return; setMsg(null);
    if (newDisc.combo) await saveRule(newDisc.name.trim(), { is_combo: true, max_total_hours: +newDisc.maxTotal || 12 });
    const filled = newDisc.rows.filter(r => r.hours || r.price);
    // disciplina de un solo plan de la tabla (Equipo, Pre-Equipo…): se crea con ese renglón de texto
    if (!filled.length && labels.some(l => l.toLowerCase() === newDisc.name.trim().toLowerCase())) {
      const e = await addTier(newDisc.name.trim(), '', '', newDisc.name.trim()); if (e) return setMsg(e);
    }
    for (const r of filled) { const e = await addTier(newDisc.name.trim(), r.hours, r.price); if (e) return setMsg(e); }
    setNewDisc(null); load();
  }

  return (
    <div className="space-y-4">
      {canCfg && <div className="flex flex-wrap items-center gap-2 rounded-xl bg-white p-3 text-sm shadow-sm">
        <span>Los precios que cambies aplican desde</span><input type="month" className={field} value={from} onChange={e => setFrom(e.target.value)} />
        <span className="text-xs text-slate-500">· los meses anteriores conservan su precio (queda historial).</span>
        <button className="ml-auto rounded-lg border border-brand px-3 py-2 text-sm text-brand" onClick={() => setNewDisc({ name: 'Doble disciplina', combo: true, maxTotal: '12',
          rows: [2, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 9, 10, 11, 12].map(h => ({ hours: String(h), price: '' })) })}>+ Doble disciplina</button>
        <button className={btn} onClick={() => setNewDisc({ name: '', combo: false, maxTotal: '12', rows: [{ hours: '1', price: '' }, { hours: '2', price: '' }, { hours: '3', price: '' }, { hours: '4', price: '' }] })}>+ Nueva disciplina</button>
      </div>}

      {newDisc && <div className="space-y-2 rounded-xl border-2 border-brand/30 bg-white p-4 text-sm shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs">Disciplina<input autoFocus className={`${field} block w-64`} placeholder="Baby Gym" value={newDisc.name} onChange={e => setNewDisc({ ...newDisc, name: e.target.value })} /></label>
          <label className="flex items-center gap-1 pb-2 text-xs"><input type="checkbox" checked={newDisc.combo} onChange={e => setNewDisc({ ...newDisc, combo: e.target.checked })} />Es combinación de disciplinas (doble disciplina)</label>
          {newDisc.combo && <label className="text-xs">Máximo total de horas<input type="number" className={`${field} block w-20`} value={newDisc.maxTotal} onChange={e => setNewDisc({ ...newDisc, maxTotal: e.target.value })} /></label>}
        </div>
        {newDisc.combo && <p className="text-xs text-slate-500">Las filas son las horas TOTALES de la combinación. Al asignarla se escogen las disciplinas y las horas de cada una.</p>}
        <p className="text-xs text-slate-500">Deja el precio vacío para que tome el de la <b>Tabla de precios</b> según las horas. Para Equipo o Pre-Equipo: agrégalos primero como renglón de texto en la Tabla de precios,
          luego crea la disciplina con ese mismo nombre y quita todas las filas de horas (o agrega la opción con ese nombre y sin horas).</p>
        <table className="text-sm"><thead className="text-left text-xs text-slate-500"><tr><th className="pr-3">{newDisc.combo ? 'Horas totales por semana' : 'Horas por semana'}</th><th>Precio mensual</th></tr></thead>
          <tbody>{newDisc.rows.map((r, i) => <tr key={i}>
            <td className="py-1 pr-3"><input type="number" step="0.5" min={0.5} className={`${field} w-24`} value={r.hours} onChange={e => setNewDisc({ ...newDisc, rows: newDisc.rows.map((x, j) => j === i ? { ...x, hours: e.target.value } : x) })} /></td>
            <td className="py-1"><input className={`${field} w-28`} placeholder="de la tabla" value={r.price} onChange={e => setNewDisc({ ...newDisc, rows: newDisc.rows.map((x, j) => j === i ? { ...x, price: e.target.value } : x) })} /></td>
            <td className="pl-2"><button className="text-xs text-red-600" onClick={() => setNewDisc({ ...newDisc, rows: newDisc.rows.filter((_, j) => j !== i) })}>Quitar</button></td></tr>)}</tbody></table>
        <button className="text-xs text-brand" onClick={() => setNewDisc({ ...newDisc, rows: [...newDisc.rows, { hours: '', price: '' }] })}>+ Otra opción de horas</button>
        <div className="flex gap-2"><button disabled={!newDisc.name.trim()} className={btn} onClick={saveDisc}>Guardar disciplina</button><button className="text-slate-500" onClick={() => setNewDisc(null)}>Cancelar</button></div>
      </div>}

      {disciplines.map(d => <Discipline key={d} d={d} list={plans.filter(p => p.discipline === d)} canCfg={canCfg} labels={labels}
        rule={rules.find(r => r.discipline === d)} hasCombo={rules.some(r => r.is_combo)} onRule={v => saveRule(d, v)}
        onPrice={setPrice} onPatch={patch} onHist={showHist}
        onAdd={async (h, pr, n) => { setMsg(null); const e = await addTier(d, h, pr, n); if (e) setMsg(e); else load(); }} />)}
      {!plans.length && !newDisc && <p className="rounded-xl border border-dashed bg-white p-4 text-sm text-slate-500">Aún no hay planes. Empieza con "+ Nueva disciplina".</p>}

      {hist && <div className="space-y-1 rounded-xl bg-white p-4 text-sm shadow-sm">
        <div className="flex"><b>Historial · {hist.plan.discipline} · {hist.plan.name}</b><button className="ml-auto text-slate-500" onClick={() => setHist(null)}>Cerrar</button></div>
        {hist.rows.map((h, i) => <p key={i} className="text-xs">Desde {h.effective_month.slice(0, 7)}: <b>{formatMXN(h.price_cents)}</b> <span className="text-slate-400">(capturado {h.created_at.slice(0, 10)})</span></p>)}
      </div>}
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
    </div>
  );
}

function Discipline({ d, list, canCfg, labels, rule, hasCombo, onRule, onPrice, onPatch, onHist, onAdd }: { d: string; list: Plan[]; canCfg: boolean; labels: string[];
  rule?: DiscRule; hasCombo: boolean; onRule: (v: Partial<DiscRule>) => void;
  onPrice: (p: Plan, v: string) => void; onPatch: (p: Plan, v: Partial<Plan>) => void; onHist: (p: Plan) => void; onAdd: (h: string, price: string, name: string) => void }) {
  const [row, setRow] = useState({ hours: '', price: '', name: '' });
  return (
    <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2 text-sm normal-case text-slate-800">{d}
          {rule?.is_combo
            ? <span className="ml-2 text-xs font-normal text-purple-700">combinación · máximo total {canCfg
              ? <input type="number" className="w-14 rounded border px-1" defaultValue={rule.max_total_hours} onBlur={e => +e.target.value !== Number(rule.max_total_hours) && onRule({ max_total_hours: +e.target.value })} /> : rule.max_total_hours} h</span>
            : hasCombo && <span className="ml-2 text-xs font-normal text-slate-500">en doble disciplina: de {canCfg
              ? <input type="number" step="0.5" className="w-12 rounded border px-1" defaultValue={rule?.min_hours ?? 1} onBlur={e => +e.target.value !== Number(rule?.min_hours ?? 1) && onRule({ min_hours: +e.target.value })} /> : rule?.min_hours ?? 1} a {canCfg
              ? <input type="number" step="0.5" className="w-12 rounded border px-1" defaultValue={rule?.max_hours ?? 8} onBlur={e => +e.target.value !== Number(rule?.max_hours ?? 8) && onRule({ max_hours: +e.target.value })} /> : rule?.max_hours ?? 8} h</span>}</th>
          <th className="px-3 py-2">{rule?.is_combo ? 'Horas totales' : 'Horas/sem'}</th><th className="px-3 py-2 text-right">Precio mensual</th><th className="px-3 py-2 text-right">Alumnas este mes</th><th className="px-3 py-2"></th></tr></thead>
        <tbody>{list.map(p => (
          <tr key={p.id} className={`border-t ${p.is_active ? '' : 'text-slate-400'}`}>
            <td className="px-3 py-1.5">{canCfg ? <input className="w-56 rounded border px-2 py-1" defaultValue={p.name} onBlur={e => e.target.value.trim() && e.target.value !== p.name && onPatch(p, { name: e.target.value.trim() })} /> : p.name}</td>
            <td className="px-3 py-1.5">{p.hours_per_week ?? '—'}</td>
            <td className="px-3 py-1.5 text-right">{p.use_table && (p.hours_per_week != null || p.table_label)
              ? <span>{p.price_cents != null ? formatMXN(p.price_cents) : <span className="text-red-600">no está en la tabla</span>} <span className="text-xs text-slate-400">tabla{p.table_label ? ` · ${p.table_label}` : ''}</span>
                  {canCfg && <button className="ml-2 text-xs text-brand" onClick={() => { const v = prompt('Precio propio para esta opción (deja de usar la tabla):'); if (v) onPrice(p, v); }}>precio propio</button>}</span>
              : canCfg ? <span><input key={p.price_cents ?? 'x'} className="w-28 rounded border px-2 py-1 text-right" placeholder="sin precio"
                  defaultValue={p.price_cents != null ? (p.price_cents / 100).toFixed(2) : ''} onBlur={e => onPrice(p, e.target.value)} />
                  {p.hours_per_week != null ? <button className="ml-2 text-xs text-brand" onClick={() => onPatch(p, { use_table: true })}>usar tabla</button>
                    : labels.length > 0 && <select className="ml-2 rounded border px-1 text-xs" value="" onChange={e => e.target.value && onPatch(p, { use_table: true, table_label: e.target.value })}>
                      <option value="">usar tabla…</option>{labels.map(l => <option key={l} value={l}>{l}</option>)}</select>}</span>
              : p.price_cents != null ? formatMXN(p.price_cents) : '—'}</td>
            <td className="px-3 py-1.5 text-right">{p.active_subs}</td>
            <td className="space-x-3 whitespace-nowrap px-3 py-1.5 text-right text-xs"><button className="text-brand" onClick={() => onHist(p)}>Historial</button>
              {canCfg && <button className="text-slate-500" onClick={() => onPatch(p, { is_active: !p.is_active })}>{p.is_active ? 'Desactivar' : 'Activar'}</button>}</td>
          </tr>))}
          {canCfg && <tr className="border-t bg-slate-50/60">
            <td className="px-3 py-1.5"><input className="w-56 rounded border px-2 py-1" placeholder="Nombre (opcional)" value={row.name} onChange={e => setRow({ ...row, name: e.target.value })} /></td>
            <td className="px-3 py-1.5"><input type="number" step="0.5" min={0.5} className="w-20 rounded border px-2 py-1" placeholder="horas" value={row.hours} onChange={e => setRow({ ...row, hours: e.target.value })} /></td>
            <td className="px-3 py-1.5 text-right"><input className="w-28 rounded border px-2 py-1 text-right" placeholder="de la tabla" value={row.price} onChange={e => setRow({ ...row, price: e.target.value })} /></td>
            <td colSpan={2} className="px-3 py-1.5 text-right"><button disabled={!row.hours && !row.name.trim()} className="text-sm text-brand disabled:text-slate-300"
              onClick={() => { onAdd(row.hours, row.price, row.name); setRow({ hours: '', price: '', name: '' }); }}>+ Agregar opción</button></td></tr>}
          <tr className="border-t bg-slate-50 text-xs font-semibold"><td className="px-3 py-1.5" colSpan={3}>Total {d}</td>
            <td className="px-3 py-1.5 text-right">{list.reduce((n, p) => n + Number(p.active_subs), 0)}</td><td /></tr>
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- Tabla de precios (horas y texto)
interface HP { hours: number | null; label: string | null; effective_month: string; price_cents: number | null; created_at: string }
const keyOf = (r: { hours: number | null; label: string | null }) => r.label ? `t:${r.label.toLowerCase()}` : `h:${Number(r.hours)}`;
function PriceTable({ co, canCfg }: { co: string; canCfg: boolean }) {
  const [rows, setRows] = useState<HP[]>([]); const [msg, setMsg] = useState<string | null>(null);
  const [from, setFrom] = useState(thisMonth()); const [add, setAdd] = useState({ key: '', price: '' }); const [hist, setHist] = useState<string | null>(null);
  const load = useCallback(async () => {
    const { data, error } = await supabase.from('hour_prices').select('hours,label,effective_month,price_cents,created_at').eq('company_id', co)
      .order('effective_month', { ascending: false }).order('created_at', { ascending: false });
    if (error) setMsg(error.message); setRows((data as HP[]) ?? []);
  }, [co]);
  useEffect(() => { load(); }, [load]);
  const ym = thisMonth();
  const keys: { key: string; hours: number | null; label: string | null }[] = [];
  for (const r of rows) if (!keys.some(k => k.key === keyOf(r))) keys.push({ key: keyOf(r), hours: r.hours === null ? null : Number(r.hours), label: r.label });
  keys.sort((a, b) => (a.label ? 1 : 0) - (b.label ? 1 : 0) || (a.hours ?? 0) - (b.hours ?? 0));
  const current = (k: string) => rows.find(r => keyOf(r) === k && r.effective_month.slice(0, 7) <= ym);
  const upcoming = (k: string) => rows.find(r => keyOf(r) === k && r.effective_month.slice(0, 7) > ym);
  async function save(k: { hours: number | null; label: string | null }, price: string | null) {
    setMsg(null);
    const { error } = await supabase.from('hour_prices').insert({ company_id: co, hours: k.label ? null : k.hours, label: k.label, effective_month: `${from}-01`,
      price_cents: price === null ? null : toCents(price) });
    if (error) setMsg(error.message); else load();
  }
  function addRow() {
    const v = add.key.trim().replace(',', '.'); const n = Number(v);
    save(v && !isNaN(n) && n > 0 ? { hours: n, label: null } : { hours: null, label: add.key.trim() }, add.price); setAdd({ key: '', price: '' });
  }
  const show = (k: { hours: number | null; label: string | null }) => k.label ?? (k.hours! % 1 ? `${Math.floor(k.hours!) || ''} ½`.trim() : String(k.hours));
  return (
    <div className="space-y-3">
      {canCfg && <div className="flex flex-wrap items-center gap-2 rounded-xl bg-white p-3 text-sm shadow-sm">
        <span>Los cambios aplican desde</span><input type="month" className={field} value={from} onChange={e => setFrom(e.target.value)} />
        <span className="text-xs text-slate-500">· los meses anteriores conservan su precio. Para subir precios del próximo ciclo, elige el mes en que empiezan.</span></div>}
      <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
        <table className="w-full max-w-2xl text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Horas por semana / plan</th><th className="px-3 py-2 text-right">Costo por mes</th>
            <th className="px-3 py-2">Vigente desde</th><th className="px-3 py-2"></th></tr></thead>
          <tbody>{keys.map(k => { const c = current(k.key), u = upcoming(k.key); if (!c && !u) return null; return (
            <tr key={k.key} className={`border-t ${k.label ? 'bg-purple-50/40' : ''}`}>
              <td className="px-3 py-1.5 font-medium">{show(k)}</td>
              <td className="px-3 py-1.5 text-right">{canCfg ? <input key={`${c?.price_cents}-${c?.created_at}`} className="w-28 rounded border px-2 py-1 text-right"
                defaultValue={c?.price_cents != null ? (c.price_cents / 100).toFixed(2) : ''} placeholder="—" onBlur={e => e.target.value && toCents(e.target.value) !== c?.price_cents && save(k, e.target.value)} />
                : c?.price_cents != null ? formatMXN(c.price_cents) : '—'}</td>
              <td className="px-3 py-1.5 text-xs text-slate-500">{c?.effective_month.slice(0, 7) ?? '—'}{u && <span className="ml-2 text-amber-700">→ {u.price_cents != null ? formatMXN(u.price_cents) : 'se quita'} desde {u.effective_month.slice(0, 7)}</span>}</td>
              <td className="space-x-2 px-3 py-1.5 text-right text-xs"><button className="text-brand" onClick={() => setHist(hist === k.key ? null : k.key)}>Historial</button>
                {canCfg && c?.price_cents != null && <button className="text-red-600" onClick={() => confirm(`¿Quitar "${show(k)}" desde ${from}?`) && save(k, null)}>Quitar</button>}</td>
            </tr>); })}
            {canCfg && <tr className="border-t bg-slate-50/60">
              <td className="px-3 py-1.5"><input className="w-56 rounded border px-2 py-1" placeholder="horas (3.5) o texto (Equipo)" value={add.key} onChange={e => setAdd({ ...add, key: e.target.value })} /></td>
              <td className="px-3 py-1.5 text-right"><input className="w-28 rounded border px-2 py-1 text-right" placeholder="$" value={add.price} onChange={e => setAdd({ ...add, price: e.target.value })} /></td>
              <td colSpan={2} className="px-3 py-1.5 text-right"><button disabled={!add.key.trim() || !add.price} className="text-brand disabled:text-slate-300" onClick={addRow}>+ Agregar renglón</button></td></tr>}
          </tbody>
        </table>
      </div>
      {hist !== null && <div className="rounded-xl bg-white p-3 text-xs shadow-sm"><b>{show(keys.find(k => k.key === hist)!)}</b>{rows.filter(r => keyOf(r) === hist).map((r, i) =>
        <p key={i}>Desde {r.effective_month.slice(0, 7)}: {r.price_cents != null ? formatMXN(r.price_cents) : 'se quitó'} <span className="text-slate-400">(capturado {r.created_at.slice(0, 10)})</span></p>)}</div>}
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      <p className="text-xs text-slate-500">Escribe un número para un renglón por horas o un texto para planes como Equipo, Pre-Equipo o Equipo libre en adelante.
        Los planes por horas toman su precio de aquí sin importar la disciplina; los planes de texto se ligan en Planes por disciplina con "usar tabla".
        Hermanos (15 %), pronto pago (5 %) y recargos se calculan sobre este precio normal; se ajustan en Reglas.</p>
    </div>
  );
}

// ---------------------------------------------------------------- Grupos
interface G { id: string; activity: string; start_time: string; end_time: string; capacity: number | null; discipline: string | null; is_active: boolean }
function Groups({ co, canCfg }: { co: string; canCfg: boolean }) {
  const [groups, setGroups] = useState<G[]>([]); const [taken, setTaken] = useState<Record<string, number>>({});
  const [discs, setDiscs] = useState<string[]>([]);
  useEffect(() => {
    Promise.all([supabase.from('plans').select('discipline').eq('company_id', co).eq('is_active', true),
      supabase.from('discipline_rules').select('discipline,is_combo').eq('company_id', co).eq('is_combo', true)]).then(([p, r]) => {
      const combo = new Set((r.data ?? []).map(x => x.discipline));
      setDiscs([...new Set((p.data ?? []).map(x => x.discipline as string))].filter(d => !combo.has(d)).sort());
    });
  }, [co]);
  const discOptions = (cur: string | null) => [...new Set([...discs, ...(cur ? [cur] : [])])];
  const [msg, setMsg] = useState<string | null>(null); const [form, setForm] = useState({ activity: '', start: '16:00', end: '17:00', capacity: '', discipline: '' });
  const load = useCallback(async () => {
    const { data, error } = await supabase.from('class_groups').select('id,activity,start_time,end_time,capacity,discipline,is_active').eq('company_id', co).order('activity').order('start_time');
    if (error) return setMsg(error.message);
    const gs = (data as G[]) ?? []; setGroups(gs);
    const m = `${thisMonth()}-01`;
    const counts = await Promise.all(gs.map(g => supabase.rpc('group_taken', { p_class: g.id, p_month: m })));
    setTaken(Object.fromEntries(gs.map((g, i) => [g.id, (counts[i].data as number) ?? 0])));
  }, [co]);
  useEffect(() => { load(); }, [load]);
  async function patch(g: G, p: Partial<G>) { const { error } = await supabase.from('class_groups').update(p).eq('id', g.id); if (error) setMsg(error.message); else load(); }
  async function add(ev: React.FormEvent) {
    ev.preventDefault(); setMsg(null);
    const { error } = await supabase.from('class_groups').insert({ company_id: co, activity: form.activity.trim(), start_time: form.start, end_time: form.end,
      capacity: form.capacity ? +form.capacity : null, discipline: form.discipline.trim() || null });
    if (error) return setMsg(error.message.includes('unique') ? 'Ya existe un grupo con ese nombre y hora.' : error.message);
    setForm({ ...form, activity: '' }); load();
  }
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Grupo</th><th className="px-3 py-2">Disciplina</th>
            <th className="px-3 py-2">Horario</th><th className="px-3 py-2">Ocupados este mes</th><th className="px-3 py-2">Cupo</th><th className="px-3 py-2">Activo</th></tr></thead>
          <tbody>{groups.map(g => { const t = taken[g.id] ?? 0; const full = g.capacity !== null && t >= g.capacity; return (
            <tr key={g.id} className="border-t">
              <td className="px-3 py-2 font-medium">{g.activity}</td>
              <td className="px-3 py-2">{canCfg ? <select className="rounded border px-2 py-1" value={g.discipline ?? ''} onChange={e => patch(g, { discipline: e.target.value || null })}>
                <option value="">— sin disciplina —</option>{discOptions(g.discipline).map(d => <option key={d} value={d}>{d}</option>)}</select> : g.discipline ?? '—'}</td>
              <td className="px-3 py-2">{g.start_time}–{g.end_time}</td>
              <td className={`px-3 py-2 ${full ? 'font-semibold text-red-700' : ''}`}>{t}{g.capacity ? ` de ${g.capacity}` : ''}{full ? ' · lleno' : ''}</td>
              <td className="px-3 py-2">{canCfg ? <input type="number" min={1} className="w-20 rounded border px-2 py-1" defaultValue={g.capacity ?? ''} placeholder="sin límite"
                onBlur={e => (e.target.value ? +e.target.value : null) !== g.capacity && patch(g, { capacity: e.target.value ? +e.target.value : null })} /> : g.capacity ?? 'sin límite'}</td>
              <td className="px-3 py-2"><input type="checkbox" disabled={!canCfg} checked={g.is_active} onChange={e => patch(g, { is_active: e.target.checked })} /></td>
            </tr>); })}</tbody>
        </table>
      </div>
      {canCfg && <form onSubmit={add} className="flex flex-wrap items-end gap-2 rounded-xl bg-white p-4 shadow-sm">
        <label className="text-xs">Nuevo grupo<input required className={`${field} block w-44`} placeholder="Baby Gym 3" value={form.activity} onChange={e => setForm({ ...form, activity: e.target.value })} /></label>
        <label className="text-xs">Disciplina<select className={`${field} block`} value={form.discipline} onChange={e => setForm({ ...form, discipline: e.target.value })}>
          <option value="">— elige —</option>{discs.map(d => <option key={d} value={d}>{d}</option>)}</select></label>
        <label className="text-xs">Inicio<input type="time" className={`${field} block`} value={form.start} onChange={e => setForm({ ...form, start: e.target.value })} /></label>
        <label className="text-xs">Fin<input type="time" className={`${field} block`} value={form.end} onChange={e => setForm({ ...form, end: e.target.value })} /></label>
        <label className="text-xs">Cupo<input type="number" min={1} className={`${field} block w-20`} value={form.capacity} onChange={e => setForm({ ...form, capacity: e.target.value })} /></label>
        <button className={btn}>Agregar grupo</button>
      </form>}
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      <p className="text-xs text-slate-500">Las disciplinas salen de Planes por disciplina; si falta una, créala ahí primero. Los grupos que vienen de EVO aparecen aquí solos. El cupo cuenta a las alumnas con plan asignado en ese grupo; si está lleno, no deja asignar a otra hasta que subas el cupo.</p>
    </div>
  );
}

// ---------------------------------------------------------------- Productos
interface Prod { id: string; category: string; name: string; price_cents: number; is_active: boolean }
function Products({ co, canCfg }: { co: string; canCfg: boolean }) {
  const [rows, setRows] = useState<Prod[]>([]); const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState({ category: 'indumentaria', name: '', price: '' });
  const load = useCallback(async () => {
    const { data, error } = await supabase.from('products').select('id,category,name,price_cents,is_active').eq('company_id', co).order('category').order('name');
    if (error) setMsg(error.message); setRows((data as Prod[]) ?? []);
  }, [co]);
  useEffect(() => { load(); }, [load]);
  async function add(ev: React.FormEvent) {
    ev.preventDefault(); setMsg(null);
    const { error } = await supabase.from('products').insert({ company_id: co, category: form.category, name: form.name.trim(), price_cents: toCents(form.price) });
    if (error) return setMsg(error.message.includes('unique') ? 'Ya existe un producto con ese nombre.' : error.message);
    setForm({ ...form, name: '', price: '' }); load();
  }
  async function patch(p: Prod, v: Partial<Prod>) { const { error } = await supabase.from('products').update(v).eq('id', p.id); if (error) setMsg(error.message); else load(); }
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Producto</th><th className="px-3 py-2">Categoría</th><th className="px-3 py-2 text-right">Precio</th><th className="px-3 py-2">Activo</th></tr></thead>
          <tbody>{rows.map(p => (
            <tr key={p.id} className={`border-t ${p.is_active ? '' : 'text-slate-400'}`}>
              <td className="px-3 py-2 font-medium">{p.name}</td><td className="px-3 py-2">{CATS[p.category]}</td>
              <td className="px-3 py-2 text-right">{canCfg ? <input className="w-24 rounded border px-2 py-1 text-right" defaultValue={(p.price_cents / 100).toFixed(2)}
                onBlur={e => toCents(e.target.value) !== p.price_cents && patch(p, { price_cents: toCents(e.target.value) })} /> : formatMXN(p.price_cents)}</td>
              <td className="px-3 py-2"><input type="checkbox" disabled={!canCfg} checked={p.is_active} onChange={e => patch(p, { is_active: e.target.checked })} /></td>
            </tr>))}
            {!rows.length && <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-400">Sin productos.</td></tr>}</tbody>
        </table>
      </div>
      {canCfg && <form onSubmit={add} className="flex flex-wrap items-end gap-2 rounded-xl bg-white p-4 shadow-sm">
        <label className="text-xs">Categoría<select className={`${field} block`} value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
          {Object.entries(CATS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="text-xs">Producto<input required className={`${field} block w-60`} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Leotardo A Brillo Talla 10" /></label>
        <label className="text-xs">Precio<input required className={`${field} block w-28`} value={form.price} onChange={e => setForm({ ...form, price: e.target.value })} /></label>
        <button className={btn}>Agregar</button>
      </form>}
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- Reglas, anualidad, formas de pago
interface Rules { early_bps: number; sibling_bps: number; prepay_bps: number; due_day: number; surcharge1_day: number; surcharge1_bps: number; surcharge2_day: number; surcharge2_bps: number }
function Rules({ co, canCfg }: { co: string; canCfg: boolean }) {
  const [r, setR] = useState<Rules | null>(null); const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [fees, setFees] = useState<{ id: string; year: number; amount_cents: number }[]>([]); const [fee, setFee] = useState({ year: String(new Date().getFullYear() + 1), amount: '' });
  const [methods, setMethods] = useState<{ id: string; name: string; kind: string; is_active: boolean }[]>([]); const [m, setM] = useState({ name: '', kind: 'transferencia' });
  const load = useCallback(async () => {
    const [a, b, c] = await Promise.all([
      supabase.from('billing_rules').select('*').eq('company_id', co).maybeSingle(),
      supabase.from('annual_fees').select('id,year,amount_cents').eq('company_id', co).order('year', { ascending: false }),
      supabase.from('payment_methods').select('id,name,kind,is_active').order('sort').order('name')]);
    setR((a.data as Rules) ?? { early_bps: 500, sibling_bps: 1500, prepay_bps: 1500, due_day: 5, surcharge1_day: 6, surcharge1_bps: 500, surcharge2_day: 11, surcharge2_bps: 1000 });
    setFees(b.data ?? []); setMethods(c.data ?? []);
  }, [co]);
  useEffect(() => { load(); }, [load]);
  async function saveRules() {
    if (!r) return; setMsg(null);
    const { error } = await supabase.from('billing_rules').upsert({ company_id: co, ...r, updated_at: new Date().toISOString() });
    setMsg(error ? { ok: false, t: error.message } : { ok: true, t: 'Reglas guardadas.' });
  }
  async function saveFee() {
    const ex = fees.find(f => f.year === +fee.year);
    const { error } = ex ? await supabase.from('annual_fees').update({ amount_cents: toCents(fee.amount) }).eq('id', ex.id)
      : await supabase.from('annual_fees').insert({ company_id: co, year: +fee.year, amount_cents: toCents(fee.amount) });
    if (error) setMsg({ ok: false, t: error.message }); else { setFee({ ...fee, amount: '' }); load(); }
  }
  async function addMethod() {
    const { error } = await supabase.from('payment_methods').insert({ name: m.name.trim(), kind: m.kind, sort: methods.length + 1 });
    if (error) setMsg({ ok: false, t: error.message.includes('unique') ? 'Ya existe esa forma de pago.' : error.message }); else { setM({ ...m, name: '' }); load(); }
  }
  async function toggleMethod(id: string, is_active: boolean) { const { error } = await supabase.from('payment_methods').update({ is_active }).eq('id', id); if (error) setMsg({ ok: false, t: error.message }); else load(); }
  if (!r) return null;
  const pctIn = (k: keyof Rules) => <input type="number" step="0.5" min={0} max={100} disabled={!canCfg} className="w-16 rounded border px-2 py-1"
    value={r[k] / 100} onChange={e => setR({ ...r, [k]: Math.round(+e.target.value * 100) })} />;
  const dayIn = (k: keyof Rules) => <input type="number" min={1} max={31} disabled={!canCfg} className="w-16 rounded border px-2 py-1" value={r[k]} onChange={e => setR({ ...r, [k]: +e.target.value })} />;
  return (
    <div className="space-y-4">
      <section className="space-y-2 rounded-xl bg-white p-4 text-sm shadow-sm">
        <h3 className="font-semibold">Reglas de cobro de mensualidades</h3>
        <p>Pronto pago (pagado antes del día 1 del mes): {pctIn('early_bps')} % de descuento</p>
        <p>Del día 1 al día {dayIn('due_day')}: precio normal</p>
        <p>Desde el día {dayIn('surcharge1_day')}: {pctIn('surcharge1_bps')} % de recargo · desde el día {dayIn('surcharge2_day')}: {pctIn('surcharge2_bps')} % de recargo</p>
        <p>Hermanos (plan familiar): se suman los planes de las hermanas; {pctIn('sibling_bps')} % al plan más barato (con 3 o más, a todas menos la del plan más caro) y el pronto pago sólo al más caro. Cuenta entre sucursales.</p>
        <p>Pago por adelantado: {pctIn('prepay_bps')} % de descuento sugerido (se puede ajustar en cada pago) y el precio queda congelado esos meses.</p>
        <p className="text-xs text-slate-500">Quien tiene beca no lleva ningún otro descuento (ni hermanos, ni pronto pago, ni adelanto). Si paga ya con recargo (desde el primer día de recargo), ese mes pierde la beca: se cobra el plan completo más el recargo.</p>
        {canCfg && <button className={btn} onClick={saveRules}>Guardar reglas</button>}
      </section>
      <section className="space-y-2 rounded-xl bg-white p-4 text-sm shadow-sm">
        <h3 className="font-semibold">Anualidad</h3>
        {fees.map(f => <p key={f.id}>{f.year}: <b>{formatMXN(f.amount_cents)}</b></p>)}
        {!fees.length && <p className="text-slate-500">Sin anualidad capturada.</p>}
        {canCfg && <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs">Año<input type="number" className={`${field} block w-24`} value={fee.year} onChange={e => setFee({ ...fee, year: e.target.value })} /></label>
          <label className="text-xs">Monto<input className={`${field} block w-28`} placeholder="1560" value={fee.amount} onChange={e => setFee({ ...fee, amount: e.target.value })} /></label>
          <button disabled={!fee.amount} className={btn} onClick={saveFee}>Guardar</button></div>}
      </section>
      <section className="space-y-2 rounded-xl bg-white p-4 text-sm shadow-sm">
        <h3 className="font-semibold">Formas de pago <span className="font-normal text-slate-500">(para todas las sucursales)</span></h3>
        {methods.map(x => <label key={x.id} className="mr-4 inline-flex items-center gap-1"><input type="checkbox" disabled={!canCfg} checked={x.is_active} onChange={e => toggleMethod(x.id, e.target.checked)} />{x.name} <span className="text-xs text-slate-400">({x.kind})</span></label>)}
        {canCfg && <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs">Nueva<input className={`${field} block w-44`} placeholder="Mercado Pago" value={m.name} onChange={e => setM({ ...m, name: e.target.value })} /></label>
          <label className="text-xs">Tipo<select className={`${field} block`} value={m.kind} onChange={e => setM({ ...m, kind: e.target.value })}>
            <option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option><option value="tarjeta">Tarjeta</option><option value="otro">Otro</option></select></label>
          <button disabled={!m.name.trim()} className={btn} onClick={addMethod}>Agregar</button></div>}
      </section>
      {msg && <p className={`rounded p-2 text-sm ${msg.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>{msg.t}</p>}
    </div>
  );
}
