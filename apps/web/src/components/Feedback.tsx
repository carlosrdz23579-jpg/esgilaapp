import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { usePersisted } from '../lib/usePersisted';

const field = 'rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand';
const btn = 'rounded-lg bg-brand px-4 py-2 text-sm text-white disabled:opacity-50';
const todayMx = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });

const KIND: Record<string, { l: string; cls: string }> = { queja: { l: 'Queja', cls: 'bg-red-100 text-red-700' }, sugerencia: { l: 'Sugerencia', cls: 'bg-sky-100 text-sky-700' },
  felicitacion: { l: 'Felicitación', cls: 'bg-green-100 text-green-700' } };
const STATUS: Record<string, { l: string; cls: string }> = { nueva: { l: 'Nueva', cls: 'bg-amber-100 text-amber-800' }, en_revision: { l: 'En revisión', cls: 'bg-sky-100 text-sky-700' },
  atendida: { l: 'Atendida', cls: 'bg-green-100 text-green-700' }, cerrada: { l: 'Cerrada', cls: 'bg-slate-100 text-slate-600' } };
const AREAS = ['Coach / clase', 'Instalaciones', 'Limpieza', 'Cobranza / pagos', 'Horarios', 'Recepción', 'Uniformes / tienda', 'Eventos', 'Seguridad', 'Otro'];
const CHANNELS = ['En persona', 'WhatsApp', 'Llamada', 'Correo', 'Redes sociales', 'Otro'];
const PRIO: Record<string, string> = { baja: 'Baja', media: 'Media', alta: 'Alta' };

interface FB { id: string; company_id: string; received_on: string; kind: string; area: string; channel: string | null; reporter_name: string | null; reporter_phone: string | null;
  student_id: string | null; employee_id: string | null; description: string; priority: string; status: string; author_name: string | null; created_at: string }
interface Up { id: string; feedback_id: string; status: string | null; comment: string | null; author_name: string | null; created_at: string }

