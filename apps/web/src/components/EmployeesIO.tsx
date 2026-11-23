import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { Modal } from './ui';
import {
  parseGeneral, parseConfidential, normName, fmtDateMx, seniorityYears, monthlyEstimateCents, addMonthsIso,
  similarNames, GENERAL_HEADERS, CONFIDENTIAL_HEADERS, type GeneralRow, type ConfidentialRow,
} from '@domain/employees-io';

const btn = 'rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-60';
const today = () => new Date().toLocaleDateString('en-CA');
interface Co { id: string; trade_name: string }
interface Dept { id: string; company_id: string; name: string }
type Existing = Record<string, unknown> & { id: string; full_name: string; curp: string | null; company_id: string; state: string; pay_method: string };
type MatchKind = 'curp' | 'nombre' | 'parecido' | 'elegido' | 'nuevo';
interface Plan {
  g: GeneralRow; c: ConfidentialRow | null; existing: Existing | null; match: MatchKind; similar: string[];
  companyId: string; deptId: string | null; error: string | null;
}
const MATCH_LABEL: Record<MatchKind, string> = { curp: 'misma CURP', nombre: 'mismo nombre', parecido: '¿es la misma persona?', elegido: 'elegido por ti', nuevo: 'nuevo' };

const sedeCompany = (sede: string, cos: Co[]) =>
  sede === 'CAR' ? cos.find(c => /car/i.test(c.trade_name))?.id : sede === 'Viñedos' ? cos.find(c => /vi[ñn]edos/i.test(c.trade_name))?.id : undefined;
const deptFor = (companyId: string, coach: boolean, depts: Dept[]) =>
  depts.find(d => d.company_id === companyId && normName(d.name) === (coach ? 'coach' : 'staff'))?.id ?? null;

