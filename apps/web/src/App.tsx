import { useAuth } from './lib/auth';
import Login from './components/Login';
import Shell from './components/Shell';

export default function App() {
  const { loading, session, user, signOut } = useAuth();
  if (loading) return <div className="p-8 text-slate-500">Cargando…</div>;
  if (!session) return <Login />;
  if (!user || user.status !== 'active') {
    return (
      <div className="grid min-h-screen place-items-center p-4">
        <div className="max-w-sm space-y-3 rounded-2xl bg-white p-6 text-center shadow">
          <h1 className="text-lg font-semibold">Acceso pendiente</h1>
          <p className="text-sm text-slate-600">
            {user?.status === 'suspended' ? 'Tu cuenta está suspendida.' : 'Tu solicitud espera la autorización del director o administrador.'}
          </p>
          <button className="text-sm text-brand" onClick={signOut}>Cerrar sesión</button>
        </div>
      </div>
    );
  }
  return <Shell />;
}
