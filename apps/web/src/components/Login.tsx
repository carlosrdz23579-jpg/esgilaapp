import { useState } from 'react';
import { supabase } from '../lib/supabase';

export default function Login() {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [name, setName] = useState(''); const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    if (mode === 'login') {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setMsg(error.message);
    } else {
      const { error } = await supabase.auth.signUp({ email, password, options: { data: { full_name: name } } });
      setMsg(error ? error.message : 'Solicitud enviada. Revisa tu correo si te pide confirmarlo; después el director debe autorizar tu acceso.');
    }
    setBusy(false);
  }

  const input = 'w-full rounded-xl border border-slate-200 px-3.5 py-2.5 focus:outline-none focus:ring-2 focus:ring-brand';
  return (
    <div className="grid min-h-screen place-items-center bg-gradient-to-br from-[#1e1b2e] via-[#2a2245] to-[rgb(var(--brand))] p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-3xl bg-white p-7 shadow-2xl">
        <div className="flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-2xl bg-brand text-xl font-bold text-white shadow-lg shadow-brand/30">E</div>
          <div><p className="text-lg font-semibold leading-tight">ESGILA</p><p className="text-xs text-slate-500">Escuela de Gimnasia de La Laguna</p></div></div>
        <h1 className="pt-2 text-xl font-semibold">{mode === 'login' ? 'Hola de nuevo' : 'Solicitar acceso'}</h1>
        {mode === 'signup' && <input className={input} placeholder="Nombre completo" value={name} onChange={e => setName(e.target.value)} required />}
        <input className={input} type="email" placeholder="Correo" value={email} onChange={e => setEmail(e.target.value)} required />
        <input className={input} type="password" placeholder="Contraseña (mínimo 8)" minLength={8} value={password} onChange={e => setPassword(e.target.value)} required />
        {msg && <p className="text-sm text-slate-600">{msg}</p>}
        <button disabled={busy} className="w-full rounded-xl bg-brand py-2.5 font-semibold text-white shadow-lg shadow-brand/25 transition hover:brightness-110 disabled:opacity-60">
          {mode === 'login' ? 'Entrar' : 'Enviar solicitud'}
        </button>
        <button type="button" className="w-full text-sm text-brand" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setMsg(null); }}>
          {mode === 'login' ? 'Solicitar una cuenta' : 'Ya tengo cuenta'}
        </button>
      </form>
    </div>
  );
}
