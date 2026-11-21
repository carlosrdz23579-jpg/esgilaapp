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

  const input = 'w-full rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand';
  return (
    <div className="min-h-screen grid place-items-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl bg-white p-6 shadow">
        <h1 className="text-xl font-semibold">{mode === 'login' ? 'Iniciar sesión' : 'Solicitar acceso'}</h1>
        {mode === 'signup' && <input className={input} placeholder="Nombre completo" value={name} onChange={e => setName(e.target.value)} required />}
        <input className={input} type="email" placeholder="Correo" value={email} onChange={e => setEmail(e.target.value)} required />
        <input className={input} type="password" placeholder="Contraseña (mínimo 8)" minLength={8} value={password} onChange={e => setPassword(e.target.value)} required />
        {msg && <p className="text-sm text-slate-600">{msg}</p>}
        <button disabled={busy} className="w-full rounded-lg bg-brand py-2 font-medium text-white disabled:opacity-60">
          {mode === 'login' ? 'Entrar' : 'Enviar solicitud'}
        </button>
        <button type="button" className="w-full text-sm text-brand" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setMsg(null); }}>
          {mode === 'login' ? 'Solicitar una cuenta' : 'Ya tengo cuenta'}
        </button>
      </form>
    </div>
  );
}
