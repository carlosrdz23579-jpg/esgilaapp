import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { periodsBetween, addDays, type ScheduleConfig, type Frequency, type WeekendRule, type Cutoff } from '@domain/pay-calendar';

const field = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand';
const btn = 'rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-60';
const today = () => new Date().toLocaleDateString('en-CA');           // YYYY-MM-DD local
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const fmtDate = (iso: string) => {
  const d = new Date(iso + 'T12:00:00');
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
};

type Scope = 'empresa' | 'departamento' | 'grupo' | 'empleado';
interface CompanyRow { id: string; trade_name: string; description: string | null; address: string | null; is_active: boolean }
interface Dept { id: string; name: string }
interface Group { id: string; name: string; department_id: string }
interface EmpLite { id: string; full_name: string; department_id: string; group_id: string | null; work_days: number[] }
export interface Schedule {
  id: string; company_id: string; scope: Scope; department_id: string | null; group_id: string | null; employee_id: string | null;
  frequency: Frequency; weekly_weekday: number | null; biweekly_day_1: number | null; biweekly_day_2: number | null;
  monthly_day: number | null; weekend_rule: WeekendRule; cutoff: Cutoff; effective_from: string; effective_to: string | null;
  reason: string; created_at: string; cancelled_at: string | null; cancel_reason: string | null;
}
const SCOPE_RANK: Record<Scope, number> = { empleado: 1, grupo: 2, departamento: 3, empresa: 4 };

export function toConfig(s: Pick<Schedule, 'frequency' | 'weekly_weekday' | 'biweekly_day_1' | 'biweekly_day_2' | 'monthly_day' | 'weekend_rule' | 'cutoff'>, workDays?: number[]): ScheduleConfig {
  return {
    frequency: s.frequency, weekendRule: s.weekend_rule, cutoff: s.cutoff, workDays,
    weeklyWeekday: s.weekly_weekday ?? undefined,
    biweeklyDays: s.biweekly_day_1 != null && s.biweekly_day_2 != null ? [s.biweekly_day_1, s.biweekly_day_2] : undefined,
    monthlyDay: s.monthly_day ?? undefined,
  };
}

export function describe(s: Pick<Schedule, 'frequency' | 'weekly_weekday' | 'biweekly_day_1' | 'biweekly_day_2' | 'monthly_day' | 'weekend_rule' | 'cutoff'>) {
  const day = (d: number | null) => (d === 31 ? 'último día' : `día ${d}`);
  const base = s.frequency === 'semanal' ? `Semanal, cada ${WEEKDAYS[s.weekly_weekday ?? 0]}`
    : s.frequency === 'quincenal' ? `Quincenal: ${day(s.biweekly_day_1)} y ${day(s.biweekly_day_2)}`
    : `Mensual: ${day(s.monthly_day)}`;
  const rule = { antes: 'si no es laborable, se paga el día laborable anterior', despues: 'si no es laborable, se paga el siguiente', ninguno: 'sin ajuste' }[s.weekend_rule];
  const cut = s.cutoff === 'dia_anterior' ? 'el día de pago cuenta en el siguiente periodo' : 'el periodo termina el día de pago';
  return `${base} · ${rule} · ${cut}`;
}

/** Calendario que aplica a un empleado en una fecha (misma prioridad que app.effective_schedule en SQL). */
export function effectiveFor(scheds: Schedule[], emp: Pick<EmpLite, 'id' | 'department_id' | 'group_id'>, date: string): Schedule | undefined {
  return scheds
    .filter(s => !s.cancelled_at && s.effective_from <= date && (!s.effective_to || s.effective_to >= date))
    .filter(s => (s.scope === 'empleado' && s.employee_id === emp.id) || (s.scope === 'grupo' && s.group_id === emp.group_id)
      || (s.scope === 'departamento' && s.department_id === emp.department_id) || s.scope === 'empresa')
    .sort((a, b) => SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] || b.effective_from.localeCompare(a.effective_from) || b.created_at.localeCompare(a.created_at))[0];
}

