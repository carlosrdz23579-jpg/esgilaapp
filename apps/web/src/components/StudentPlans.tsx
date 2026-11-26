import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { formatMXN } from '../lib/money';
import { toCents, thisMonth, type Plan, type DiscRule } from './Billing';
import { monthlyCharge, siblingTargets, prepayQuote, checkCombo, DEFAULT_RULES, type BillingRules } from '@domain/billing';

const field = 'rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand';
const btn = 'rounded-lg bg-brand px-3 py-1.5 text-sm text-white disabled:opacity-50';
const WD = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const addMonth = (ym: string, n: number) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + n, 1)).toISOString().slice(0, 7);
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const ml = (d: string) => `${MONTHS[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;

interface Stu { id: string; company_id: string; full_name: string; family_id?: string | null }
interface Sub { id: string; company_id: string; plan_id: string; student_id: string | null; family_id: string | null; start_month: string; end_month: string | null;
  replaces_id: string | null; cancelled_at: string | null; created_at: string }
interface Mem { id: string; subscription_id: string; student_id: string; class_id: string | null; weekdays: number[]; discipline: string | null; hours: number | null }
interface Adj { id: string; subscription_id: string; kind: string; label: string; mode: 'pct' | 'monto'; value: number; from_month: string; to_month: string | null; cancelled_at: string | null }
interface Grp { id: string; activity: string; start_time: string; end_time: string; capacity: number | null; is_active: boolean; discipline: string | null }

/** Plan(es), familia y becas de una alumna — va dentro de su ficha. */
export default function StudentPlans({ s, onChanged }: { s: Stu; onChanged?: () => void }) {
  const { can } = useAuth();
  const canEdit = can('billing', 'edit'), canSee = canEdit || can('billing') || can('billing', 'configure');
  const [stu, setStu] = useState<Stu>(s);
  const [plans, setPlans] = useState<Plan[]>([]); const [groups, setGroups] = useState<Grp[]>([]); const [drules, setDrules] = useState<DiscRule[]>([]);
  const [subs, setSubs] = useState<Sub[]>([]); const [mems, setMems] = useState<Mem[]>([]); const [adjs, setAdjs] = useState<Adj[]>([]);
  const [family, setFamily] = useState<{ id: string; name: string } | null>(null); const [siblings, setSiblings] = useState<Stu[]>([]);
  const [msg, setMsg] = useState<string | null>(null); const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const st = await supabase.from('students').select('id,company_id,full_name,family_id').eq('id', s.id).single();
    const me = (st.data as Stu) ?? s; setStu(me);
    const [p, g, m1, dr] = await Promise.all([
      supabase.from('plans_v').select('*').eq('company_id', s.company_id).eq('is_active', true).order('discipline').order('sort'),
      supabase.from('class_groups').select('id,activity,start_time,end_time,capacity,is_active,discipline').eq('company_id', s.company_id).eq('is_active', true).order('activity').order('start_time'),
      supabase.from('subscription_members').select('*').eq('student_id', s.id),
      supabase.from('discipline_rules').select('*').eq('company_id', s.company_id)]);
    setPlans((p.data as Plan[]) ?? []); setGroups((g.data as Grp[]) ?? []); setDrules((dr.data as DiscRule[]) ?? []);
    const memberSubIds = ((m1.data as Mem[]) ?? []).map(x => x.subscription_id);
    let q = supabase.from('subscriptions').select('*').is('cancelled_at', null).order('start_month', { ascending: false });
    q = me.family_id ? q.or(`student_id.eq.${s.id},family_id.eq.${me.family_id}${memberSubIds.length ? `,id.in.(${memberSubIds.join(',')})` : ''}`)
      : q.or(`student_id.eq.${s.id}${memberSubIds.length ? `,id.in.(${memberSubIds.join(',')})` : ''}`);
    const r = await q; const ss = (r.data as Sub[]) ?? []; setSubs(ss);
    const ids = ss.map(x => x.id);
    const [m, a] = ids.length ? await Promise.all([
      supabase.from('subscription_members').select('*').in('subscription_id', ids),
      supabase.from('subscription_adjustments').select('*').in('subscription_id', ids).is('cancelled_at', null).order('from_month', { ascending: false })])
      : [{ data: [] }, { data: [] }];
    setMems((m.data as Mem[]) ?? []); setAdjs((a.data as Adj[]) ?? []);
    if (me.family_id) {
      const [f, sib] = await Promise.all([supabase.from('families').select('id,name').eq('id', me.family_id).single(),
        supabase.from('students').select('id,company_id,full_name,family_id').eq('family_id', me.family_id).neq('id', s.id)]);
      setFamily(f.data ?? null); setSiblings((sib.data as Stu[]) ?? []);
    } else { setFamily(null); setSiblings([]); }
  }, [s]);
  useEffect(() => { load(); }, [load]);

  if (!canSee) return null;
  const month = thisMonth();
  const active = (x: Sub, ym = month) => x.start_month.slice(0, 7) <= ym && (!x.end_month || x.end_month.slice(0, 7) >= ym);
  const plan = (id: string) => plans.find(p => p.id === id);
  const grp = (id: string | null) => groups.find(g => g.id === id);
  const done = () => { load(); onChanged?.(); };

  async function end(x: Sub) {
    const m = prompt('¿Último mes que cubre este plan? (AAAA-MM)', month); if (!m || !/^\d{4}-\d{2}$/.test(m)) return;
    const { error } = await supabase.from('subscriptions').update({ end_month: `${m}-01` }).eq('id', x.id); if (error) setMsg(error.message); else done();
  }
  async function cancel(x: Sub) {
    if (!confirm('¿Cancelar este plan porque se capturó por error? No contará para nada (queda en el historial).')) return;
    const { error } = await supabase.from('subscriptions').update({ cancelled_at: new Date().toISOString() }).eq('id', x.id); if (error) setMsg(error.message); else done();
  }

  const current = subs.filter(x => active(x) || x.start_month.slice(0, 7) > month);
  const past = subs.filter(x => !current.includes(x));
  return (
    <div className="space-y-3 border-t pt-3">
      <div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-semibold">Plan</h4>
        {canEdit && !adding && <button className="ml-auto text-sm text-brand" onClick={() => setAdding(true)}>+ Asignar plan</button>}</div>
      <FamilyBox stu={stu} family={family} siblings={siblings} canEdit={canEdit} onChanged={done} />
      {family && siblings.length > 0 && <FamilySummary stu={stu} siblings={siblings} />}
      {current.map(x => {
        const p = plan(x.plan_id); const ms = mems.filter(m => m.subscription_id === x.id);
        return (
          <div key={x.id} className="space-y-1 rounded-lg border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <b>{p ? `${p.discipline} · ${p.name}` : 'Plan'}</b>
              {p?.kind === 'familiar' && <span className="rounded-full bg-purple-100 px-2 text-xs text-purple-700">familiar</span>}
              {p?.price_cents != null && <span>{formatMXN(p.price_cents)}/mes</span>}
              <span className="text-xs text-slate-500">desde {ml(x.start_month)}{x.end_month ? ` hasta ${ml(x.end_month)}` : ''}{x.replaces_id ? ' · cambio de plan' : ''}</span>
              {canEdit && <span className="ml-auto space-x-3 text-xs"><button className="text-slate-600" onClick={() => end(x)}>Terminar</button><button className="text-red-600" onClick={() => cancel(x)}>Cancelar</button></span>}
            </div>
            {ms.map(m => <p key={m.id} className="text-xs text-slate-600">{m.student_id === s.id ? '' : `${siblings.find(z => z.id === m.student_id)?.full_name ?? 'Integrante'}: `}{m.discipline ? `${m.discipline} ${m.hours} h · ` : ''}
              {grp(m.class_id) ? `${grp(m.class_id)!.activity} ${grp(m.class_id)!.start_time}` : 'sin grupo'}{m.weekdays.length ? ` · ${m.weekdays.map(w => WD[w]).join(', ')}` : ''}</p>)}
            <Adjustments sub={x} adjs={adjs.filter(a => a.subscription_id === x.id)} canEdit={canEdit} onChanged={done} />
            <Prepayments sub={x} price={p?.price_cents ?? null} hasBeca={adjs.some(a => a.subscription_id === x.id && a.kind === 'beca')} canEdit={canEdit} onChanged={done} />
          </div>);
      })}
      {!current.length && !adding && <p className="text-sm text-slate-400">Sin plan asignado.</p>}
      {adding && <AssignPlan s={stu} family={family} plans={plans} groups={groups} subs={subs} drules={drules} onCancel={() => setAdding(false)} onDone={() => { setAdding(false); done(); }} />}
      {past.length > 0 && <details className="text-xs text-slate-500"><summary className="cursor-pointer">Planes anteriores ({past.length})</summary>
        {past.map(x => <p key={x.id}>{plan(x.plan_id)?.discipline} · {plan(x.plan_id)?.name ?? 'plan inactivo'} — {ml(x.start_month)} a {x.end_month ? ml(x.end_month) : '…'}</p>)}</details>}
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- Familia
function FamilyBox({ stu, family, siblings, canEdit, onChanged }: { stu: Stu; family: { id: string; name: string } | null; siblings: Stu[]; canEdit: boolean; onChanged: () => void }) {
  const { companies } = useAuth();
  const [open, setOpen] = useState(false); const [q, setQ] = useState(''); const [found, setFound] = useState<{ id: string; name: string }[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!open || q.trim().length < 2) return setFound([]);
    supabase.from('families').select('id,name').ilike('name', `%${q.trim()}%`).limit(8).then(r => setFound(r.data ?? []));
  }, [q, open]);
  async function link(id: string | null) {
    const { error } = await supabase.from('students').update({ family_id: id }).eq('id', stu.id);
    if (error) return setMsg(error.message); setOpen(false); onChanged();
  }
  async function create() {
    const { data, error } = await supabase.from('families').insert({ name: q.trim() }).select('id').single();
    if (error) return setMsg(error.message); link(data.id);
  }
  const co = (id: string) => companies.find(c => c.id === id)?.trade_name;
  return (
    <div className="text-sm">
      {family ? <p><span className="text-slate-500">Familia:</span> <b>{family.name}</b>
        {siblings.length > 0 && <span className="text-slate-600"> · hermanas: {siblings.map(x => `${x.full_name}${x.company_id !== stu.company_id ? ` (${co(x.company_id)})` : ''}`).join(', ')}</span>}
        {canEdit && <><button className="ml-2 text-xs text-brand" onClick={() => setOpen(!open)}>Cambiar</button><button className="ml-2 text-xs text-red-600" onClick={() => link(null)}>Quitar de la familia</button></>}</p>
        : canEdit ? <button className="text-xs text-brand" onClick={() => setOpen(!open)}>+ Ligar a una familia (para descuento de hermanos o plan familiar)</button> : null}
      {open && <div className="mt-2 space-y-1 rounded-lg border p-2">
        <input className={`${field} w-full`} autoFocus placeholder="Busca o escribe el nombre de la familia (ej. Familia Ruiz Arellano)" value={q} onChange={e => setQ(e.target.value)} />
        {found.map(f => <button key={f.id} className="block text-left text-sm text-brand" onClick={() => link(f.id)}>Ligar a {f.name}</button>)}
        {q.trim().length >= 2 && !found.some(f => f.name.toLowerCase() === q.trim().toLowerCase()) && <button className="text-sm text-brand" onClick={create}>+ Crear "{q.trim()}"</button>}
        <p className="text-xs text-slate-500">Las familias valen para las dos sucursales: el descuento de hermanos cuenta aunque una esté en CAR y otra en Viñedos.</p>
      </div>}
      {msg && <p className="text-xs text-red-700">{msg}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- Asignar plan (con cambio de plan)
function AssignPlan({ s, family, plans, groups, subs, drules, onCancel, onDone }: { s: Stu; family: { id: string } | null; plans: Plan[]; groups: Grp[]; subs: Sub[];
  drules: DiscRule[]; onCancel: () => void; onDone: () => void }) {
  const [disc, setDisc] = useState(''); const [planId, setPlanId] = useState(''); const [from, setFrom] = useState(thisMonth()); const [classId, setClassId] = useState('');
  const [days, setDays] = useState<number[]>([]); const [taken, setTaken] = useState<Record<string, number>>({});
  const [ask, setAsk] = useState<Sub | null>(null); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const combo = drules.find(r => r.discipline === disc && r.is_combo);
  const [parts, setParts] = useState<{ discipline: string; hours: string; classId: string; days: number[] }[]>([
    { discipline: '', hours: '', classId: '', days: [] }, { discipline: '', hours: '', classId: '', days: [] }]);
  const total = parts.reduce((n, x) => n + (+x.hours || 0), 0);
  const comboErrs = combo ? checkCombo(parts.map(x => ({ discipline: x.discipline, hours: +x.hours })), {
    maxTotal: Number(combo.max_total_hours), minTotal: combo.min_total_hours ? Number(combo.min_total_hours) : undefined,
    perDiscipline: Object.fromEntries(drules.filter(r => !r.is_combo).map(r => [r.discipline, { min: Number(r.min_hours), max: Number(r.max_hours) }])) }) : [];
  const comboPlan = combo ? plans.find(x => x.discipline === disc && Number(x.hours_per_week) === total && x.is_active) : undefined;
  const p = combo ? comboPlan : plans.find(x => x.id === planId);
  useEffect(() => {
    Promise.all(groups.map(g => supabase.rpc('group_taken', { p_class: g.id, p_month: `${from}-01` })))
      .then(rs => setTaken(Object.fromEntries(groups.map((g, i) => [g.id, (rs[i].data as number) ?? 0]))));
  }, [groups, from]);
  // plan individual que ya tiene en ese mes → preguntar si es cambio
  const clash = subs.find(x => x.student_id === s.id && x.start_month.slice(0, 7) <= from && (!x.end_month || x.end_month.slice(0, 7) >= from));

  async function save(mode: 'cambio' | 'agregar' | null) {
    if (!p) return;
    if (p.kind === 'individual' && clash && mode === null) return setAsk(clash);
    setBusy(true); setMsg(null);
    if (p.kind === 'familiar' && !family) { setBusy(false); return setMsg('Para un plan familiar, primero liga a la alumna a una familia.'); }
    const { data, error } = await supabase.from('subscriptions').insert({ company_id: s.company_id, plan_id: p.id, start_month: `${from}-01`,
      ...(p.kind === 'familiar' ? { family_id: family!.id } : { student_id: s.id }), replaces_id: mode === 'cambio' ? clash!.id : null }).select('id').single();
    if (error) { setBusy(false); return setMsg(error.message); }
    const m = combo
      ? await supabase.from('subscription_members').insert(parts.map(x => ({ subscription_id: data.id, student_id: s.id, class_id: x.classId || null, weekdays: x.days, discipline: x.discipline, hours: +x.hours })))
      : await supabase.from('subscription_members').insert({ subscription_id: data.id, student_id: s.id, class_id: classId || null, weekdays: days });
    if (m.error) { await supabase.from('subscriptions').update({ cancelled_at: new Date().toISOString() }).eq('id', data.id); setBusy(false); return setMsg(m.error.message); }
    if (mode === 'cambio' && clash) {
      // el anterior cubre hasta el mes previo; si empezó este mismo mes, convive ese mes y se cobra sólo la diferencia
      const endM = clash.start_month.slice(0, 7) < from ? `${addMonth(from, -1)}-01` : `${from}-01`;
      const e = await supabase.from('subscriptions').update({ end_month: endM }).eq('id', clash.id);
      if (e.error) { setBusy(false); return setMsg(e.error.message); }
    }
    setBusy(false); onDone();
  }
  const disciplines = [...new Set(plans.filter(x => x.kind !== 'familiar').map(x => x.discipline))];
  return (
    <div className="space-y-2 rounded-lg border-2 border-brand/30 p-3 text-sm">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">Disciplina<select className={`${field} block`} value={disc} onChange={e => { setDisc(e.target.value); setPlanId(''); setClassId(''); }}>
          <option value="">Elige…</option>{disciplines.map(d => <option key={d} value={d}>{d}</option>)}</select></label>
        {!combo && <label className="text-xs">Plan<select className={`${field} block`} disabled={!disc} value={planId} onChange={e => setPlanId(e.target.value)}>
          <option value="">Elige…</option>{plans.filter(x => x.discipline === disc && x.kind !== 'familiar').map(x =>
            <option key={x.id} value={x.id}>{x.name} · {x.price_cents != null ? formatMXN(x.price_cents) : 'sin precio'}</option>)}</select></label>}
        <label className="text-xs">Desde<input type="month" className={`${field} block`} value={from} onChange={e => setFrom(e.target.value)} /></label>
        {!combo && <label className="text-xs">Grupo<select className={`${field} block`} value={classId} onChange={e => setClassId(e.target.value)}>
          <option value="">Sin grupo por ahora</option>{groups.filter(g => !disc || !groups.some(x => x.discipline === disc) || g.discipline === disc).map(g => { const t = taken[g.id] ?? 0; const full = g.capacity !== null && t >= g.capacity;
            return <option key={g.id} value={g.id} disabled={full}>{g.activity} {g.start_time}–{g.end_time} · {t}{g.capacity ? `/${g.capacity}` : ''}{full ? ' · lleno' : ''}</option>; })}</select></label>}
      </div>
      {!combo && <div className="flex flex-wrap items-center gap-2 text-xs"><span className="text-slate-500">Días que viene:</span>
        {[1, 2, 3, 4, 5, 6, 0].map(d => <label key={d} className="flex items-center gap-1"><input type="checkbox" checked={days.includes(d)}
          onChange={e => setDays(e.target.checked ? [...days, d].sort() : days.filter(x => x !== d))} />{WD[d]}</label>)}</div>}
      {combo && <div className="space-y-2 rounded-lg bg-purple-50 p-2 text-xs">
        {parts.map((x, i) => { const set = (v: Partial<typeof x>) => setParts(parts.map((y, j) => j === i ? { ...y, ...v } : y));
          return <div key={i} className="flex flex-wrap items-end gap-2">
            <label>Disciplina {i + 1}<select className={`${field} block`} value={x.discipline} onChange={e => set({ discipline: e.target.value, classId: '' })}>
              <option value="">Elige…</option>{[...new Set(plans.map(z => z.discipline))].filter(d => !drules.some(r => r.discipline === d && r.is_combo)).map(d => <option key={d} value={d}>{d}</option>)}</select></label>
            <label>Horas<input type="number" step="0.5" min={0.5} className={`${field} block w-20`} value={x.hours} onChange={e => set({ hours: e.target.value })} /></label>
            <label>Grupo<select className={`${field} block`} value={x.classId} onChange={e => set({ classId: e.target.value })}><option value="">Sin grupo</option>
              {groups.filter(g => !x.discipline || !groups.some(z => z.discipline === x.discipline) || g.discipline === x.discipline).map(g => { const t = taken[g.id] ?? 0; const full = g.capacity !== null && t >= g.capacity;
                return <option key={g.id} value={g.id} disabled={full}>{g.activity} {g.start_time} · {t}{g.capacity ? `/${g.capacity}` : ''}</option>; })}</select></label>
            <span className="flex gap-1 pb-2">{[1, 2, 3, 4, 5, 6, 0].map(d => <label key={d} className="flex items-center"><input type="checkbox" checked={x.days.includes(d)}
              onChange={e => set({ days: e.target.checked ? [...x.days, d].sort() : x.days.filter(z => z !== d) })} />{WD[d]}</label>)}</span>
            {parts.length > 2 && <button className="pb-2 text-red-600" onClick={() => setParts(parts.filter((_, j) => j !== i))}>Quitar</button>}
          </div>; })}
        <button className="text-brand" onClick={() => setParts([...parts, { discipline: '', hours: '', classId: '', days: [] }])}>+ Otra disciplina</button>
        <p>Total: <b>{total} h</b> de máximo {Number(combo.max_total_hours)} h{comboPlan ? <> · plan <b>{comboPlan.name}</b> · {comboPlan.price_cents != null ? formatMXN(comboPlan.price_cents) : 'sin precio'}</>
          : total > 0 && <span className="text-red-700"> · no hay plan de {disc} de {total} h en el catálogo</span>}</p>
        {comboErrs.length > 0 && <ul className="list-disc pl-4 text-red-700">{comboErrs.map(e => <li key={e}>{e}</li>)}</ul>}
      </div>}
      {ask && p && <div className="rounded-lg bg-amber-50 p-3">
        <p>Ya tiene <b>{plans.find(x => x.id === ask.plan_id)?.name ?? 'otro plan'}</b> en {ml(`${from}-01`)}. ¿Qué quieres hacer?</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button disabled={busy} className={btn} onClick={() => save('cambio')}>Cambiar de plan (se cobra la diferencia)</button>
          <button disabled={busy} className="rounded-lg border px-3 py-1.5" onClick={() => save('agregar')}>Agregar como segundo plan</button>
          <button className="text-slate-500" onClick={() => setAsk(null)}>Regresar</button></div></div>}
      {!ask && <div className="flex gap-2"><button disabled={!p || busy || comboErrs.length > 0} className={btn} onClick={() => save(null)}>Asignar</button><button className="text-slate-500" onClick={onCancel}>Cancelar</button></div>}
      {msg && <p className="rounded bg-red-50 p-2 text-red-700">{msg}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- Becas y descuentos recurrentes
function Adjustments({ sub, adjs, canEdit, onChanged }: { sub: Sub; adjs: Adj[]; canEdit: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const [f, setF] = useState({ kind: 'beca', label: 'Beca', mode: 'pct', value: '', from: thisMonth(), dur: 'indefinido', to: thisMonth() });
  const month = thisMonth();
  async function add() {
    setMsg(null);
    const value = f.mode === 'pct' ? Math.round(parseFloat(f.value) * 100) : toCents(f.value);
    const to = f.dur === 'un_mes' ? `${f.from}-01` : f.dur === 'hasta' ? `${f.to}-01` : null;
    const { error } = await supabase.from('subscription_adjustments').insert({ subscription_id: sub.id, kind: f.kind, label: f.label.trim() || (f.kind === 'beca' ? 'Beca' : 'Descuento'),
      mode: f.mode, value, from_month: `${f.from}-01`, to_month: to });
    if (error) return setMsg(error.message); setOpen(false); setF({ ...f, value: '' }); onChanged();
  }
  async function skip(a: Adj) {
    const m = prompt('¿Qué mes NO aplica? (AAAA-MM)', month); if (!m || !/^\d{4}-\d{2}$/.test(m)) return;
    const { error } = await supabase.from('adjustment_skips').insert({ adjustment_id: a.id, month: `${m}-01` });
    if (error) setMsg(error.message.includes('duplicate') ? 'Ese mes ya estaba pausado.' : error.message); else onChanged();
  }
  async function stop(a: Adj) {
    const m = prompt('¿Último mes en que aplica? (AAAA-MM)', addMonth(month, -1)); if (!m || !/^\d{4}-\d{2}$/.test(m)) return;
    const { error } = await supabase.from('subscription_adjustments').update({ to_month: `${m}-01` }).eq('id', a.id); if (error) setMsg(error.message); else onChanged();
  }
  async function cancel(a: Adj) {
    if (!confirm('¿Cancelar esta beca porque se capturó por error?')) return;
    const { error } = await supabase.from('subscription_adjustments').update({ cancelled_at: new Date().toISOString() }).eq('id', a.id); if (error) setMsg(error.message); else onChanged();
  }
  return (
    <div className="space-y-1">
      {adjs.map(a => <p key={a.id} className="flex flex-wrap items-center gap-2 text-xs">
        <span className={`rounded-full px-2 ${a.kind === 'beca' ? 'bg-green-100 text-green-700' : 'bg-sky-100 text-sky-700'}`}>{a.label}: {a.mode === 'pct' ? `${a.value / 100} %` : formatMXN(a.value)}</span>
        <span className="text-slate-500">{ml(a.from_month)} {a.to_month ? (a.to_month === a.from_month ? '(sólo ese mes)' : `a ${ml(a.to_month)}`) : 'en adelante'}</span>
        {canEdit && <span className="ml-auto space-x-2"><button className="text-slate-600" onClick={() => skip(a)}>Pausar un mes</button>
          {!a.to_month && <button className="text-slate-600" onClick={() => stop(a)}>Terminar</button>}<button className="text-red-600" onClick={() => cancel(a)}>Cancelar</button></span>}</p>)}
      {canEdit && !open && <button className="text-xs text-brand" onClick={() => setOpen(true)}>+ Beca o descuento recurrente</button>}
      {open && <div className="flex flex-wrap items-end gap-2 rounded-lg bg-slate-50 p-2 text-xs">
        <label>Tipo<select className={`${field} block`} value={f.kind} onChange={e => setF({ ...f, kind: e.target.value, label: e.target.value === 'beca' ? 'Beca' : 'Descuento' })}>
          <option value="beca">Beca</option><option value="descuento">Descuento</option></select></label>
        <label>Nombre<input className={`${field} block w-32`} value={f.label} onChange={e => setF({ ...f, label: e.target.value })} /></label>
        <label>Por<select className={`${field} block`} value={f.mode} onChange={e => setF({ ...f, mode: e.target.value })}><option value="pct">Porcentaje</option><option value="monto">Cantidad</option></select></label>
        <label>{f.mode === 'pct' ? '%' : '$'}<input className={`${field} block w-20`} value={f.value} onChange={e => setF({ ...f, value: e.target.value })} /></label>
        <label>Desde<input type="month" className={`${field} block`} value={f.from} onChange={e => setF({ ...f, from: e.target.value })} /></label>
        <label>Duración<select className={`${field} block`} value={f.dur} onChange={e => setF({ ...f, dur: e.target.value })}>
          <option value="indefinido">Indefinida</option><option value="un_mes">Sólo ese mes</option><option value="hasta">Hasta…</option></select></label>
        {f.dur === 'hasta' && <label>Hasta<input type="month" className={`${field} block`} value={f.to} onChange={e => setF({ ...f, to: e.target.value })} /></label>}
        <button disabled={!f.value} className={btn} onClick={add}>Guardar</button><button className="text-slate-500" onClick={() => setOpen(false)}>Cancelar</button>
      </div>}
      {msg && <p className="text-xs text-red-700">{msg}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- Plan familiar (resumen del mes)
/** Suma los planes de las hermanas: 15 % al más barato y pronto pago sólo al más caro. */
function FamilySummary({ stu, siblings }: { stu: Stu; siblings: Stu[] }) {
  const { companies } = useAuth();
  const [rows, setRows] = useState<{ sub: string; who: string; plan: string; price: number; beca: boolean; companyId: string }[]>([]);
  const [rules, setRules] = useState<BillingRules>(DEFAULT_RULES);
  const month = thisMonth();
  useEffect(() => {
    const ids = [stu.id, ...siblings.map(x => x.id)];
    (async () => {
      const r = await supabase.from('subscriptions').select('id,plan_id,student_id,company_id,start_month,end_month').in('student_id', ids).is('cancelled_at', null)
        .lte('start_month', `${month}-01`).or(`end_month.is.null,end_month.gte.${month}-01`);
      const subs = r.data ?? []; if (!subs.length) return setRows([]);
      const [pl, adj, br] = await Promise.all([
        supabase.from('plans_v').select('id,name,discipline,price_cents').in('id', [...new Set(subs.map(x => x.plan_id))]),
        supabase.from('subscription_adjustments').select('subscription_id,kind,from_month,to_month').in('subscription_id', subs.map(x => x.id)).is('cancelled_at', null).eq('kind', 'beca'),
        supabase.from('billing_rules').select('*').eq('company_id', stu.company_id).maybeSingle()]);
      if (br.data) setRules({ earlyBps: br.data.early_bps, siblingBps: br.data.sibling_bps, dueDay: br.data.due_day,
        surcharges: [{ fromDay: br.data.surcharge1_day, bps: br.data.surcharge1_bps }, { fromDay: br.data.surcharge2_day, bps: br.data.surcharge2_bps }] });
      const names = new Map([[stu.id, stu.full_name], ...siblings.map(x => [x.id, x.full_name] as [string, string])]);
      setRows(subs.map(x => { const p = (pl.data ?? []).find(y => y.id === x.plan_id);
        return { sub: x.id, who: names.get(x.student_id!) ?? '', plan: p ? `${p.discipline} · ${p.name}` : '(plan de otra sucursal)', price: p?.price_cents ?? 0,
          companyId: x.company_id, beca: (adj.data ?? []).some(a => a.subscription_id === x.id && a.from_month.slice(0, 7) <= month && (!a.to_month || a.to_month.slice(0, 7) >= month)) }; }));
    })();
  }, [stu, siblings, month]);
  if (rows.length < 2) return null;
  const sib = siblingTargets(rows.map(r => ({ id: r.sub, familyId: 'F', price: r.price, beca: r.beca })));
  const calc = (payDate: string | null) => rows.map(r => ({ r, c: monthlyCharge({ price: r.price, month, payDate, sibling: sib.has(r.sub),
    adjustments: r.beca ? [{ label: 'Beca', mode: 'pct', value: 0, kind: 'beca' }] : [], rules }) }));
  const normal = calc(`${month}-01`), early = calc(`${new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 1, 0)).toISOString().slice(0, 10)}`);
  const sum = (xs: typeof normal) => xs.reduce((n, x) => n + x.c.total, 0);
  const co = (id: string) => companies.find(c => c.id === id)?.trade_name ?? '';
  return (
    <div className="rounded-lg bg-purple-50 p-3 text-sm">
      <p className="mb-1 font-medium text-purple-800">Plan familiar · {month}</p>
      {normal.map(({ r, c }) => <p key={r.sub} className="text-xs">{r.who} — {r.plan}{r.companyId !== stu.company_id ? ` (${co(r.companyId)})` : ''}: {formatMXN(r.price)}
        {c.sibling < 0 && <span className="text-green-700"> − hermanos {formatMXN(-c.sibling)}</span>}{r.beca && <span className="text-slate-500"> · con beca (sin otros descuentos)</span>}</p>)}
      <p className="mt-1 text-xs"><b>Total del mes: {formatMXN(sum(normal))}</b> · si paga antes del día 1: {formatMXN(sum(early))} (pronto pago sólo al plan más caro)</p>
      <p className="text-xs text-slate-500">Las becas no se reflejan en este total; se aplican al cobrar.</p>
    </div>
  );
}

// ---------------------------------------------------------------- Pago por adelantado
interface PP { id: string; from_month: string; months: number; price_cents: number; discount_bps: number; total_cents: number; paid_on: string; author_name: string | null; cancelled_at: string | null; payment_method_id: string | null }
function Prepayments({ sub, price, hasBeca, canEdit, onChanged }: { sub: Sub; price: number | null; hasBeca: boolean; canEdit: boolean; onChanged: () => void }) {
  const [list, setList] = useState<PP[]>([]); const [open, setOpen] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const [methods, setMethods] = useState<{ id: string; name: string }[]>([]);
  const [f, setF] = useState({ from: '', months: 6, pct: 15, method: '', paid: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' }) });
  const load = useCallback(async () => {
    const r = await supabase.from('plan_prepayments').select('*').eq('subscription_id', sub.id).order('from_month'); setList((r.data as PP[]) ?? []);
  }, [sub.id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!open) return;
    Promise.all([supabase.from('payment_methods').select('id,name').eq('is_active', true).order('sort'),
      supabase.from('billing_rules').select('prepay_bps').eq('company_id', sub.company_id).maybeSingle()]).then(([m, r]) => {
      setMethods(m.data ?? []);
      // siguiente mes libre: después del último adelanto, y no antes de este mes ni del inicio del plan
      const taken = list.filter(x => !x.cancelled_at).map(x => addMonth(x.from_month.slice(0, 7), x.months));
      const start = [sub.start_month.slice(0, 7), thisMonth(), ...taken].sort().at(-1)!;
      setF(v => ({ ...v, from: start, pct: hasBeca ? 0 : (r.data?.prepay_bps ?? 1500) / 100 }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const q = price !== null ? prepayQuote(price, f.months, Math.round(f.pct * 100)) : null;
  async function save() {
    if (!q || price === null) return; setMsg(null);
    const { error } = await supabase.from('plan_prepayments').insert({ company_id: sub.company_id, subscription_id: sub.id, from_month: `${f.from}-01`,
      months: f.months, price_cents: price, discount_bps: Math.round(f.pct * 100), total_cents: q.total, payment_method_id: f.method || null, paid_on: f.paid });
    if (error) return setMsg(error.message); setOpen(false); load(); onChanged();
  }
  async function cancel(x: PP) {
    if (!confirm('¿Cancelar este pago por adelantado? Los meses quedan otra vez pendientes.')) return;
    const { error } = await supabase.from('plan_prepayments').update({ cancelled_at: new Date().toISOString() }).eq('id', x.id); if (error) setMsg(error.message); else { load(); onChanged(); }
  }
  const last = (x: PP) => `${addMonth(x.from_month.slice(0, 7), x.months - 1)}-01`;
  return (
    <div className="space-y-1">
      {list.map(x => <p key={x.id} className={`flex flex-wrap items-center gap-2 text-xs ${x.cancelled_at ? 'text-slate-400 line-through' : ''}`}>
        <span className="rounded-full bg-amber-100 px-2 text-amber-800">Adelanto {x.months} meses</span>
        <span>{ml(x.from_month)} a {ml(last(x))} · {formatMXN(x.total_cents)}{x.discount_bps ? ` con ${x.discount_bps / 100} %` : ''} · precio congelado {formatMXN(x.price_cents)}</span>
        <span className="text-slate-500">pagado {x.paid_on}{x.author_name ? ` · ${x.author_name}` : ''}</span>
        {canEdit && !x.cancelled_at && <button className="ml-auto text-red-600" onClick={() => cancel(x)}>Cancelar</button>}</p>)}
      {canEdit && !open && <button className="text-xs text-brand" onClick={() => setOpen(true)}>+ Pago por adelantado</button>}
      {open && <div className="space-y-2 rounded-lg bg-amber-50 p-2 text-xs">
        <div className="flex flex-wrap items-end gap-2">
          <label>Desde<input type="month" className={`${field} block`} value={f.from} onChange={e => setF({ ...f, from: e.target.value })} /></label>
          <label>Meses<input type="number" min={1} max={24} className={`${field} block w-16`} value={f.months} onChange={e => setF({ ...f, months: Math.max(1, Math.min(24, +e.target.value)) })} /></label>
          <label>Descuento %<input type="number" min={0} max={100} step={0.5} disabled={hasBeca} className={`${field} block w-20`} value={f.pct} onChange={e => setF({ ...f, pct: +e.target.value })} /></label>
          <label>Forma de pago<select className={`${field} block`} value={f.method} onChange={e => setF({ ...f, method: e.target.value })}><option value="">—</option>
            {methods.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
          <label>Pagó el<input type="date" className={`${field} block`} value={f.paid} onChange={e => setF({ ...f, paid: e.target.value })} /></label>
        </div>
        {q && <p>{f.months} × {formatMXN(price!)} = {formatMXN(q.gross)}{q.discount ? ` − ${f.pct} % (${formatMXN(q.discount)})` : ''} → <b>{formatMXN(q.total)}</b> · cubre {ml(`${f.from}-01`)} a {ml(`${addMonth(f.from, f.months - 1)}-01`)} · {formatMXN(q.perMonth[0])} por mes en el reporte de planes</p>}
        {hasBeca && <p className="text-amber-800">Tiene beca: no lleva descuento por adelanto, sólo se congela el precio.</p>}
        {price === null && <p className="text-red-700">El plan no tiene precio capturado.</p>}
        <div className="flex gap-2"><button disabled={!q || !f.from} className={btn} onClick={save}>Registrar pago</button><button className="text-slate-500" onClick={() => setOpen(false)}>Cancelar</button></div>
      </div>}
      {msg && <p className="text-xs text-red-700">{msg}</p>}
    </div>
  );
}
