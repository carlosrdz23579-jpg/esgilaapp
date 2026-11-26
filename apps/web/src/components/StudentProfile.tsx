import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';

const field = 'rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand';
const todayMx = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });

export interface StuFull { id: string; company_id: string; evo_id: string | null; full_name: string; phone: string | null; birth_date: string | null;
  enrolled_on: string | null; is_active: boolean; email?: string | null; gender?: string | null; nickname?: string | null; curp?: string | null;
  guardian_name?: string | null; guardian_phone?: string | null; notes?: string | null; source?: string | null; photo_path?: string | null;
  kind?: 'alumna' | 'prospecto'; became_student_on?: string | null }

export const GENDERS: [string, string][] = [['femenino', 'Femenino'], ['masculino', 'Masculino'], ['otro', 'Otro']];
export const SOURCES = ['Recomendación', 'Redes sociales', 'Pasó por la escuela', 'Hermana inscrita', 'Evento / exhibición', 'Otro'];

/** Sube la foto (se reduce a 800 px para que pese poco) y la liga a la alumna. */
export async function uploadPhoto(st: { id: string; company_id: string }, file: File): Promise<string | null> {
  let blob: Blob = file;
  try {
    const img = await createImageBitmap(file); const k = Math.min(1, 800 / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    blob = await new Promise<Blob>(res => c.toBlob(b => res(b ?? file), 'image/jpeg', 0.85));
  } catch { /* si el navegador no puede reducirla, se sube tal cual */ }
  const path = `${st.company_id}/${st.id}/${Date.now()}.jpg`;
  const up = await supabase.storage.from('fotos-alumnas').upload(path, blob, { contentType: 'image/jpeg' });
  if (up.error) return up.error.message;
  const { error } = await supabase.from('students').update({ photo_path: path, updated_at: new Date().toISOString() }).eq('id', st.id);
  return error?.message ?? null;
}

export function Photo({ path, size = 64 }: { path?: string | null; size?: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return setUrl(null);
    supabase.storage.from('fotos-alumnas').createSignedUrl(path, 3600).then(r => setUrl(r.data?.signedUrl ?? null));
  }, [path]);
  return url ? <img src={url} alt="" style={{ width: size, height: size }} className="rounded-full object-cover" />
    : <div style={{ width: size, height: size }} className="flex items-center justify-center rounded-full bg-slate-200 text-slate-400">🤸</div>;
}