/** Buzón de quejas y sugerencias de los papás: recepción las captura, dirección les da seguimiento. */
export default function Feedback() {
  const { companies, companyId, can } = useAuth();
  const canCreate = can('complaints', 'create') || can('complaints', 'edit');
  const canManage = can('complaints', 'edit');
  const [rows, setRows] = useState<FB[]>([]); const [ups, setUps] = useState<Up[]>([]); const [msg, setMsg] = useState<string | null>(null);
  const [fStatus, setFStatus] = usePersisted('buzon.estado', 'abiertas'); const [fKind, setFKind] = useState('');
  const [adding, setAdding] = useState(false); const [open, setOpen] = useState<FB | null>(null);
  const [names, setNames] = useState<{ st: Record<string, string>; emp: Record<string, string> }>({ st: {}, emp: {} });
  const load = useCallback(async () => {
    let q = supabase.from('parent_feedback').select('*').order('received_on', { ascending: false }).order('created_at', { ascending: false }).limit(500);
    if (companyId !== 'all') q = q.eq('company_id', companyId);
    const { data, error } = await q; if (error) return setMsg(error.message);
    const list = (data as FB[]) ?? []; setRows(list);
    const ids = list.map(x => x.id);
    const u = ids.length ? await supabase.from('parent_feedback_updates').select('*').in('feedback_id', ids).order('created_at') : { data: [] };
    setUps((u.data as Up[]) ?? []);
    const st = [...new Set(list.map(x => x.student_id).filter(Boolean))] as string[]; const em = [...new Set(list.map(x => x.employee_id).filter(Boolean))] as string[];
    const [a, b] = await Promise.all([st.length ? supabase.from('students').select('id,full_name').in('id', st) : Promise.resolve({ data: [] }),
      em.length ? supabase.from('employees').select('id,full_name').in('id', em) : Promise.resolve({ data: [] })]);
    setNames({ st: Object.fromEntries(((a.data ?? []) as { id: string; full_name: string }[]).map(x => [x.id, x.full_name])),
      emp: Object.fromEntries(((b.data ?? []) as { id: string; full_name: string }[]).map(x => [x.id, x.full_name])) });
  }, [companyId]);
  useEffect(() => { load(); }, [load]);

  const list = rows.filter(r => (fStatus === 'todas' || (fStatus === 'abiertas' ? ['nueva', 'en_revision'].includes(r.status) : r.status === fStatus)) && (!fKind || r.kind === fKind));
  const counts = { nueva: rows.filter(r => r.status === 'nueva').length, en_revision: rows.filter(r => r.status === 'en_revision').length };
  const daysOpen = (r: FB) => Math.round((Date.parse(todayMx()) - Date.parse(r.received_on)) / 864e5);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex overflow-hidden rounded-lg border bg-white text-sm">{[['abiertas', `Abiertas (${counts.nueva + counts.en_revision})`], ['nueva', 'Nuevas'], ['en_revision', 'En revisión'],
          ['atendida', 'Atendidas'], ['cerrada', 'Cerradas'], ['todas', 'Todas']].map(([k, l]) =>
          <button key={k} onClick={() => setFStatus(k)} className={`px-3 py-2 ${fStatus === k ? 'bg-brand text-white' : ''}`}>{l}</button>)}</div>
        <select className={field} value={fKind} onChange={e => setFKind(e.target.value)}><option value="">Todo tipo</option>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v.l}</option>)}</select>
        {canCreate && !adding && <button className={`${btn} ml-auto`} onClick={() => setAdding(true)}>+ Registrar queja o sugerencia</button>}
      </div>
      {adding && <NewFeedback onDone={() => { setAdding(false); load(); }} onCancel={() => setAdding(false)} />}
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      <div className="space-y-2">{list.map(r => { const last = ups.filter(u => u.feedback_id === r.id).at(-1); return (
        <button key={r.id} onClick={() => setOpen(r)} className={`block w-full rounded-xl border bg-white p-3 text-left text-sm shadow-sm hover:border-brand ${r.priority === 'alta' && r.status !== 'cerrada' ? 'border-red-300' : ''}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-xs ${KIND[r.kind].cls}`}>{KIND[r.kind].l}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS[r.status].cls}`}>{STATUS[r.status].l}</span>
            {r.priority === 'alta' && <span className="text-xs font-semibold text-red-700">prioridad alta</span>}
            <span className="text-xs text-slate-500">{r.area} · {r.received_on}{['nueva', 'en_revision'].includes(r.status) ? ` · hace ${daysOpen(r)} días` : ''}
              {companyId === 'all' ? ` · ${companies.find(c => c.id === r.company_id)?.trade_name}` : ''}</span>
            <span className="ml-auto text-xs text-slate-500">{r.reporter_name ?? 'Anónimo'}{r.student_id ? ` · ${names.st[r.student_id] ?? ''}` : ''}</span>
          </div>
          <p className="mt-1 line-clamp-2">{r.description}</p>
          {last && <p className="mt-1 text-xs text-slate-500">Último seguimiento: {last.comment ?? STATUS[last.status ?? 'nueva'].l} · {last.author_name}</p>}
        </button>); })}
        {!list.length && <p className="rounded-xl border border-dashed bg-white p-4 text-sm text-slate-500">Nada en esta vista.</p>}</div>
      {open && <Detail r={open} ups={ups.filter(u => u.feedback_id === open.id)} names={names} canManage={canManage} onClose={() => setOpen(null)} onChanged={load} />}
      <p className="text-xs text-slate-500">Recepción registra lo que dicen los papás; quien tenga permiso de Editar en Quejas y sugerencias (dirección) les da seguimiento y las cierra. Nada se borra.</p>
    </div>
  );
}

function NewFeedback({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { companies, companyId } = useAuth();
  const [f, setF] = useState({ company_id: companyId !== 'all' ? companyId : '', received_on: todayMx(), kind: 'queja', area: AREAS[0], channel: CHANNELS[0], reporter_name: '',
    reporter_phone: '', student_id: '', employee_id: '', description: '', priority: 'media' });
  const [students, setStudents] = useState<{ id: string; full_name: string }[]>([]); const [emps, setEmps] = useState<{ id: string; full_name: string }[]>([]);
  const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!f.company_id) return;
    Promise.all([supabase.from('students').select('id,full_name').eq('company_id', f.company_id).eq('is_active', true).order('full_name').limit(3000),
      supabase.from('employees').select('id,full_name').eq('company_id', f.company_id).eq('state', 'activo').order('full_name')])
      .then(([s, e]) => { setStudents(s.data ?? []); setEmps(e.data ?? []); });
  }, [f.company_id]);
  async function save(ev: React.FormEvent) {
    ev.preventDefault(); setBusy(true); setMsg(null);
    const { error } = await supabase.from('parent_feedback').insert({ ...f, reporter_name: f.reporter_name.trim() || null, reporter_phone: f.reporter_phone.trim() || null,
      student_id: f.student_id || null, employee_id: f.employee_id || null, description: f.description.trim() });
    setBusy(false); if (error) return setMsg(error.message); onDone();
  }
  const sel = (k: keyof typeof f, l: string, opts: [string, string][], cls = '') => <label className={`text-xs ${cls}`}>{l}<select className={`${field} block w-full`} value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })}>
    {opts.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>;
  return (
    <form onSubmit={save} className="space-y-2 rounded-xl border-2 border-brand/30 bg-white p-4 shadow-sm">
      <div className="grid gap-2 sm:grid-cols-4">
        {sel('company_id', 'Sucursal', [['', 'Elige…'], ...companies.map(c => [c.id, c.trade_name] as [string, string])])}
        <label className="text-xs">Fecha<input type="date" className={`${field} block w-full`} value={f.received_on} onChange={e => setF({ ...f, received_on: e.target.value })} /></label>
        {sel('kind', 'Tipo', Object.entries(KIND).map(([k, v]) => [k, v.l]))}
        {sel('priority', 'Prioridad', Object.entries(PRIO))}
        {sel('area', 'Área', AREAS.map(a => [a, a]))}
        {sel('channel', 'Cómo llegó', CHANNELS.map(a => [a, a]))}
        <label className="text-xs">Quién lo dice<input className={`${field} block w-full`} placeholder="Mamá de…" value={f.reporter_name} onChange={e => setF({ ...f, reporter_name: e.target.value })} /></label>
        <label className="text-xs">Teléfono<input className={`${field} block w-full`} value={f.reporter_phone} onChange={e => setF({ ...f, reporter_phone: e.target.value })} /></label>
        {sel('student_id', 'Alumna (opcional)', [['', '—'], ...students.map(s => [s.id, s.full_name] as [string, string])], 'sm:col-span-2')}
        {sel('employee_id', 'Se refiere a (opcional)', [['', '—'], ...emps.map(s => [s.id, s.full_name] as [string, string])], 'sm:col-span-2')}
      </div>
      <label className="block text-xs">Qué dijo<textarea required rows={3} className={`${field} block w-full`} value={f.description} onChange={e => setF({ ...f, description: e.target.value })} /></label>
      <div className="flex gap-2"><button disabled={busy || !f.company_id} className={btn}>Registrar</button><button type="button" className="text-sm text-slate-500" onClick={onCancel}>Cancelar</button></div>
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
    </form>
  );
}

function Detail({ r, ups, names, canManage, onClose, onChanged }: { r: FB; ups: Up[]; names: { st: Record<string, string>; emp: Record<string, string> }; canManage: boolean; onClose: () => void; onChanged: () => void }) {
  const [comment, setComment] = useState(''); const [status, setStatus] = useState(''); const [msg, setMsg] = useState<string | null>(null); const [cur, setCur] = useState(r.status);
  async function add() {
    setMsg(null);
    const { error } = await supabase.from('parent_feedback_updates').insert({ feedback_id: r.id, status: status || null, comment: comment.trim() || null });
    if (error) return setMsg(error.message); if (status) setCur(status); setComment(''); setStatus(''); onChanged();
  }
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl space-y-3 rounded-xl bg-white p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex flex-wrap items-center gap-2"><span className={`rounded-full px-2 py-0.5 text-xs ${KIND[r.kind].cls}`}>{KIND[r.kind].l}</span>
          <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS[cur].cls}`}>{STATUS[cur].l}</span><span className="text-xs text-slate-500">prioridad {PRIO[r.priority].toLowerCase()}</span>
          <button className="ml-auto text-slate-500" onClick={onClose}>✕</button></div>
        <p className="whitespace-pre-wrap">{r.description}</p>
        <div className="grid gap-1 text-xs text-slate-600 sm:grid-cols-2">
          <p>Fecha: {r.received_on} · {r.channel ?? ''}</p><p>Área: {r.area}</p>
          <p>Quién: {r.reporter_name ?? 'Anónimo'}{r.reporter_phone ? ` · ${r.reporter_phone}` : ''}</p>{r.student_id && <p>Alumna: {names.st[r.student_id]}</p>}
          {r.employee_id && <p>Se refiere a: {names.emp[r.employee_id]}</p>}<p>Registró: {r.author_name} · {new Date(r.created_at).toLocaleString('es-MX')}</p>
        </div>
        <div className="space-y-1 border-t pt-2"><h4 className="text-sm font-semibold">Seguimiento</h4>
          {ups.map(u => <p key={u.id} className="text-sm"><span className="text-xs text-slate-500">{new Date(u.created_at).toLocaleString('es-MX')} · {u.author_name}</span><br />
            {u.status && <span className={`mr-1 rounded-full px-2 py-0.5 text-xs ${STATUS[u.status].cls}`}>→ {STATUS[u.status].l}</span>}{u.comment}</p>)}
          {!ups.length && <p className="text-sm text-slate-400">Sin seguimiento todavía.</p>}</div>
        <div className="space-y-2 rounded-lg bg-slate-50 p-2">
          <textarea rows={2} className={`${field} w-full`} placeholder="Qué se hizo, con quién se habló, qué se acordó…" value={comment} onChange={e => setComment(e.target.value)} />
          <div className="flex flex-wrap items-center gap-2">{canManage && <select className={field} value={status} onChange={e => setStatus(e.target.value)}>
            <option value="">Sin cambiar estado</option>{Object.entries(STATUS).filter(([k]) => k !== cur).map(([k, v]) => <option key={k} value={k}>Pasar a {v.l.toLowerCase()}</option>)}</select>}
            <button disabled={!comment.trim() && !status} className={btn} onClick={add}>Agregar seguimiento</button></div>
        </div>
        {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      </div>
    </div>
  );
}