/** Importar el Excel de Colaboradores (hojas "Datos Generales" y "Confidencial"). */
export function ImportEmployees({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { can } = useAuth();
  const canPay = can('salary', 'edit');
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [cos, setCos] = useState<Co[]>([]); const [depts, setDepts] = useState<Dept[]>([]);
  const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string[] | null>(null);
  const [all, setAll] = useState<Existing[]>([]);
  // Con datos ya capturados: por defecto se conserva lo tuyo y solo se llena lo vacío.
  const [mode, setMode] = useState<'conservar' | 'reemplazar'>('conservar');

  async function read(f: File) {
    setMsg(null); setPlans(null); setResult(null);
    try {
      const XLSX = await import('xlsx');
      // CSV: todo texto (d/m/aaaa). Excel: valores reales (las fechas llegan como Date, sin ambigüedad día/mes).
      const isCsv = /\.csv$/i.test(f.name);
      const wb = XLSX.read(isCsv ? await f.text() : await f.arrayBuffer(), isCsv ? { type: 'string', raw: true } : { type: 'array', cellDates: true });
      const sheets = wb.SheetNames.map(n => ({ n, rows: XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[n], { header: 1, raw: true, defval: '' }) }));
      let gen: GeneralRow[] | null = null; let conf: ConfidentialRow[] | null = null;
      for (const s of sheets) {
        if (!gen) try { gen = parseGeneral(s.rows); continue; } catch { /* no es esta hoja */ }
        if (!conf) try { conf = parseConfidential(s.rows); } catch { /* no es esta hoja */ }
      }
      if (!gen) throw new Error('No encontré la hoja "Datos Generales" (con columnas "Nombre completo" y "CURP").');
      const [c, d, e] = await Promise.all([
        supabase.from('companies').select('id,trade_name').eq('is_active', true),
        supabase.from('departments').select('id,company_id,name').eq('is_active', true),
        supabase.from('employees').select('*').order('full_name').limit(2000),
      ]);
      const err = c.error ?? d.error ?? e.error; if (err) throw err;
      const C = (c.data as Co[]) ?? [], D = (d.data as Dept[]) ?? [], E = (e.data as Existing[]) ?? [];
      setCos(C); setDepts(D); setAll(E);
      setPlans(gen.map(g => {
        const byCurp = g.curp ? E.find(x => (x.curp ?? '').toUpperCase() === g.curp) : undefined;
        const byName = E.find(x => normName(x.full_name) === normName(g.fullName));
        const similar = byCurp || byName ? [] : similarNames(g.fullName, E.map(x => x.full_name)).map(i => E[i].id);
        const existing = byCurp ?? byName ?? (similar.length === 1 ? E.find(x => x.id === similar[0])! : null);
        const match: MatchKind = byCurp ? 'curp' : byName ? 'nombre' : existing ? 'parecido' : 'nuevo';
        const companyId = existing?.company_id ?? sedeCompany(g.sede, C) ?? '';
        const deptId = companyId ? deptFor(companyId, g.isCoach, D) : null;
        return { g, c: conf?.find(x => normName(x.fullName) === normName(g.fullName)) ?? null, existing, match, similar, companyId, deptId,
          error: !companyId ? (g.sede === 'Ambas' ? 'Sede "Ambas": elige su sucursal principal' : 'Sin sede') : !deptId ? 'Esa sucursal no tiene departamento Coach/Staff' : null };
      }));
      if (!conf) setMsg('No encontré la hoja "Confidencial": solo se importan datos generales.');
    } catch (e) { setMsg((e as Error).message); }
  }

  function setTarget(i: number, id: string) {
    setPlans(p => p!.map((x, k) => {
      if (k !== i) return x;
      const existing = id ? all.find(e => e.id === id) ?? null : null;
      const companyId = existing?.company_id ?? sedeCompany(x.g.sede, cos) ?? '';
      const deptId = companyId ? deptFor(companyId, x.g.isCoach, depts) : null;
      return { ...x, existing, match: existing ? 'elegido' : 'nuevo', companyId, deptId,
        error: !companyId ? (x.g.sede === 'Ambas' ? 'Sede "Ambas": elige su sucursal principal' : 'Sin sede') : !deptId ? 'Esa sucursal no tiene departamento Coach/Staff' : null };
    }));
  }
  // Dos filas del Excel no pueden ir al mismo expediente.
  const dupTargets = new Set((plans ?? []).map(p => p.existing?.id).filter((id, i, a): id is string => !!id && a.indexOf(id) !== i));

  function setCompany(i: number, companyId: string) {
    setPlans(p => p!.map((x, k) => {
      if (k !== i) return x;
      const deptId = deptFor(companyId, x.g.isCoach, depts);
      return { ...x, companyId, deptId, error: deptId ? null : 'Esa sucursal no tiene departamento Coach/Staff' };
    }));
  }

  async function run() {
    if (!plans) return;
    if (dupTargets.size) return setMsg('Hay dos filas del Excel apuntando a la misma persona: corrige el empate antes de importar.');
    const ok = plans.filter(p => !p.error);
    if (!window.confirm(`Se van a crear ${ok.filter(p => !p.existing).length} y actualizar ${ok.filter(p => p.existing).length} expediente(s)${plans.length - ok.length ? `; ${plans.length - ok.length} se omiten por tener pendientes` : ''}. ¿Continuar?`)) return;
    setBusy(true); const out: string[] = [];
    for (const p of ok) {
      const g = p.g; const nz = (v: string) => (v ? v : null);
      const data: Record<string, unknown> = {
        full_name: g.fullName, job_title: nz(g.jobTitle), area: nz(g.area), external_no: g.externalNo, birth_date: g.birthDate, hire_date: g.hireDate,
        address: nz(g.address), phone: nz(g.phone), email: nz(g.email), curp: nz(g.curp), rfc: nz(g.rfc), nss: nz(g.nss),
        emergency_contact: nz(g.emergencyContact), emergency_phone: nz(g.emergencyPhone), blood_type: nz(g.bloodType),
        health_notes: nz(g.healthNotes), shirt_size: nz(g.shirtSize), termination_date: g.terminationDate,
        contract_type: nz(p.c?.contractType ?? ''), bank: nz(p.c?.bank ?? ''),
      };
      if (p.c?.payMethod) data.pay_method = p.c.payMethod;
      // Nunca se borra con celdas vacías. Al conservar, solo se llena lo que en la app está vacío (y no se cambian nombre ni estatus).
      const ex = p.existing;
      if (ex) for (const k of Object.keys(data)) {
        const empty = (v: unknown) => v === null || v === undefined || v === '';
        if (empty(data[k]) || (mode === 'conservar' && !empty(ex[k]))) delete data[k];
      }
      if (ex && mode === 'conservar') { delete data.full_name; if (p.c?.payMethod && ex.pay_method) delete data.pay_method; }
      const state = g.active ? 'activo' : 'baja';
      const changeState = ex && mode === 'reemplazar' && ex.state !== state;
      let id = ex?.id;
      if (ex && Object.keys(data).length === 0 && !changeState && !(canPay && p.c?.importPay)) { out.push(`= Sin cambios: ${ex.full_name}`); continue; }
      const r = ex
        ? await supabase.from('employees').update({ ...data, ...(changeState ? { state } : {}) }).eq('id', ex.id).select('id')
        : await supabase.from('employees').insert({ ...data, company_id: p.companyId, department_id: p.deptId, state }).select('id');
      if (r.error || !r.data?.length) { out.push(`✗ ${g.fullName}: ${r.error?.message ?? 'sin permiso'}`); continue; }
      id = (r.data[0] as { id: string }).id;
      let line = `${ex ? `↻ Actualizado (${mode === 'conservar' ? 'solo campos vacíos' : 'reemplazando'})` : '+ Creado'}: ${ex?.full_name ?? g.fullName}${ex && normName(ex.full_name) !== normName(g.fullName) ? ` ← "${g.fullName}"` : ''}`;
      // Pago por hora (solo contrato "Por horas") con su historial: anterior desde el ingreso, actual desde el último aumento.
      if (canPay && p.c?.importPay && p.c.hourlyCents) {
        const exc = await supabase.from('compensation_concepts').select('effective_from').eq('employee_id', id).eq('concept_key', 'hora');
        const have = new Set(((exc.data ?? []) as { effective_from: string }[]).map(x => x.effective_from));
        const rows = [];
        if (mode === 'conservar' && have.size > 0) { out.push(`${line} · pago: se conserva el que ya capturaste`); continue; }
        const curFrom = p.c.lastRaiseDate ?? g.hireDate ?? today();
        if (p.c.previousHourlyCents && p.c.lastRaiseDate) {
          const prevFrom = g.hireDate && g.hireDate < p.c.lastRaiseDate ? g.hireDate : null;
          if (prevFrom && !have.has(prevFrom)) rows.push({ effective_from: prevFrom, amount_cents: p.c.previousHourlyCents, reason: 'Importado del Excel (pago anterior)' });
        }
        if (!have.has(curFrom)) rows.push({ effective_from: curFrom, amount_cents: p.c.hourlyCents, reason: `Importado del Excel${p.c.notes ? ` · ${p.c.notes}` : ''}` });
        if (rows.length) {
          const ins = await supabase.from('compensation_concepts').insert(rows.map(x => ({ company_id: p.existing?.company_id ?? p.companyId, employee_id: id,
            concept_key: 'hora', label: 'Pago por hora', kind: 'por_hora', weekdays: [0, 1, 2, 3, 4, 5, 6], ...x })));
          line += ins.error ? ` (pago no importado: ${ins.error.message})` : ` · pago por hora $${(p.c.hourlyCents / 100).toFixed(2)}`;
        }
      } else if (canPay && p.c && !p.c.importPay && p.c.hourlyCents) line += ` · ⚠ contrato "${p.c.contractType}": captura su pago en el expediente`;
      out.push(line);
    }
    setBusy(false); setResult(out); onDone();
  }

  const cnt = (f: (p: Plan) => boolean) => plans?.filter(f).length ?? 0;
  return (
    <Modal wide title="Importar colaboradores" onClose={onClose}>
      {!result && <>
        <p className="text-sm text-slate-600">Sube el Excel de colaboradores (hojas <b>Datos Generales</b> y <b>Confidencial</b>), en .xlsx, .xls o .csv. Si está en Google Sheets: Archivo → Descargar → Microsoft Excel.
          Se reconoce a cada persona por CURP o por nombre. Nada se guarda hasta que confirmes.</p>
        <input type="file" accept=".xlsx,.xls,.csv" onChange={e => e.target.files?.[0] && read(e.target.files[0])} />
      </>}
      {msg && <p className="rounded bg-amber-50 p-2 text-sm text-amber-800">{msg}</p>}
      {plans && !result && <>
        <div className="flex flex-wrap gap-4 rounded-lg bg-slate-50 p-3 text-sm">
          <span className="font-medium">Si la persona ya existe en la app:</span>
          <label className="flex items-center gap-1"><input type="radio" checked={mode === 'conservar'} onChange={() => setMode('conservar')} />Conservar lo que ya capturé y solo llenar lo vacío</label>
          <label className="flex items-center gap-1"><input type="radio" checked={mode === 'reemplazar'} onChange={() => setMode('reemplazar')} />Reemplazar con lo del Excel (celdas vacías no borran)</label>
        </div>
        {dupTargets.size > 0 && <p className="rounded bg-red-50 p-2 text-sm text-red-700">Dos filas del Excel apuntan a la misma persona (en rojo). Corrige el empate.</p>}
        <p className="text-sm"><b>{cnt(p => !p.existing && !p.error)}</b> nuevos · <b>{cnt(p => !!p.existing && !p.error)}</b> a actualizar · <b className="text-amber-700">{cnt(p => !!p.error)}</b> con pendientes
          {!canPay && <span className="text-slate-500"> · tu perfil no importa pagos (solo datos generales)</span>}</p>
        <div className="max-h-[55vh] overflow-auto rounded border">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-slate-100 text-slate-500"><tr><th className="px-2 py-1">Nombre en el Excel</th><th>Se empata con</th><th>Puesto</th><th>Sucursal</th><th>Estatus</th>{canPay && <th>Pago</th>}<th>Avisos</th></tr></thead>
            <tbody>{plans.map((p, i) => (
              <tr key={i} className={`border-t align-top ${p.existing && dupTargets.has(p.existing.id) ? 'bg-red-50' : p.error ? 'bg-amber-50' : p.match === 'parecido' || (!p.existing && p.similar.length) ? 'bg-blue-50' : ''}`}>
                <td className="px-2 py-1 font-medium">{p.g.fullName}</td>
                <td className="px-2 py-1">
                  <select className="max-w-[14rem] rounded border px-1" value={p.existing?.id ?? ''} onChange={e => setTarget(i, e.target.value)}>
                    <option value="">+ Crear persona nueva</option>
                    {p.similar.length > 0 && <optgroup label="Parecidos">{p.similar.map(id => <option key={id} value={id}>{all.find(e => e.id === id)?.full_name}</option>)}</optgroup>}
                    <optgroup label="Todos">{all.map(e => <option key={e.id} value={e.id}>{e.full_name}</option>)}</optgroup>
                  </select>
                  <span className={`block text-[11px] ${p.match === 'parecido' || (!p.existing && p.similar.length) ? 'font-medium text-blue-700' : 'text-slate-400'}`}>
                    {!p.existing && p.similar.length > 1 ? `hay ${p.similar.length} parecidos: elige o crea nueva` : MATCH_LABEL[p.match]}</span>
                </td>
                <td className="px-2 py-1">{p.g.jobTitle} <span className="text-slate-400">· {p.g.isCoach ? 'Coach' : 'Staff'}</span></td>
                <td className="px-2 py-1">{p.existing ? cos.find(c => c.id === p.companyId)?.trade_name
                  : <select className="rounded border px-1" value={p.companyId} onChange={e => setCompany(i, e.target.value)}>
                    <option value="">{p.g.sede === 'Ambas' ? 'Ambas → elige…' : 'Elige…'}</option>{cos.map(c => <option key={c.id} value={c.id}>{c.trade_name}</option>)}</select>}</td>
                <td className="px-2 py-1">{p.g.active ? 'Activo' : `Inactivo${p.g.terminationDate ? ` (${fmtDateMx(p.g.terminationDate)})` : ''}`}</td>
                {canPay && <td className="px-2 py-1">{p.c?.importPay ? `$${(p.c.hourlyCents! / 100).toFixed(2)}/h` : p.c?.hourlyCents ? <span className="text-amber-700">a mano</span> : '—'}</td>}
                <td className="px-2 py-1 text-amber-700">{[p.error, ...p.g.warnings, ...(canPay ? p.c?.warnings ?? [] : [])].filter(Boolean).join(' · ')}</td>
              </tr>))}</tbody>
          </table>
        </div>
        <button disabled={busy} className={btn} onClick={run}>{busy ? 'Importando…' : 'Importar'}</button>
      </>}
      {result && <>
        <div className="max-h-[55vh] overflow-auto rounded border p-2 text-xs">{result.map((r, i) => <p key={i} className={r.startsWith('✗') ? 'text-red-700' : r.includes('⚠') ? 'text-amber-700' : ''}>{r}</p>)}</div>
        <button className={btn} onClick={onClose}>Listo</button>
      </>}
    </Modal>
  );
}

