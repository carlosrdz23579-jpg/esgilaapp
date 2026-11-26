import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { formatMXN } from '../lib/money';
import { toCents, thisMonth, type Plan } from './Billing';

const field = 'rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand';
const btn = 'rounded-lg bg-brand px-3 py-1.5 text-sm text-white disabled:opacity-50';
const WD = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const addMonth = (ym: string, n: number) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + n, 1)).toISOString().slice(0, 7);
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const ml = (d: string) => `${MONTHS[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;

interface Stu { id: string; company_id: string; full_name: string; family_id?: string | null }
interface Sub { id: string; plan_id: string; student_id: string | null; family_id: string | null; start_month: string; end_month: string | null;
  replaces_id: string | null; cancelled_at: string | null; created_at: string }
interface Mem { id: string; subscription_id: string; student_id: string; class_id: string | null; weekdays: number[] }
interface Adj { id: string; subscription_id: string; kind: string; label: string; mode: 'pct' | 'monto'; value: number; from_month: string; to_month: string | null; cancelled_at: string | null }
interface Grp { id: string; activity: string; start_time: string; end_time: string; capacity: number | null; is_active: boolean }

/** Plan(es), familia y becas de una alumna — va dentro de su ficha. */
export default function StudentPlans({ s, onChanged }: { s: Stu; onChanged?: () => void }) {
  const { can } = useAuth();
  const canEdit = can('billing', 'edit'), canSee = canEdit || can('billing') || can('billing', 'configure');
  const [stu, setStu] = useState<Stu>(s);
  const [plans, setPlans] = useState<Plan[]>([]); const [groups, setGroups] = useState<Grp[]>([]);
  const [subs, setSubs] = useState<Sub[]>([]); const [mems, setMems] = useState<Mem[]>([]); const [adjs, setAdjs] = useState<Adj[]>([]);
  const [family, setFamily] = useState<{ id: string; name: string } | null>(null); const [siblings, setSiblings] = useState<Stu[]>([]);
  const [msg, setMsg] = useState<string | null>(null); const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const st = await supabase.from('students').select('id,company_id,full_name,family_id').eq('id', s.id).single();
    const me = (st.data as Stu) ?? s; setStu(me);
    const [p, g, m1] = await Promise.all([
      supabase.from('plans_v').select('*').eq('company_id', s.company_id).eq('is_active', true).order('discipline').order('sort'),
      supabase.from('class_groups').select('id,activity,start_time,end_time,capacity,is_active').eq('company_id', s.company_id).eq('is_active', true).order('activity').order('start_time'),
      supabase.from('subscription_members').select('*').eq('student_id', s.id)]);
    setPlans((p.data as Plan[]) ?? []); setGroups((g.data as Grp[]) ?? []);
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
            {ms.map(m => <p key={m.id} className="text-xs text-slate-600">{m.student_id === s.id ? '' : `${siblings.find(z => z.id === m.student_id)?.full_name ?? 'Integrante'}: `}
              {grp(m.class_id) ? `${grp(m.class_id)!.activity} ${grp(m.class_id)!.start_time}` : 'sin grupo'}{m.weekdays.length ? ` · ${m.weekdays.map(w => WD[w]).join(', ')}` : ''}</p>)}
            {p?.kind === 'familiar' && canEdit && !ms.some(m => m.student_id === s.id) && <JoinFamilyPlan sub={x} s={s} groups={groups} onDone={done} />}
            <Adjustments sub={x} adjs={adjs.filter(a => a.subscription_id === x.id)} canEdit={canEdit} onChanged={done} />
          </div>);
      })}
      {!current.length && !adding && <p className="text-sm text-slate-400">Sin plan asignado.</p>}
      {adding && <AssignPlan s={stu} family={family} plans={plans} groups={groups} subs={subs} onCancel={() => setAdding(false)} onDone={() => { setAdding(false); done(); }} />}
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
function AssignPlan({ s, family, plans, groups, subs, onCancel, onDone }: { s: Stu; family: { id: string } | null; plans: Plan[]; groups: Grp[]; subs: Sub[]; onCancel: () => void; onDone: () => void }) {
  const [planId, setPlanId] = useState(''); const [from, setFrom] = useState(thisMonth()); const [classId, setClassId] = useState('');
  const [days, setDays] = useState<number[]>([]); const [taken, setTaken] = useState<Record<string, number>>({});
  const [ask, setAsk] = useState<Sub | null>(null); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const p = plans.find(x => x.id === planId);
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
    const m = await supabase.from('subscription_members').insert({ subscription_id: data.id, student_id: s.id, class_id: classId || null, weekdays: days });
    if (m.error) { await supabase.from('subscriptions').update({ cancelled_at: new Date().toISOString() }).eq('id', data.id); setBusy(false); return setMsg(m.error.message); }
    if (mode === 'cambio' && clash) {
      // el anterior cubre hasta el mes previo; si empezó este mismo mes, convive ese mes y se cobra sólo la diferencia
      const endM = clash.start_month.slice(0, 7) < from ? `${addMonth(from, -1)}-01` : `${from}-01`;
      const e = await supabase.from('subscriptions').update({ end_month: endM }).eq('id', clash.id);
      if (e.error) { setBusy(false); return setMsg(e.error.message); }
    }
    setBusy(false); onDone();
  }
  const disciplines = [...new Set(plans.map(x => x.discipline))];
  return (
    <div className="space-y-2 rounded-lg border-2 border-brand/30 p-3 text-sm">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">Plan<select className={`${field} block`} value={planId} onChange={e => setPlanId(e.target.value)}>
          <option value="">Elige…</option>{disciplines.map(d => <optgroup key={d} label={d}>{plans.filter(x => x.discipline === d).map(x =>
            <option key={x.id} value={x.id}>{x.name}{x.kind === 'familiar' ? ' (familiar)' : ''} · {x.price_cents != null ? formatMXN(x.price_cents) : 'sin precio'}</option>)}</optgroup>)}</select></label>
        <label className="text-xs">Desde<input type="month" className={`${field} block`} value={from} onChange={e => setFrom(e.target.value)} /></label>
        <label className="text-xs">Grupo<select className={`${field} block`} value={classId} onChange={e => setClassId(e.target.value)}>
          <option value="">Sin grupo por ahora</option>{groups.map(g => { const t = taken[g.id] ?? 0; const full = g.capacity !== null && t >= g.capacity;
            return <option key={g.id} value={g.id} disabled={full}>{g.activity} {g.start_time}–{g.end_time} · {t}{g.capacity ? `/${g.capacity}` : ''}{full ? ' · lleno' : ''}</option>; })}</select></label>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs"><span className="text-slate-500">Días que viene:</span>
        {[1, 2, 3, 4, 5, 6, 0].map(d => <label key={d} className="flex items-center gap-1"><input type="checkbox" checked={days.includes(d)}
          onChange={e => setDays(e.target.checked ? [...days, d].sort() : days.filter(x => x !== d))} />{WD[d]}</label>)}</div>
      {ask && p && <div className="rounded-lg bg-amber-50 p-3">
        <p>Ya tiene <b>{plans.find(x => x.id === ask.plan_id)?.name ?? 'otro plan'}</b> en {ml(`${from}-01`)}. ¿Qué quieres hacer?</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button disabled={busy} className={btn} onClick={() => save('cambio')}>Cambiar de plan (se cobra la diferencia)</button>
          <button disabled={busy} className="rounded-lg border px-3 py-1.5" onClick={() => save('agregar')}>Agregar como segundo plan</button>
          <button className="text-slate-500" onClick={() => setAsk(null)}>Regresar</button></div></div>}
      {!ask && <div className="flex gap-2"><button disabled={!p || busy} className={btn} onClick={() => save(null)}>Asignar</button><button className="text-slate-500" onClick={onCancel}>Cancelar</button></div>}
      {msg && <p className="rounded bg-red-50 p-2 text-red-700">{msg}</p>}
    </div>
  );
}

function JoinFamilyPlan({ sub, s, groups, onDone }: { sub: Sub; s: Stu; groups: Grp[]; onDone: () => void }) {
  const [classId, setClassId] = useState(''); const [msg, setMsg] = useState<string | null>(null);
  async function join() {
    const { error } = await supabase.from('subscription_members').insert({ subscription_id: sub.id, student_id: s.id, class_id: classId || null });
    if (error) setMsg(error.message); else onDone();
  }
  return <div className="flex flex-wrap items-center gap-2 text-xs"><span>Agregar a {s.full_name} a este plan familiar:</span>
    <select className={field} value={classId} onChange={e => setClassId(e.target.value)}><option value="">Sin grupo</option>
      {groups.map(g => <option key={g.id} value={g.id}>{g.activity} {g.start_time}</option>)}</select>
    <button className="text-brand" onClick={join}>Agregar</button>{msg && <span className="text-red-700">{msg}</span>}</div>;
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