export default function Companies() {
  const { companies, companyId, setCompanyId, can, reload } = useAuth();
  const [rows, setRows] = useState<CompanyRow[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState<CompanyRow | 'new' | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('companies').select('id,trade_name,description,address,is_active').order('trade_name');
    if (error) setMsg(error.message); else setRows((data as CompanyRow[]) ?? []);
  }, []);
  useEffect(() => { load(); }, [load, companies]);

  async function toggle(c: CompanyRow) {
    const verb = c.is_active ? 'desactivar' : 'activar';
    if (!window.confirm(`¿Seguro que quieres ${verb} ${c.trade_name}? No se borra nada; ${c.is_active ? 'deja de aparecer en el selector.' : 'vuelve a aparecer.'}`)) return;
    const { data, error } = await supabase.from('companies').update({ is_active: !c.is_active }).eq('id', c.id).select('id');
    if (error) return setMsg(error.message);
    if (!data?.length) return setMsg('No se aplicó: no tienes permiso para editar esta empresa.');
    await reload(); load();
  }

  const selected = companyId === 'all' ? null : rows.find(r => r.id === companyId) ?? null;

  return (
    <div className="space-y-6">
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold">Empresas</h3>
          {can('companies', 'create') && <button className={`${btn} ml-auto`} onClick={() => setEditing('new')}>+ Nueva empresa</button>}
        </div>
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-100 text-xs uppercase text-slate-500">
              <tr><th className="px-3 py-2">Nombre comercial</th><th className="px-3 py-2">Domicilio</th><th className="px-3 py-2">Estado</th><th /></tr>
            </thead>
            <tbody>{rows.map(c => (
              <tr key={c.id} className={`border-t ${c.id === companyId ? 'bg-brand/5' : ''}`}>
                <td className="px-3 py-2 font-medium">
                  <button className="text-left hover:underline" onClick={() => setCompanyId(c.id)}>{c.trade_name}</button></td>
                <td className="px-3 py-2">{c.address ?? '—'}</td>
                <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-xs ${c.is_active ? 'bg-green-100 text-green-700' : 'bg-slate-200 text-slate-600'}`}>{c.is_active ? 'activa' : 'inactiva'}</span></td>
                <td className="space-x-3 px-3 py-2 text-right">
                  {can('companies', 'edit') && <button className="text-brand" onClick={() => setEditing(c)}>Editar</button>}
                  {can('companies', 'edit') && <button className={c.is_active ? 'text-red-700' : 'text-green-700'} onClick={() => toggle(c)}>{c.is_active ? 'Desactivar' : 'Activar'}</button>}
                </td>
              </tr>))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="font-semibold">Calendarios de pago {selected && <span className="font-normal text-slate-500">· {selected.trade_name}</span>}</h3>
        {selected ? <Schedules companyId={selected.id} /> :
          <p className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">Elige una empresa (en la tabla o en el selector de arriba) para ver y cambiar sus calendarios de pago.</p>}
      </section>

      {editing && <CompanyForm company={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
        onSaved={async () => { setEditing(null); await reload(); load(); }} />}
    </div>
  );
}

function CompanyForm({ company, onClose, onSaved }: { company: CompanyRow | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ trade_name: company?.trade_name ?? '', description: company?.description ?? '', address: company?.address ?? '' });
  const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    const payload = { trade_name: f.trade_name.trim(), description: f.description.trim() || null, address: f.address.trim() || null };
    const res = company ? await supabase.from('companies').update(payload).eq('id', company.id).select('id')
      : await supabase.from('companies').insert(payload).select('id');
    setBusy(false);
    if (res.error) return setMsg(res.error.message);
    if (!res.data?.length) return setMsg('No se guardó: no tienes permiso para esta operación.');
    onSaved();
  }
  return (
    <Modal title={company ? `Editar ${company.trade_name}` : 'Nueva empresa'} onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        <label className="block text-xs">Nombre comercial<input required className={field} value={f.trade_name} onChange={e => setF({ ...f, trade_name: e.target.value })} /></label>
        <label className="block text-xs">Descripción<input className={field} value={f.description} onChange={e => setF({ ...f, description: e.target.value })} /></label>
        <label className="block text-xs">Domicilio<input className={field} value={f.address} onChange={e => setF({ ...f, address: e.target.value })} /></label>
        {company && <p className="text-xs text-slate-500">Renombrar no afecta la historia: todo está ligado al identificador interno, no al nombre.</p>}
        {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
        <button disabled={busy} className={btn}>{company ? 'Guardar' : 'Crear empresa'}</button>
      </form>
    </Modal>
  );
}

function Schedules({ companyId }: { companyId: string }) {
  const { can } = useAuth();
  const [scheds, setScheds] = useState<Schedule[]>([]);
  const [depts, setDepts] = useState<Dept[]>([]); const [groups, setGroups] = useState<Group[]>([]); const [emps, setEmps] = useState<EmpLite[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [creating, setCreating] = useState<Schedule | 'new' | null>(null);

  const load = useCallback(async () => {
    setMsg(null);
    const [s, d, g, e] = await Promise.all([
      supabase.from('pay_schedules').select('*').eq('company_id', companyId).order('effective_from', { ascending: false }),
      supabase.from('departments').select('id,name').eq('company_id', companyId).eq('is_active', true).order('name'),
      supabase.from('groups').select('id,name,department_id').eq('company_id', companyId).eq('is_active', true).order('name'),
      supabase.from('employees').select('id,full_name,department_id,group_id,work_days').eq('company_id', companyId).eq('state', 'activo').order('full_name'),
    ]);
    const err = s.error ?? d.error ?? g.error ?? e.error;
    if (err) setMsg(err.message);
    setScheds((s.data as Schedule[]) ?? []); setDepts((d.data as Dept[]) ?? []); setGroups((g.data as Group[]) ?? []); setEmps((e.data as EmpLite[]) ?? []);
  }, [companyId]);
  useEffect(() => { load(); }, [load]);

  const target = (s: Schedule) =>
    s.scope === 'empresa' ? 'Toda la empresa'
      : s.scope === 'departamento' ? `Departamento ${depts.find(d => d.id === s.department_id)?.name ?? '—'}`
      : s.scope === 'grupo' ? `Grupo ${groups.find(g => g.id === s.group_id)?.name ?? '—'}`
      : `Empleado: ${emps.find(x => x.id === s.employee_id)?.full_name ?? '—'}`;
  const t = today();
  const status = (s: Schedule) => (s.cancelled_at ? 'cancelado' : s.effective_to && s.effective_to < t ? 'terminado' : s.effective_from > t ? 'programado' : 'vigente');
  const canConfig = can('pay_schedules', 'configure');

  async function cancel(s: Schedule) {
    const motivo = window.prompt(`Cancelar "${target(s)}" (${s.effective_from}). No se borra: queda marcado como cancelado.\n\nMotivo de la cancelación:`);
    if (motivo === null) return;
    if (!motivo.trim()) return setMsg('El motivo de cancelación es obligatorio.');
    const { data, error } = await supabase.from('pay_schedules').update({ cancelled_at: new Date().toISOString(), cancel_reason: motivo.trim() }).eq('id', s.id).select('id');
    if (error) return setMsg(error.message);
    if (!data?.length) return setMsg('No se aplicó: no tienes permiso para esta operación.');
    load();
  }
  async function finish(s: Schedule) {
    const fin = window.prompt(`Terminar "${target(s)}". Último día en que aplica (AAAA-MM-DD, hoy o después). Lo ya pagado no cambia:`, t);
    if (fin === null) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fin) || fin < t) return setMsg('La fecha de fin debe ser hoy o posterior, con formato AAAA-MM-DD.');
    const { data, error } = await supabase.from('pay_schedules').update({ effective_to: fin }).eq('id', s.id).select('id');
    if (error) return setMsg(error.message);
    if (!data?.length) return setMsg('No se aplicó: no tienes permiso para esta operación.');
    load();
  }

  // Próximos pagos de la empresa, por tipo de horario, con el calendario general vigente.
  const general = scheds.filter(s => s.scope === 'empresa' && status(s) === 'vigente').sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0];
  const upcoming = useMemo(() => {
    if (!general) return null;
    const mk = (wd: number[]) => periodsBetween(toConfig(general, wd), t, addDays(t, 75)).slice(0, 4);
    return { sab: mk([1, 2, 3, 4, 5, 6]), jue: mk([1, 2, 3, 4]) };
  }, [general, t]);

  return (
    <div className="space-y-3">
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      {upcoming && (
        <div className="rounded-xl bg-white p-4 text-sm shadow-sm">
          <p className="mb-2 font-medium">Próximos pagos (calendario general)</p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-slate-500"><tr><th className="py-1">Periodo trabajado</th><th>Pago: lunes a sábado</th><th>Pago: lunes a jueves</th></tr></thead>
              <tbody>{upcoming.sab.map((p, i) => (
                <tr key={p.nominal} className="border-t"><td className="py-1">{fmtDate(p.start)} → {fmtDate(p.end)}</td>
                  <td>{fmtDate(p.payDate)}</td><td>{fmtDate(upcoming.jue[i].payDate)}</td></tr>))}</tbody>
            </table>
          </div>
        </div>)}
      <div className="flex items-center">
        <p className="text-xs text-slate-500">Prioridad: empleado → grupo → departamento → empresa. Un cambio programado se puede editar o cancelar; uno vigente solo se puede terminar, para no alterar quincenas ya pagadas. Nada se borra.</p>
        {canConfig && <button className={`${btn} ml-auto shrink-0`} onClick={() => setCreating('new')}>Cambiar calendario</button>}
      </div>
      <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-100 text-xs uppercase text-slate-500">
            <tr><th className="px-3 py-2">Aplica a</th><th className="px-3 py-2">Calendario</th><th className="px-3 py-2">Vigencia</th><th className="px-3 py-2">Motivo</th><th className="px-3 py-2">Estado</th><th /></tr>
          </thead>
          <tbody>
            {scheds.map(s => (
              <tr key={s.id} className={`border-t align-top ${s.cancelled_at ? 'text-slate-400 line-through decoration-slate-300' : ''}`}>
                <td className="px-3 py-2 font-medium">{target(s)}</td><td className="px-3 py-2 text-xs">{describe(s)}</td>
                <td className="px-3 py-2 text-xs">{s.effective_from} → {s.effective_to ?? 'permanente'}</td>
                <td className="px-3 py-2 text-xs">{s.reason}{s.cancel_reason && <span className="block no-underline">Cancelado: {s.cancel_reason}</span>}</td>
                <td className="px-3 py-2 text-xs">{status(s)}</td>
                <td className="space-x-2 whitespace-nowrap px-3 py-2 text-right text-xs">
                  {canConfig && status(s) === 'programado' && <>
                    <button className="text-brand" onClick={() => setCreating(s)}>Editar</button>
                    <button className="text-red-700" onClick={() => cancel(s)}>Cancelar</button></>}
                  {canConfig && status(s) === 'vigente' && <button className="text-amber-700" onClick={() => finish(s)}>Terminar</button>}
                </td>
              </tr>))}
            {scheds.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">Esta empresa no tiene calendario de pago.</td></tr>}
          </tbody>
        </table>
      </div>
      {creating && <ScheduleForm existing={creating === 'new' ? null : creating} companyId={companyId} scheds={scheds} depts={depts} groups={groups} emps={emps}
        onClose={() => setCreating(null)} onSaved={() => { setCreating(null); load(); }} />}
    </div>
  );
}

function ScheduleForm({ existing, companyId, scheds, depts, groups, emps, onClose, onSaved }:
  { existing: Schedule | null; companyId: string; scheds: Schedule[]; depts: Dept[]; groups: Group[]; emps: EmpLite[]; onClose: () => void; onSaved: () => void }) {
  const x = existing;
  const [scope, setScope] = useState<Scope>(x?.scope ?? 'empresa');
  const [targetId, setTargetId] = useState(x ? (x.employee_id ?? x.group_id ?? x.department_id ?? '') : '');
  const [frequency, setFrequency] = useState<Frequency>(x?.frequency ?? 'quincenal');
  const [weekday, setWeekday] = useState(x?.weekly_weekday ?? 6); const [d1, setD1] = useState(x?.biweekly_day_1 ?? 15);
  const [d2, setD2] = useState(x?.biweekly_day_2 ?? 31); const [md, setMd] = useState(x?.monthly_day ?? 31);
  const [rule, setRule] = useState<WeekendRule>(x?.weekend_rule ?? 'antes'); const [cutoff, setCutoff] = useState<Cutoff>(x?.cutoff ?? 'dia_anterior');
  const [from, setFrom] = useState(x?.effective_from ?? today()); const [temporal, setTemporal] = useState(!!x?.effective_to);
  const [to, setTo] = useState(x?.effective_to ?? ''); const [reason, setReason] = useState(x?.reason ?? ''); const [review, setReview] = useState(false);
  const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);

  const draft = {
    frequency, weekend_rule: rule, cutoff,
    weekly_weekday: frequency === 'semanal' ? weekday : null,
    biweekly_day_1: frequency === 'quincenal' ? d1 : null, biweekly_day_2: frequency === 'quincenal' ? d2 : null,
    monthly_day: frequency === 'mensual' ? md : null,
  };
  const inScope = (e: EmpLite) => scope === 'empresa' || (scope === 'departamento' && e.department_id === targetId)
    || (scope === 'grupo' && e.group_id === targetId) || (scope === 'empleado' && e.id === targetId);
  const affected = emps.filter(inScope);
  // Quienes tienen un calendario más específico vigente no cambian (sus excepciones se conservan).
  const keepOwn = affected.filter(e => { const cur = effectiveFor(scheds.filter(s => s.id !== x?.id), e, from); return cur && SCOPE_RANK[cur.scope] < SCOPE_RANK[scope]; });
  const sample = affected.find(e => !keepOwn.includes(e));
  const others = scheds.filter(s => s.id !== x?.id);
  const before = sample ? effectiveFor(others, sample, from) : others.find(s => s.scope === 'empresa' && !s.cancelled_at);

  let preview: { start: string; end: string; payDate: string }[] = []; let previewErr: string | null = null;
  try { preview = periodsBetween(toConfig(draft, sample?.work_days), from, addDays(from, 75)).slice(0, 4); }
  catch (e) { previewErr = (e as Error).message; }

  function validate(): string | null {
    if (scope !== 'empresa' && !targetId) return 'Elige a qué departamento, grupo o empleado aplica.';
    if (frequency === 'quincenal' && !(d1 < d2)) return 'El primer día de pago debe ser menor que el segundo.';
    if (from < today()) return 'No se pueden hacer cambios con vigencia en el pasado.';
    if (temporal && (!to || to < from)) return 'Indica hasta cuándo dura el cambio temporal (igual o después del inicio).';
    if (!reason.trim()) return 'El motivo es obligatorio.';
    if (previewErr) return previewErr;
    return null;
  }

  async function confirm() {
    setBusy(true); setMsg(null);
    const common = { ...draft, effective_from: from, effective_to: temporal ? to : null, reason: reason.trim() };
    const { data, error } = x
      ? await supabase.from('pay_schedules').update(common).eq('id', x.id).select('id')
      : await supabase.from('pay_schedules').insert({
          company_id: companyId, scope, ...common,
          department_id: scope === 'departamento' ? targetId : scope === 'grupo' ? groups.find(g => g.id === targetId)?.department_id ?? null : null,
          group_id: scope === 'grupo' ? targetId : null, employee_id: scope === 'empleado' ? targetId : null,
        }).select('id');
    setBusy(false);
    if (error) { setReview(false); return setMsg(error.message); }
    if (!data?.length) { setReview(false); return setMsg('No se guardó: no tienes permiso para esta operación.'); }
    onSaved();
  }

  const days = Array.from({ length: 31 }, (_, i) => i + 1);
  const dayLabel = (d: number) => (d === 31 ? 'Último día del mes' : `Día ${d}`);
  const targets = scope === 'departamento' ? depts : scope === 'grupo' ? groups : scope === 'empleado' ? emps.map(e => ({ id: e.id, name: e.full_name })) : [];

  return (
    <Modal title={x ? 'Editar cambio programado' : 'Cambiar calendario de pago'} onClose={onClose}>
      {!review ? (
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={e => { e.preventDefault(); const v = validate(); if (v) setMsg(v); else { setMsg(null); setReview(true); } }}>
          <label className="text-xs">Aplica a
            <select disabled={!!x} className={field} value={scope} onChange={e => { setScope(e.target.value as Scope); setTargetId(''); }}>
              <option value="empresa">Toda la empresa</option><option value="departamento">Un departamento</option>
              <option value="grupo">Un grupo</option><option value="empleado">Un empleado</option>
            </select></label>
          {scope !== 'empresa' ? (
            <label className="text-xs">¿Cuál?
              <select required disabled={!!x} className={field} value={targetId} onChange={e => setTargetId(e.target.value)}>
                <option value="" disabled>Selecciona…</option>{targets.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select></label>) : <div />}
          <label className="text-xs">Frecuencia
            <select className={field} value={frequency} onChange={e => setFrequency(e.target.value as Frequency)}>
              <option value="quincenal">Quincenal</option><option value="semanal">Semanal</option><option value="mensual">Mensual</option>
            </select></label>
          {frequency === 'semanal' && <label className="text-xs">Día de pago
            <select className={field} value={weekday} onChange={e => setWeekday(+e.target.value)}>{WEEKDAYS.map((w, i) => <option key={i} value={i}>{w}</option>)}</select></label>}
          {frequency === 'mensual' && <label className="text-xs">Día de pago
            <select className={field} value={md} onChange={e => setMd(+e.target.value)}>{days.map(d => <option key={d} value={d}>{dayLabel(d)}</option>)}</select></label>}
          {frequency === 'quincenal' && <div className="grid grid-cols-2 gap-2">
            <label className="text-xs">1er pago<select className={field} value={d1} onChange={e => setD1(+e.target.value)}>{days.slice(0, 30).map(d => <option key={d} value={d}>{dayLabel(d)}</option>)}</select></label>
            <label className="text-xs">2º pago<select className={field} value={d2} onChange={e => setD2(+e.target.value)}>{days.map(d => <option key={d} value={d}>{dayLabel(d)}</option>)}</select></label>
          </div>}
          <label className="text-xs">Si el día de pago no es laborable para la persona
            <select className={field} value={rule} onChange={e => setRule(e.target.value as WeekendRule)}>
              <option value="antes">Pagar su día laborable anterior</option><option value="despues">Pagar su siguiente día laborable</option><option value="ninguno">No ajustar</option>
            </select></label>
          <label className="text-xs">Corte del periodo
            <select className={field} value={cutoff} onChange={e => setCutoff(e.target.value as Cutoff)}>
              <option value="dia_anterior">El día de pago cuenta en el siguiente periodo</option><option value="dia_de_pago">El periodo termina el día de pago</option>
            </select></label>
          <label className="text-xs">Vigente desde<input type="date" min={today()} className={field} value={from} onChange={e => setFrom(e.target.value)} required /></label>
          <div className="text-xs">
            <label className="flex items-center gap-2 pt-5"><input type="checkbox" checked={temporal} onChange={e => setTemporal(e.target.checked)} />Cambio temporal</label>
            {temporal && <input type="date" min={from} className={`${field} mt-1`} value={to} onChange={e => setTo(e.target.value)} />}
          </div>
          <label className="text-xs sm:col-span-2">Motivo (obligatorio)<input className={field} value={reason} onChange={e => setReason(e.target.value)} /></label>
          {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700 sm:col-span-2">{msg}</p>}
          <div className="sm:col-span-2"><button className={btn}>Revisar cambio</button></div>
        </form>
      ) : (
        <div className="space-y-3 text-sm">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg bg-slate-50 p-3"><p className="text-xs font-semibold text-slate-500">ANTES</p><p>{before ? describe(before) : 'Sin calendario'}</p></div>
            <div className="rounded-lg bg-brand/10 p-3"><p className="text-xs font-semibold text-slate-500">DESPUÉS</p><p>{describe(draft)}</p></div>
          </div>
          <p><b>{affected.length - keepOwn.length}</b> empleado(s) activos cambian de calendario.
            {keepOwn.length > 0 && <> <b>{keepOwn.length}</b> conservan su excepción individual, de grupo o de departamento.</>}</p>
          <p>Vigencia: desde {fmtDate(from)} {temporal ? `hasta ${fmtDate(to)} (temporal)` : '(permanente)'}. Motivo: {reason}</p>
          <div>
            <p className="font-medium">Próximos pagos con el nuevo calendario{sample ? ` (ejemplo: ${sample.full_name})` : ''}</p>
            <ul className="list-disc pl-5 text-xs">{preview.map(p => <li key={p.start}>Trabajo del {fmtDate(p.start)} al {fmtDate(p.end)} → se paga el <b>{fmtDate(p.payDate)}</b></li>)}</ul>
          </div>
          {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
          <div className="flex gap-2">
            <button disabled={busy} className={btn} onClick={confirm}>{x ? 'Guardar cambios' : 'Confirmar cambio'}</button>
            <button className="rounded-lg border px-4 py-2 text-sm" onClick={() => setReview(false)}>Volver</button>
          </div>
          <p className="text-xs text-slate-500">Queda registrado quién lo hizo y cuándo. Mientras no empiece se puede editar o cancelar; una vez vigente solo se puede terminar.</p>
        </div>
      )}
    </Modal>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <div className="w-full max-w-2xl space-y-4 rounded-2xl bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between"><h3 className="text-lg font-semibold">{title}</h3>
          <button onClick={onClose} aria-label="Cerrar" className="text-xl">×</button></div>
        {children}
      </div>
    </div>
  );
}