/** Exportar con el mismo formato (Datos Generales + Confidencial si el perfil ve pagos). */
export async function exportEmployees(companyId: string, canSalary: boolean, canHours: boolean) {
  const XLSX = await import('xlsx');
  let q = supabase.from('employees').select('*').order('external_no', { nullsFirst: false }).order('full_name');
  if (companyId !== 'all') q = q.eq('company_id', companyId);
  const [e, c] = await Promise.all([q, supabase.from('companies').select('id,trade_name')]);
  if (e.error) throw e.error;
  type E = Record<string, string | number | null> & { id: string; company_id: string };
  const emps = (e.data as E[]) ?? []; const cos = (c.data as Co[]) ?? [];
  const sede = (id: string) => { const n = cos.find(x => x.id === id)?.trade_name ?? ''; return /car/i.test(n) ? 'CAR' : /vi[ñn]edos/i.test(n) ? 'Viñedos' : n; };
  const status = (s: unknown) => (s === 'activo' ? 'Activo' : s === 'suspendido' ? 'Suspendido' : 'Inactivo');
  const t = today();
  const gen = [[...GENERAL_HEADERS], ...emps.map((x, i) => [x.external_no ?? i + 1, x.full_name, fmtDateMx(x.birth_date as string), x.job_title ?? '', x.area ?? '',
    sede(x.company_id), fmtDateMx(x.hire_date as string), status(x.state), fmtDateMx(x.termination_date as string), x.address ?? '', x.phone ?? '', x.email ?? '',
    x.curp ?? '', x.rfc ?? '', x.nss ?? '', x.emergency_contact ?? '', x.emergency_phone ?? '', x.blood_type ?? '', x.health_notes ?? '', x.shirt_size ?? ''])];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(gen), 'Datos Generales');

  if (canSalary) {
    const ids = emps.map(x => x.id);
    const [cc, ws] = await Promise.all([
      supabase.from('compensation_concepts').select('employee_id,concept_key,kind,amount_cents,active,effective_from,reason,created_at').in('employee_id', ids)
        .lte('effective_from', t).order('effective_from', { ascending: false }).order('created_at', { ascending: false }),
      canHours ? supabase.from('employee_work_schedules').select('employee_id,blocks,effective_from,created_at').in('employee_id', ids).lte('effective_from', t)
        .order('effective_from', { ascending: false }).order('created_at', { ascending: false }) : Promise.resolve({ data: [], error: null }),
    ]);
    type CC = { employee_id: string; concept_key: string; kind: string; amount_cents: number; active: boolean; effective_from: string; reason: string };
    const concepts = (cc.data as CC[]) ?? [];
    const scheds = (ws.data ?? []) as { employee_id: string; blocks: { start: string; end: string }[] }[];
    const money = (cents: number | null) => (cents == null ? '' : cents / 100);
    const conf = [[...CONFIDENTIAL_HEADERS], ...emps.map(x => {
      const hist = concepts.filter(k => k.employee_id === x.id && k.concept_key === 'hora');
      const cur = hist[0]?.active ? hist[0] : null; const prev = cur ? hist.find(h => h.effective_from < cur.effective_from && h.amount_cents !== cur.amount_cents) : null;
      const sch = scheds.find(s => s.employee_id === x.id);
      const hpw = sch ? Math.round(sch.blocks.reduce((n, b) => n + (+b.end.slice(0, 2) * 60 + +b.end.slice(3)) - (+b.start.slice(0, 2) * 60 + +b.start.slice(3)), 0) / 6) / 10 : null;
      const raise = prev && cur ? cur.effective_from : null;
      const notes = concepts.filter(k => k.employee_id === x.id && k.concept_key !== 'hora' && k.active).map(k => `${k.kind === 'por_dia' ? 'Por día' : k.kind === 'fijo' ? 'Fijo' : 'Base retardo'} $${(k.amount_cents / 100).toFixed(2)}`).join('; ');
      return [x.full_name, x.job_title ?? '', fmtDateMx(x.hire_date as string), status(x.state), seniorityYears(x.hire_date as string | null, t) ?? '', x.contract_type ?? '',
        money(cur?.amount_cents ?? null), hpw ?? '', cur && hpw ? money(monthlyEstimateCents(cur.amount_cents, hpw)) : '',
        fmtDateMx(raise), money(prev?.amount_cents ?? null), prev && cur ? Math.round((cur.amount_cents / prev.amount_cents - 1) * 1000) / 10 + '%' : '',
        raise ? fmtDateMx(addMonthsIso(raise, 6)) : '', x.pay_method === 'transferencia' ? 'Transferencia' : 'Efectivo', x.bank ?? '', notes];
    })];
    const sh = XLSX.utils.aoa_to_sheet(conf);
    for (const col of ['G', 'I', 'K']) for (let r = 2; r <= conf.length; r++) { const c0 = sh[`${col}${r}`]; if (c0 && typeof c0.v === 'number') c0.z = '"$"#,##0.00'; }
    XLSX.utils.book_append_sheet(wb, sh, 'Confidencial');
  }
  XLSX.writeFile(wb, `Colaboradores_ESGILA_${t}.xlsx`);
}