/** Encabezado de la ficha: foto, datos completos (editables) y, si es prospecto, sus clases muestra. */
export default function StudentProfile({ s, onChanged }: { s: StuFull; onChanged: () => void }) {
  const { can } = useAuth();
  const canEdit = can('students', 'configure') || can('billing', 'edit');
  const [st, setSt] = useState<StuFull>(s); const [editing, setEditing] = useState(false); const [f, setF] = useState<StuFull>(s);
  const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { const r = await supabase.from('students').select('*').eq('id', s.id).single(); if (r.data) { setSt(r.data as StuFull); setF(r.data as StuFull); } }, [s.id]);
  useEffect(() => { load(); }, [load]);
  const done = () => { load(); onChanged(); };

  async function save() {
    setBusy(true); setMsg(null);
    const { error } = await supabase.from('students').update({ full_name: f.full_name.trim(), nickname: f.nickname || null, email: f.email?.trim() || null,
      phone: f.phone || null, birth_date: f.birth_date || null, enrolled_on: f.enrolled_on || null, gender: f.gender || null, curp: f.curp?.trim().toUpperCase() || null,
      guardian_name: f.guardian_name || null, guardian_phone: f.guardian_phone || null, source: f.source || null, notes: f.notes || null, updated_at: new Date().toISOString() }).eq('id', s.id);
    setBusy(false);
    if (error) return setMsg(error.message.includes('email') ? 'El correo no es válido.' : error.message.includes('curp') ? 'La CURP debe tener 18 caracteres.' : error.message);
    setEditing(false); done();
  }
  async function photo(file: File) { setBusy(true); const e = await uploadPhoto(st, file); setBusy(false); if (e) setMsg(e); else done(); }
  async function enroll() {
    if (!confirm('¿Inscribir como alumna? Después asígnale su plan y grupo abajo.')) return;
    const { error } = await supabase.from('students').update({ kind: 'alumna', became_student_on: todayMx() }).eq('id', s.id); if (error) setMsg(error.message); else done();
  }
  const row = (l: string, v?: string | null) => <p><span className="text-slate-500">{l}:</span> {v || '—'}</p>;
  const input = (k: keyof StuFull, l: string, type = 'text', cls = 'w-full') => <label className="text-xs">{l}
    <input type={type} className={`${field} block ${cls}`} value={(f[k] as string) ?? ''} onChange={e => setF({ ...f, [k]: e.target.value })} /></label>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start gap-4">
        <div className="text-center"><Photo path={st.photo_path} size={88} />
          {canEdit && <label className="mt-1 block cursor-pointer text-xs text-brand">{busy ? 'Subiendo…' : st.photo_path ? 'Cambiar foto' : 'Agregar foto'}
            <input type="file" accept="image/*" capture="environment" hidden onChange={e => e.target.files?.[0] && photo(e.target.files[0])} /></label>}</div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {st.kind === 'prospecto' ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">Prospecto · clase muestra</span>
              : <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">Alumna</span>}
            {st.nickname && <span className="text-sm text-slate-500">"{st.nickname}"</span>}
            {canEdit && !editing && <button className="ml-auto text-xs text-brand" onClick={() => setEditing(true)}>Editar datos</button>}
            {canEdit && st.kind === 'prospecto' && <button className="rounded-lg bg-green-600 px-3 py-1 text-xs text-white" onClick={enroll}>Inscribir como alumna</button>}
          </div>
          {!editing && <div className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
            {row('Correo', st.email)}{row('Teléfono', st.phone)}{row('Nacimiento', st.birth_date)}
            {row('Género', GENDERS.find(g => g[0] === st.gender)?.[1])}{row('CURP', st.curp)}{row('Inscripción', st.enrolled_on)}
            {row('Mamá/papá o tutor', st.guardian_name)}{row('Teléfono del tutor', st.guardian_phone)}{row('Cómo nos conoció', st.source)}
            {row('ID EVO', st.evo_id)}
            {st.notes && <p className="sm:col-span-3"><span className="text-slate-500">Observaciones:</span> <span className="whitespace-pre-wrap">{st.notes}</span></p>}
          </div>}
        </div>
      </div>
      {editing && <div className="space-y-2 rounded-lg border p-3">
        <div className="grid gap-2 sm:grid-cols-3">
          {input('full_name', 'Nombre completo')}{input('nickname', 'Apodo / cómo le dicen')}{input('email', 'Correo', 'email')}
          {input('phone', 'Teléfono')}{input('birth_date', 'Nacimiento', 'date')}
          <label className="text-xs">Género<select className={`${field} block w-full`} value={f.gender ?? ''} onChange={e => setF({ ...f, gender: e.target.value })}>
            <option value="">—</option>{GENDERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          {input('curp', 'CURP')}{input('enrolled_on', 'Inscripción', 'date')}
          <label className="text-xs">Cómo nos conoció<select className={`${field} block w-full`} value={f.source ?? ''} onChange={e => setF({ ...f, source: e.target.value })}>
            <option value="">—</option>{SOURCES.map(x => <option key={x}>{x}</option>)}</select></label>
          {input('guardian_name', 'Mamá/papá o tutor')}{input('guardian_phone', 'Teléfono del tutor')}
        </div>
        <label className="block text-xs">Observaciones<textarea rows={2} className={`${field} block w-full`} value={f.notes ?? ''} onChange={e => setF({ ...f, notes: e.target.value })} /></label>
        <div className="flex gap-2"><button disabled={busy} className="rounded-lg bg-brand px-3 py-1.5 text-sm text-white" onClick={save}>Guardar</button>
          <button className="text-sm text-slate-500" onClick={() => { setEditing(false); setF(st); }}>Cancelar</button></div>
      </div>}
      {st.kind === 'prospecto' && <TrialClasses s={st} canEdit={canEdit || can('students', 'edit')} />}
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
    </div>
  );
}

