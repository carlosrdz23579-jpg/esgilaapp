import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { usePrefs, ACCENTS, shrinkImage, type UiPrefs } from '../lib/prefs';
import { Icon } from './icons';

const urlCache = new Map<string, string>();
/** Foto de perfil (o las iniciales, si no tiene). */
export function Avatar({ path, name, size = 32 }: { path?: string | null; name: string; size?: number }) {
  const [url, setUrl] = useState<string | null>(path ? urlCache.get(path) ?? null : null);
  useEffect(() => {
    if (!path) return setUrl(null);
    if (urlCache.has(path)) return setUrl(urlCache.get(path)!);
    supabase.storage.from('avatars').createSignedUrl(path, 3600 * 12).then(r => { if (r.data?.signedUrl) { urlCache.set(path, r.data.signedUrl); setUrl(r.data.signedUrl); } });
  }, [path]);
  const initials = name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(w => w[0]?.toUpperCase()).join('');
  return url ? <img src={url} alt="" style={{ width: size, height: size }} className="rounded-full object-cover ring-2 ring-white dark:ring-white/10" />
    : <span style={{ width: size, height: size, fontSize: size * 0.38 }} className="grid shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand to-brand/60 font-semibold text-white">{initials || '?'}</span>;
}

/** Panel lateral: mi perfil, apariencia, idioma y cómo se ve mi menú. */
export default function ProfilePanel({ modules, onClose }: { modules: { key: string; label: string }[]; onClose: () => void }) {
  const { user, reload, signOut } = useAuth(); const { prefs, set, reset } = usePrefs();
  const [name, setName] = useState(user?.full_name ?? ''); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);

  async function photo(f: File) {
    if (!user) return; setBusy(true); setMsg(null);
    const path = `${user.id}/${Date.now()}.jpg`;
    const up = await supabase.storage.from('avatars').upload(path, await shrinkImage(f, 500), { contentType: 'image/jpeg' });
    if (up.error) { setBusy(false); return setMsg(up.error.message); }
    const r = await supabase.rpc('set_my_profile', { p_avatar_path: path }); setBusy(false);
    if (r.error) setMsg(r.error.message); else reload();
  }
  async function saveName() {
    if (!name.trim() || name === user?.full_name) return;
    const r = await supabase.rpc('set_my_profile', { p_full_name: name }); if (r.error) setMsg(r.error.message); else reload();
  }
  async function removePhoto() { const r = await supabase.rpc('set_my_profile', { p_avatar_path: '' }); if (!r.error) reload(); }

  // orden personal del menú
  const order = [...modules].sort((a, b) => (prefs.menuOrder.indexOf(a.key) + 1 || 99) - (prefs.menuOrder.indexOf(b.key) + 1 || 99));
  const move = (from: number, to: number) => { if (to < 0 || to >= order.length) return; const o = order.map(m => m.key); const [x] = o.splice(from, 1); o.splice(to, 0, x); set({ menuOrder: o, menuMode: 'personal' }); };
  const toggleHidden = (k: string) => set({ menuHidden: prefs.menuHidden.includes(k) ? prefs.menuHidden.filter(x => x !== k) : [...prefs.menuHidden, k] });

  const seg = <K extends keyof UiPrefs>(k: K, opts: [UiPrefs[K], string, string?][]) => (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${opts.length}, minmax(0, 1fr))` }}>{opts.map(([v, l, ic]) =>
      <button key={String(v)} onClick={() => set({ [k]: v } as Partial<UiPrefs>)}
        className={`flex flex-col items-center gap-1 rounded-xl border px-2 py-2.5 text-xs transition ${prefs[k] === v ? 'border-brand bg-brand/10 font-semibold text-brand' : 'border-slate-200 hover:bg-slate-50'}`}>
        {ic && <Icon name={ic} className="h-5 w-5" />}{l}</button>)}</div>);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30 backdrop-blur-[2px]" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="flex h-full w-full max-w-md flex-col overflow-y-auto bg-[rgb(var(--bg))] shadow-2xl">
        <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-5 py-4">
          <h3 className="text-lg font-semibold">Mi perfil y apariencia</h3>
          <button className="ml-auto rounded-lg p-1.5 text-slate-500 hover:bg-slate-100" onClick={onClose} aria-label="Cerrar"><Icon name="x" /></button>
        </div>
        <div className="space-y-4 p-5">
          <section className="rounded-2xl bg-white p-4 shadow-sm">
            <div className="flex items-center gap-4">
              <div className="relative"><Avatar path={user?.avatar_path} name={user?.full_name || user?.email || ''} size={72} />
                <label className="absolute -bottom-1 -right-1 grid h-8 w-8 cursor-pointer place-items-center rounded-full bg-brand text-white shadow" title="Cambiar foto">
                  <Icon name="camera" className="h-4 w-4" /><input type="file" accept="image/*" hidden onChange={e => e.target.files?.[0] && photo(e.target.files[0])} /></label></div>
              <div className="min-w-0 flex-1 space-y-1">
                <input className="w-full rounded-lg border border-slate-200 px-2 py-1.5 font-medium" value={name} onChange={e => setName(e.target.value)} onBlur={saveName} />
                <p className="truncate text-xs text-slate-500">{user?.email} · <span className="capitalize">{user?.role}</span></p>
                {busy && <p className="text-xs text-slate-500">Subiendo foto…</p>}
                {user?.avatar_path && <button className="text-xs text-slate-500 hover:text-red-600" onClick={removePhoto}>Quitar foto</button>}
              </div>
            </div>
            {msg && <p className="mt-2 rounded bg-red-50 p-2 text-xs text-red-700">{msg}</p>}
          </section>

          <section className="space-y-3 rounded-2xl bg-white p-4 shadow-sm">
            <h4 className="flex items-center gap-2 text-sm font-semibold"><Icon name="palette" className="h-4 w-4 text-brand" />Apariencia</h4>
            <div className="space-y-1.5"><p className="text-xs text-slate-500">Tema</p>
              {seg('theme', [['claro', 'Claro', 'sun'], ['oscuro', 'Oscuro', 'moon'], ['sistema', 'Como mi equipo', 'monitor']])}</div>
            <div className="space-y-1.5"><p className="text-xs text-slate-500">Tamaño de letra</p>
              {seg('fontSize', [['chica', 'Chica'], ['normal', 'Normal'], ['grande', 'Grande'], ['muy_grande', 'Muy grande']])}</div>
            <div className="space-y-1.5"><p className="text-xs text-slate-500">Color</p>
              <div className="flex flex-wrap gap-2">{Object.entries(ACCENTS).map(([k, a]) =>
                <button key={k} onClick={() => set({ accent: k })} title={a.label} style={{ background: `rgb(${a.rgb})` }}
                  className={`grid h-9 w-9 place-items-center rounded-full text-white transition ${prefs.accent === k ? 'ring-2 ring-offset-2 ring-offset-white dark:ring-offset-[rgb(var(--surface))]' : 'opacity-80 hover:opacity-100'}`}
                  >{prefs.accent === k && <Icon name="check" className="h-4 w-4" />}</button>)}</div></div>
            <label className="flex items-center justify-between text-sm"><span>Menú angosto (sólo íconos)</span>
              <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--brand))]" checked={prefs.compactMenu} onChange={e => set({ compactMenu: e.target.checked })} /></label>
          </section>

          <section className="space-y-2 rounded-2xl bg-white p-4 shadow-sm">
            <h4 className="flex items-center gap-2 text-sm font-semibold"><Icon name="globe" className="h-4 w-4 text-brand" />Idioma</h4>
            <div className="grid grid-cols-2 gap-1.5">
              <button className="rounded-xl border border-brand bg-brand/10 px-3 py-2 text-sm font-semibold text-brand">Español</button>
              <button disabled className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-400" title="Próximamente">English · pronto</button></div>
          </section>

          <section className="space-y-2 rounded-2xl bg-white p-4 shadow-sm">
            <h4 className="flex items-center gap-2 text-sm font-semibold"><Icon name="list" className="h-4 w-4 text-brand" />Mi menú</h4>
            {seg('menuMode', [['grupos', 'Por secciones'], ['personal', 'En mi orden']])}
            <p className="text-xs text-slate-500">{prefs.menuMode === 'personal' ? 'Arrastra para ordenar.' : 'Elige "En mi orden" para acomodarlo como quieras.'} El ojo oculta lo que no usas (lo puedes volver a mostrar aquí).</p>
            <ul className="space-y-1">{order.map((m, i) => <li key={m.key} draggable onDragStart={() => setDrag(i)} onDragOver={e => e.preventDefault()}
              onDrop={() => { if (drag !== null) move(drag, i); setDrag(null); }}
              className={`flex items-center gap-2 rounded-lg border border-slate-200 px-2 py-1.5 text-sm ${prefs.menuHidden.includes(m.key) ? 'opacity-50' : ''} ${drag === i ? 'border-brand' : ''}`}>
              <Icon name="grip" className="h-4 w-4 cursor-grab text-slate-400" /><span className="flex-1">{m.label}</span>
              <button className="text-slate-400 hover:text-slate-700" onClick={() => move(i, i - 1)} aria-label="Subir"><Icon name="up" className="h-4 w-4" /></button>
              <button className="text-slate-400 hover:text-slate-700" onClick={() => move(i, i + 1)} aria-label="Bajar"><Icon name="down" className="h-4 w-4" /></button>
              <button className="text-slate-400 hover:text-slate-700" onClick={() => toggleHidden(m.key)} title={prefs.menuHidden.includes(m.key) ? 'Mostrar' : 'Ocultar'}>
                <Icon name={prefs.menuHidden.includes(m.key) ? 'eyeOff' : 'eye'} className="h-4 w-4" /></button></li>)}</ul>
          </section>

          <div className="flex items-center justify-between px-1">
            <button className="text-xs text-slate-500 hover:text-slate-800" onClick={() => confirm('¿Regresar la apariencia y el menú a como venían?') && reset()}>Restablecer apariencia</button>
            <button className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm text-red-600 hover:bg-red-50" onClick={signOut}><Icon name="logout" className="h-4 w-4" />Cerrar sesión</button>
          </div>
        </div>
      </div>
    </div>
  );
}