interface Trial { id: string; class_id: string | null; date: string; attended: boolean | null; comments: string | null; author_name: string | null; cancelled_at: string | null }
function TrialClasses({ s, canEdit }: { s: StuFull; canEdit: boolean }) {
  const [list, setList] = useState<Trial[]>([]); const [groups, setGroups] = useState<{ id: string; activity: string; start_time: string }[]>([]);
  const [f, setF] = useState({ class_id: '', date: todayMx() }); const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [t, g] = await Promise.all([supabase.from('trial_classes').select('*').eq('student_id', s.id).order('date', { ascending: false }),
      supabase.from('class_groups').select('id,activity,start_time').eq('company_id', s.company_id).eq('is_active', true).order('activity').order('start_time')]);
    setList((t.data as Trial[]) ?? []); setGroups(g.data ?? []);
  }, [s.id, s.company_id]);
  useEffect(() => { load(); }, [load]);
  async function add() {
    const { error } = await supabase.from('trial_classes').insert({ company_id: s.company_id, student_id: s.id, class_id: f.class_id || null, date: f.date });
    if (error) setMsg(error.message); else load();
  }
  async function patch(t: Trial, v: Partial<Trial>) { const { error } = await supabase.from('trial_classes').update(v).eq('id', t.id); if (error) setMsg(error.message); else load(); }
  const g = (id: string | null) => groups.find(x => x.id === id);
  return (
    <div className="space-y-2 rounded-lg bg-amber-50 p-3 text-sm">
      <h4 className="font-semibold">Clase muestra</h4>
      {list.map(t => <div key={t.id} className={`flex flex-wrap items-center gap-2 ${t.cancelled_at ? 'text-slate-400 line-through' : ''}`}>
        <b>{t.date}</b><span>{g(t.class_id) ? `${g(t.class_id)!.activity} ${g(t.class_id)!.start_time}` : 'sin grupo'}</span>
        <span className={t.attended === true ? 'text-green-700' : t.attended === false ? 'text-red-700' : 'text-slate-500'}>{t.attended === true ? '✓ vino' : t.attended === false ? '✗ no vino' : 'pendiente'}</span>
        {canEdit && !t.cancelled_at && <span className="space-x-2 text-xs"><button className="text-green-700" onClick={() => patch(t, { attended: true })}>Vino</button>
          <button className="text-red-700" onClick={() => patch(t, { attended: false })}>No vino</button>
          <button className="text-slate-500" onClick={() => { const c = prompt('Comentarios de la clase muestra:', t.comments ?? ''); if (c !== null) patch(t, { comments: c }); }}>Comentarios</button>
          <button className="text-slate-500" onClick={() => patch(t, { cancelled_at: new Date().toISOString() })}>Cancelar</button></span>}
        {t.comments && <p className="w-full text-xs text-slate-600">{t.comments} <span className="text-slate-400">· {t.author_name}</span></p>}
      </div>)}
      {canEdit && <div className="flex flex-wrap items-end gap-2 text-xs">
        <label>Grupo<select className={`${field} block`} value={f.class_id} onChange={e => setF({ ...f, class_id: e.target.value })}><option value="">Elige…</option>
          {groups.map(x => <option key={x.id} value={x.id}>{x.activity} {x.start_time}</option>)}</select></label>
        <label>Fecha<input type="date" className={`${field} block`} value={f.date} onChange={e => setF({ ...f, date: e.target.value })} /></label>
        <button disabled={!f.class_id} className="rounded-lg bg-brand px-3 py-1.5 text-white disabled:opacity-50" onClick={add}>Agendar clase muestra</button></div>}
      <p className="text-xs text-slate-500">Aparece en el pase de lista de ese grupo y día como "clase muestra". Si se queda, dale "Inscribir como alumna" y asígnale su plan.</p>
      {msg && <p className="text-red-700">{msg}</p>}
    </div>
  );
}
