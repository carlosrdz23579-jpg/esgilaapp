import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { usePersisted } from '../lib/usePersisted';
import { formatMXN } from '../lib/money';
import { computeOwed, todayMx, monthName, type OwedItem } from '../lib/owed';
import { toCents } from './Billing';
import { Photo } from './StudentProfile';

const field = 'rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand';
const btn = 'rounded-lg bg-brand px-4 py-2 text-sm text-white disabled:opacity-50';
const money = (c: number) => formatMXN(c);

interface Session { id: string; company_id: string; opened_by: string; opened_name: string | null; opened_at: string; opened_on: string; opening_cents: number;
  closed_at: string | null; counted_cents: number | null; auto_closed: boolean }
interface Method { id: string; name: string; kind: string }
interface Stu { id: string; full_name: string; family_id: string | null; photo_path: string | null; kind: string; is_active: boolean }
interface Prod { id: string; name: string; category: string; price_cents: number }
interface Sale { id: string; folio: number; student_id: string | null; customer_name: string | null; sold_at: string; total_cents: number; seller_name: string | null;
  created_by: string; session_id: string | null; cancelled_at: string | null; cancel_reason: string | null; note: string | null }
interface Line { sale_id: string; kind: string; description: string; amount_cents: number; base_cents: number; discount_cents: number; surcharge_cents: number }
interface Pay { sale_id: string; payment_method_id: string; amount_cents: number; reference: string | null }

export default function Caja() {
  const { companies, companyId, can, user } = useAuth();
  const [co, setCo] = usePersisted('caja.sucursal', companyId !== 'all' ? companyId : companies[0]?.id ?? '');
  useEffect(() => { if (companyId !== 'all') setCo(companyId); }, [companyId, setCo]);
  const canSell = can('cashbox', 'edit');
  const [tab, setTab] = usePersisted('caja.tab', canSell ? 'cobrar' : 'hoy');
  const [session, setSession] = useState<Session | null>(null); const [methods, setMethods] = useState<Method[]>([]);
  const [msg, setMsg] = useState<string | null>(null); const [opening, setOpening] = useState(''); const [closing, setClosing] = useState(false);
  const loadSession = useCallback(async () => {
    if (!co || !user) return;
    const [s, m] = await Promise.all([
      supabase.from('cash_sessions').select('*').eq('company_id', co).eq('opened_by', user.id).is('closed_at', null).maybeSingle(),
      supabase.from('payment_methods').select('id,name,kind').eq('is_active', true).order('sort')]);
    const ss = s.data as Session | null;
    setSession(ss && ss.opened_on === todayMx() ? ss : null);   // una caja de otro día se cierra sola al abrir/cobrar
    setMethods((m.data as Method[]) ?? []);
  }, [co, user]);
  useEffect(() => { loadSession(); }, [loadSession]);

  async function open() {
    setMsg(null); const { error } = await supabase.rpc('open_cash', { p_company: co, p_opening: toCents(opening) });
    if (error) setMsg(error.message); else { setOpening(''); loadSession(); }
  }
  const tabs: [string, string][] = [...(canSell ? [['cobrar', 'Cobrar'] as [string, string]] : []), ['hoy', 'Hoy · flujo de caja'], ['adeudos', 'Adeudos']];
  const current = tabs.some(t => t[0] === tab) ? tab : tabs[0][0];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-white p-3 text-sm shadow-sm">
        <select className={field} value={co} onChange={e => setCo(e.target.value)}>{companies.map(c => <option key={c.id} value={c.id}>{c.trade_name}</option>)}</select>
        {canSell && (session
          ? <><span className="rounded-full bg-green-100 px-3 py-1 text-green-800">Caja abierta · {session.opened_name} · desde {new Date(session.opened_at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })} · fondo {money(session.opening_cents)}</span>
            <button className="ml-auto rounded-lg border border-red-300 px-3 py-2 text-red-700" onClick={() => setClosing(true)}>Cerrar caja</button></>
          : <><span className="text-slate-500">Tu caja está cerrada.</span>
            <input className={`${field} w-32`} placeholder="Fondo inicial $" value={opening} onChange={e => setOpening(e.target.value)} />
            <button className={btn} onClick={open}>Abrir caja</button>
            <span className="text-xs text-slate-400">Si no la cierras, se cierra sola al terminar el día.</span></>)}
      </div>
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      {closing && session && <CloseCash session={session} methods={methods} onDone={() => { setClosing(false); loadSession(); }} />}
      <div className="flex flex-wrap gap-1 border-b">{tabs.map(([k, l]) => <button key={k} onClick={() => setTab(k)}
        className={`-mb-px border-b-2 px-3 py-2 text-sm ${current === k ? 'border-brand font-semibold text-brand' : 'border-transparent text-slate-500'}`}>{l}</button>)}</div>
      {co && current === 'cobrar' && (session ? <Cobrar co={co} methods={methods} /> : <p className="rounded-xl border border-dashed bg-white p-4 text-sm text-slate-500">Abre tu caja para cobrar.</p>)}
      {co && current === 'hoy' && <Today co={co} methods={methods} />}
      {co && current === 'adeudos' && <Debts co={co} />}
    </div>
  );
}

// ---------------------------------------------------------------- Cobrar
function Cobrar({ co, methods }: { co: string; methods: Method[] }) {
  const [students, setStudents] = useState<Stu[]>([]); const [q, setQ] = useState(''); const [who, setWho] = useState<Stu | null>(null);
  const [counter, setCounter] = useState(false); const [customer, setCustomer] = useState('');
  const [owed, setOwed] = useState<OwedItem[]>([]); const [sel, setSel] = useState<Set<string>>(new Set()); const [next, setNext] = useState(false);
  const [family, setFamily] = useState<Stu[]>([]); const [credit, setCredit] = useState(0);
  const [products, setProducts] = useState<Prod[]>([]); const [cart, setCart] = useState<{ p: Prod; qty: number }[]>([]);
  const [extra, setExtra] = useState({ description: '', amount: '' }); const [others, setOthers] = useState<{ description: string; amount: number }[]>([]);
  const [pays, setPays] = useState<{ method: string; amount: string; reference: string }[]>([]);
  const [note, setNote] = useState(''); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([supabase.from('students').select('id,full_name,family_id,photo_path,kind,is_active').eq('company_id', co).eq('is_active', true).order('full_name').limit(3000),
      supabase.from('products').select('id,name,category,price_cents').eq('company_id', co).eq('is_active', true).order('category').order('name')])
      .then(([s, p]) => { setStudents((s.data as Stu[]) ?? []); setProducts((p.data as Prod[]) ?? []); });
  }, [co]);
  const reset = () => { setWho(null); setCounter(false); setCustomer(''); setOwed([]); setSel(new Set()); setCart([]); setOthers([]); setPays([]); setNote(''); setFamily([]); setCredit(0); setNext(false); };

  const loadOwed = useCallback(async (st: Stu, includeNext: boolean) => {
    setLoading(true); setMsg(null);
    const fam = st.family_id ? ((await supabase.from('students').select('id,full_name,family_id,photo_path,kind,is_active').eq('family_id', st.family_id).eq('company_id', co).eq('is_active', true)).data as Stu[] ?? []) : [st];
    setFamily(fam);
    const r = await computeOwed({ company: co, studentIds: fam.map(x => x.id), includeNext });
    if (r.error) setMsg(r.error);
    setOwed(r.items); setSel(new Set(r.items.filter(i => !i.future).map(i => i.key)));
    const c = await supabase.rpc('student_credit', { p_student: st.id }); setCredit(Number(c.data ?? 0));
    setLoading(false);
  }, [co]);
  useEffect(() => { if (who) loadOwed(who, next); }, [who, next, loadOwed]);

  const lines = useMemo(() => [
    ...owed.filter(i => sel.has(i.key)).map(i => ({ kind: i.kind, student_id: i.studentId, subscription_id: i.subscriptionId ?? null, month: i.month ?? null, year: i.year ?? null,
      description: i.description, base_cents: i.base, discount_cents: i.discount, surcharge_cents: i.surcharge, amount_cents: i.amount, detail: i.detail })),
    ...cart.map(c => ({ kind: 'producto', student_id: who?.id ?? null, product_id: c.p.id, qty: c.qty, description: `${c.p.name}${c.qty > 1 ? ` × ${c.qty}` : ''}`,
      base_cents: c.p.price_cents * c.qty, discount_cents: 0, surcharge_cents: 0, amount_cents: c.p.price_cents * c.qty })),
    ...others.map(o => ({ kind: 'otro', student_id: who?.id ?? null, description: o.description, base_cents: o.amount, discount_cents: 0, surcharge_cents: 0, amount_cents: o.amount })),
  ], [owed, sel, cart, others, who]);
  const total = lines.reduce((n, l) => n + l.amount_cents, 0);
  const paid = pays.reduce((n, p) => n + toCents(p.amount), 0);
  const over = paid - total;
  useEffect(() => { const ef = methods.find(m => m.kind === 'efectivo') ?? methods[0]; setPays(ps => ps.length ? ps : ef ? [{ method: ef.id, amount: '', reference: '' }] : []); }, [methods]);

  async function charge() {
    setMsg(null);
    if (!lines.length) return setMsg('Agrega algo que cobrar.');
    if (over < 0) return setMsg(`Faltan ${money(-over)} por pagar.`);
    if (over > 0 && !who) return setMsg('En venta de mostrador no puede quedar saldo a favor: ajusta lo pagado.');
    setBusy(true);
    const allLines = over > 0 ? [...lines, { kind: 'saldo_favor', student_id: who!.id, description: 'Saldo a favor', base_cents: over, discount_cents: 0, surcharge_cents: 0, amount_cents: over }] : lines;
    const { data, error } = await supabase.rpc('register_sale', { p_company: co, p_student: who?.id ?? null, p_customer: counter ? customer : null, p_lines: allLines,
      p_payments: pays.filter(p => toCents(p.amount) > 0).map(p => ({ payment_method_id: p.method, amount_cents: toCents(p.amount), reference: p.reference })), p_note: note });
    setBusy(false);
    if (error) return setMsg(error.message);
    setReceipt(data as string); reset();
  }

  if (receipt) return <Receipt saleId={receipt} onNew={() => setReceipt(null)} />;
  const found = q.trim().length >= 2 ? students.filter(s => s.full_name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 10) : [];
  const methodName = (id: string) => methods.find(m => m.id === id)?.name ?? '';
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
      <div className="space-y-3">
        {!who && !counter && <div className="space-y-2 rounded-xl bg-white p-4 shadow-sm">
          <div className="flex gap-2"><input autoFocus className={`${field} flex-1`} placeholder="Buscar alumna por nombre…" value={q} onChange={e => setQ(e.target.value)} />
            <button className="rounded-lg border px-3 py-2 text-sm" onClick={() => setCounter(true)}>Venta de mostrador</button></div>
          {found.map(s => <button key={s.id} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-slate-50" onClick={() => { setWho(s); setQ(''); }}>
            <Photo path={s.photo_path} size={28} />{s.full_name}{s.kind === 'prospecto' && <span className="text-xs text-amber-700">prospecto</span>}</button>)}
        </div>}
        {(who || counter) && <div className="space-y-3 rounded-xl bg-white p-4 shadow-sm">
          <div className="flex items-center gap-3">{who ? <><Photo path={who.photo_path} size={44} /><div><b>{who.full_name}</b>
            {family.length > 1 && <p className="text-xs text-slate-500">Se cobra junto con su familia: {family.filter(f => f.id !== who.id).map(f => f.full_name).join(', ')}</p>}
            {credit > 0 && <p className="text-xs text-green-700">Tiene {money(credit)} a favor</p>}</div></>
            : <input className={`${field} w-64`} placeholder="Nombre del cliente (opcional)" value={customer} onChange={e => setCustomer(e.target.value)} />}
            <button className="ml-auto text-sm text-slate-500" onClick={reset}>Cambiar</button></div>

          {who && <div className="space-y-1">
            <div className="flex items-center gap-2"><h4 className="text-sm font-semibold">Lo que debe hoy</h4>
              <label className="ml-auto flex items-center gap-1 text-xs"><input type="checkbox" checked={next} onChange={e => setNext(e.target.checked)} />Incluir el mes siguiente (pronto pago)</label></div>
            {loading && <p className="text-sm text-slate-400">Calculando…</p>}
            {!loading && !owed.length && <p className="text-sm text-green-700">✓ Sin adeudos.</p>}
            {owed.map(i => <label key={i.key} className={`flex items-start gap-2 rounded-lg border p-2 text-sm ${i.overdue ? 'border-red-200 bg-red-50/50' : ''}`}>
              <input type="checkbox" className="mt-1" checked={sel.has(i.key)} onChange={e => { const n = new Set(sel); if (e.target.checked) n.add(i.key); else n.delete(i.key); setSel(n); }} />
              <span className="flex-1">{i.description}{i.overdue && <span className="ml-1 text-xs text-red-700">vencida</span>}
                <span className="block text-xs text-slate-500">{chargeDetail(i)}</span></span>
              <b>{money(i.amount)}</b></label>)}
          </div>}

          <div className="space-y-1">
            <h4 className="text-sm font-semibold">Productos y otros</h4>
            <select className={`${field} w-full`} value="" onChange={e => { const p = products.find(x => x.id === e.target.value); if (p) setCart(c => c.some(x => x.p.id === p.id) ? c.map(x => x.p.id === p.id ? { ...x, qty: x.qty + 1 } : x) : [...c, { p, qty: 1 }]); }}>
              <option value="">+ Agregar producto…</option>{products.map(p => <option key={p.id} value={p.id}>{p.name} · {money(p.price_cents)}</option>)}</select>
            {cart.map(c => <div key={c.p.id} className="flex items-center gap-2 text-sm"><span className="flex-1">{c.p.name}</span>
              <input type="number" min={1} className="w-16 rounded border px-2 py-1" value={c.qty} onChange={e => setCart(cart.map(x => x.p.id === c.p.id ? { ...x, qty: Math.max(1, +e.target.value) } : x))} />
              <b className="w-24 text-right">{money(c.p.price_cents * c.qty)}</b><button className="text-xs text-red-600" onClick={() => setCart(cart.filter(x => x.p.id !== c.p.id))}>Quitar</button></div>)}
            {others.map((o, i) => <div key={i} className="flex items-center gap-2 text-sm"><span className="flex-1">{o.description}</span><b>{money(o.amount)}</b>
              <button className="text-xs text-red-600" onClick={() => setOthers(others.filter((_, j) => j !== i))}>Quitar</button></div>)}
            <div className="flex gap-2"><input className={`${field} flex-1`} placeholder="Otro concepto (ej. inscripción a evento)" value={extra.description} onChange={e => setExtra({ ...extra, description: e.target.value })} />
              <input className={`${field} w-28`} placeholder="$" value={extra.amount} onChange={e => setExtra({ ...extra, amount: e.target.value })} />
              <button disabled={!extra.description.trim() || !extra.amount} className="text-sm text-brand disabled:text-slate-300" onClick={() => { setOthers([...others, { description: extra.description.trim(), amount: toCents(extra.amount) }]); setExtra({ description: '', amount: '' }); }}>Agregar</button></div>
          </div>
        </div>}
      </div>

      {(who || counter) && <div className="h-fit space-y-3 rounded-xl bg-white p-4 shadow-sm lg:sticky lg:top-4">
        <div className="flex items-baseline justify-between"><span className="text-sm text-slate-500">Total</span><span className="text-2xl font-bold">{money(total)}</span></div>
        <h4 className="text-sm font-semibold">Forma de pago</h4>
        {pays.map((p, i) => <div key={i} className="space-y-1">
          <div className="flex gap-2"><select className={`${field} flex-1`} value={p.method} onChange={e => setPays(pays.map((x, j) => j === i ? { ...x, method: e.target.value } : x))}>
            {methods.filter(m => m.name !== 'Saldo a favor' || credit > 0).map(m => <option key={m.id} value={m.id}>{m.name}{m.name === 'Saldo a favor' ? ` (${money(credit)})` : ''}</option>)}</select>
            <input className={`${field} w-28`} placeholder="$" value={p.amount} onChange={e => setPays(pays.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))} />
            {pays.length > 1 && <button className="text-xs text-red-600" onClick={() => setPays(pays.filter((_, j) => j !== i))}>×</button>}</div>
          {methods.find(m => m.id === p.method)?.kind !== 'efectivo' && <input className={`${field} w-full`} placeholder={`Referencia de ${methodName(p.method).toLowerCase()} (opcional)`}
            value={p.reference} onChange={e => setPays(pays.map((x, j) => j === i ? { ...x, reference: e.target.value } : x))} />}
        </div>)}
        <div className="flex gap-3 text-xs"><button className="text-brand" onClick={() => setPays([...pays, { method: methods[0]?.id ?? '', amount: '', reference: '' }])}>+ Otra forma de pago</button>
          <button className="text-brand" onClick={() => setPays(pays.map((x, j) => j === 0 ? { ...x, amount: ((total - pays.slice(1).reduce((n, y) => n + toCents(y.amount), 0)) / 100).toFixed(2) } : x))}>Poner el total</button></div>
        {paid > 0 && <p className={`text-sm ${over < 0 ? 'text-red-700' : over > 0 ? 'text-green-700' : 'text-slate-600'}`}>
          {over < 0 ? `Faltan ${money(-over)}` : over > 0 ? (who ? `Quedan ${money(over)} a favor de ${who.full_name}` : `Sobran ${money(over)}: da cambio y ajusta lo pagado`) : 'Pago exacto'}</p>}
        <input className={`${field} w-full`} placeholder="Nota (opcional)" value={note} onChange={e => setNote(e.target.value)} />
        <button disabled={busy || !lines.length || over < 0} className={`${btn} w-full py-3 text-base`} onClick={charge}>{busy ? 'Cobrando…' : `Cobrar ${money(total)}`}</button>
        {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
        <p className="text-xs text-slate-500">Si paga en efectivo y da de más, pon sólo lo que se queda (el total) y entrega el cambio.</p>
      </div>}
    </div>
  );
}

function chargeDetail(i: OwedItem) {
  const d = i.detail as { adjustments?: { label: string; amount: number }[]; sibling?: number; early?: number; surchargeBps?: number; becaLost?: boolean; paidBefore?: number };
  if (i.kind === 'cambio_plan') return `Diferencia contra lo ya pagado (${money(Number(d.paidBefore ?? 0))})`;
  if (i.kind === 'anualidad') return 'Anualidad del ciclo escolar';
  const parts = [`Precio ${money(i.base)}`];
  for (const a of d.adjustments ?? []) parts.push(`${a.label} ${money(a.amount)}`);
  if (d.sibling) parts.push(`hermanos ${money(d.sibling)}`);
  if (d.early) parts.push(`pronto pago ${money(d.early)}`);
  if (d.becaLost) parts.push('pierde la beca por pagar con recargo');
  if (i.surcharge) parts.push(`recargo ${(d.surchargeBps ?? 0) / 100} % +${money(i.surcharge)}`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------- Recibo
function Receipt({ saleId, onNew }: { saleId: string; onNew: () => void }) {
  const { companies } = useAuth();
  const [s, setS] = useState<Sale | null>(null); const [lines, setLines] = useState<Line[]>([]); const [pays, setPays] = useState<(Pay & { name: string })[]>([]);
  const [student, setStudent] = useState<string>(''); const [co, setCo] = useState('');
  useEffect(() => {
    (async () => {
      const r = await supabase.from('sales').select('*').eq('id', saleId).single(); const sale = r.data as Sale & { company_id: string }; setS(sale); setCo(sale.company_id);
      const [l, p, m] = await Promise.all([supabase.from('sale_lines').select('*').eq('sale_id', saleId), supabase.from('sale_payments').select('*').eq('sale_id', saleId),
        supabase.from('payment_methods').select('id,name')]);
      setLines((l.data as Line[]) ?? []); setPays(((p.data as Pay[]) ?? []).map(x => ({ ...x, name: (m.data ?? []).find(y => y.id === x.payment_method_id)?.name ?? '' })));
      if (sale.student_id) { const st = await supabase.from('students').select('full_name').eq('id', sale.student_id).single(); setStudent(st.data?.full_name ?? ''); }
    })();
  }, [saleId]);
  if (!s) return null;
  return (
    <div className="mx-auto max-w-md space-y-3 rounded-xl bg-white p-6 text-sm shadow-sm print:shadow-none">
      <div className="text-center"><p className="font-semibold">{companies.find(c => c.id === co)?.trade_name}</p><p className="text-xs text-slate-500">Recibo F {s.folio} · {new Date(s.sold_at).toLocaleString('es-MX')}</p>
        <p>{student || s.customer_name || 'Venta de mostrador'}</p></div>
      <table className="w-full"><tbody>{lines.map((l, i) => <tr key={i} className="border-t align-top"><td className="py-1">{l.description}
        {(l.discount_cents > 0 || l.surcharge_cents > 0) && <span className="block text-xs text-slate-500">{money(l.base_cents)}{l.discount_cents ? ` − ${money(l.discount_cents)}` : ''}{l.surcharge_cents ? ` + recargo ${money(l.surcharge_cents)}` : ''}</span>}</td>
        <td className="py-1 text-right">{money(l.amount_cents)}</td></tr>)}
        <tr className="border-t font-bold"><td className="py-1">Total</td><td className="py-1 text-right">{money(s.total_cents)}</td></tr>
        {pays.map((p, i) => <tr key={i} className="text-xs text-slate-600"><td>{p.name}{p.reference ? ` · ${p.reference}` : ''}</td><td className="text-right">{money(p.amount_cents)}</td></tr>)}</tbody></table>
      <p className="text-center text-xs text-slate-500">Atendió: {s.seller_name}</p>
      <div className="flex justify-center gap-2 print:hidden"><button className="rounded-lg border px-3 py-2" onClick={() => window.print()}>Imprimir</button><button className={btn} onClick={onNew}>Nuevo cobro</button></div>
    </div>
  );
}

// ---------------------------------------------------------------- Hoy · flujo de caja
function Today({ co, methods }: { co: string; methods: Method[] }) {
  const { can, user } = useAuth();
  const [date, setDate] = useState(todayMx()); const [sales, setSales] = useState<Sale[]>([]); const [lines, setLines] = useState<Line[]>([]); const [pays, setPays] = useState<Pay[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]); const [names, setNames] = useState<Record<string, string>>({}); const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [s, ss] = await Promise.all([supabase.from('sales').select('*').eq('company_id', co).eq('sold_on', date).order('folio', { ascending: false }),
      supabase.from('cash_sessions').select('*').eq('company_id', co).eq('opened_on', date).order('opened_at')]);
    const list = (s.data as Sale[]) ?? []; setSales(list); setSessions((ss.data as Session[]) ?? []);
    const ids = list.map(x => x.id);
    const [l, p] = ids.length ? await Promise.all([supabase.from('sale_lines').select('*').in('sale_id', ids), supabase.from('sale_payments').select('*').in('sale_id', ids)]) : [{ data: [] }, { data: [] }];
    setLines((l.data as Line[]) ?? []); setPays((p.data as Pay[]) ?? []);
    const st = [...new Set(list.map(x => x.student_id).filter(Boolean))] as string[];
    if (st.length) { const r = await supabase.from('students').select('id,full_name').in('id', st); setNames(Object.fromEntries((r.data ?? []).map(x => [x.id, x.full_name]))); }
  }, [co, date]);
  useEffect(() => { load(); }, [load]);
  async function cancel(s: Sale) {
    const reason = prompt(`Motivo para cancelar el recibo F ${s.folio}:`); if (!reason) return;
    const { error } = await supabase.rpc('cancel_sale', { p_sale: s.id, p_reason: reason }); if (error) setMsg(error.message); else load();
  }
  const valid = sales.filter(s => !s.cancelled_at); const vIds = new Set(valid.map(s => s.id));
  const byMethod = methods.map(m => ({ m, total: pays.filter(p => vIds.has(p.sale_id) && p.payment_method_id === m.id).reduce((n, p) => n + Number(p.amount_cents), 0) })).filter(x => x.total);
  const byKind = ['mensualidad', 'cambio_plan', 'anualidad', 'producto', 'otro', 'saldo_favor'].map(k => ({ k, total: lines.filter(l => vIds.has(l.sale_id) && l.kind === k).reduce((n, l) => n + Number(l.amount_cents), 0) })).filter(x => x.total);
  const KIND: Record<string, string> = { mensualidad: 'Mensualidades', cambio_plan: 'Cambios de plan', anualidad: 'Anualidades', producto: 'Productos', otro: 'Otros', saldo_favor: 'Saldo a favor (anticipos)' };
  const cashIds = new Set(methods.filter(m => m.kind === 'efectivo').map(m => m.id));
  const cashOf = (sess: Session) => pays.filter(p => cashIds.has(p.payment_method_id) && valid.some(s => s.id === p.sale_id && s.session_id === sess.id)).reduce((n, p) => n + Number(p.amount_cents), 0);
  if (open) return <div className="space-y-2"><button className="text-sm text-brand" onClick={() => setOpen(null)}>← Regresar</button><Receipt saleId={open} onNew={() => setOpen(null)} /></div>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3"><input type="date" className={field} value={date} max={todayMx()} onChange={e => setDate(e.target.value)} />
        <span className="text-lg font-semibold">{money(valid.reduce((n, s) => n + Number(s.total_cents), 0))}</span><span className="text-sm text-slate-500">{valid.length} recibos</span>
        <button className="ml-auto rounded-lg border px-3 py-2 text-sm print:hidden" onClick={() => window.print()}>Imprimir corte</button></div>
      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-xl bg-white p-4 text-sm shadow-sm"><h4 className="mb-1 font-semibold">Por forma de pago</h4>
          {byMethod.map(x => <p key={x.m.id} className="flex justify-between"><span>{x.m.name}</span><b>{money(x.total)}</b></p>)}{!byMethod.length && <p className="text-slate-400">Sin cobros.</p>}</div>
        <div className="rounded-xl bg-white p-4 text-sm shadow-sm"><h4 className="mb-1 font-semibold">Por concepto</h4>
          {byKind.map(x => <p key={x.k} className="flex justify-between"><span>{KIND[x.k]}</span><b>{money(x.total)}</b></p>)}</div>
        <div className="rounded-xl bg-white p-4 text-sm shadow-sm"><h4 className="mb-1 font-semibold">Cajas</h4>
          {sessions.map(s => { const exp = Number(s.opening_cents) + cashOf(s); return <div key={s.id} className="border-t py-1 first:border-0">
            <p className="flex justify-between"><span>{s.opened_name}</span><span className="text-xs">{s.closed_at ? (s.auto_closed ? 'cerrada sola' : 'cerrada') : 'abierta'}</span></p>
            <p className="text-xs text-slate-500">Fondo {money(s.opening_cents)} + efectivo {money(cashOf(s))} = {money(exp)}{s.counted_cents != null ? ` · contó ${money(s.counted_cents)} (${s.counted_cents - exp >= 0 ? '+' : ''}${money(s.counted_cents - exp)})` : ''}</p></div>; })}
          {!sessions.length && <p className="text-slate-400">Nadie abrió caja.</p>}</div>
      </div>
      <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Folio</th><th className="px-3 py-2">Hora</th><th className="px-3 py-2">Alumna / cliente</th>
            <th className="px-3 py-2">Concepto</th><th className="px-3 py-2">Pago</th><th className="px-3 py-2 text-right">Total</th><th className="px-3 py-2">Cobró</th><th className="px-3 py-2"></th></tr></thead>
          <tbody>{sales.map(s => <tr key={s.id} className={`border-t ${s.cancelled_at ? 'text-slate-400 line-through' : ''}`}>
            <td className="px-3 py-1.5"><button className="text-brand" onClick={() => setOpen(s.id)}>F {s.folio}</button></td>
            <td className="px-3 py-1.5">{new Date(s.sold_at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}</td>
            <td className="px-3 py-1.5">{s.student_id ? names[s.student_id] ?? '…' : s.customer_name ?? 'Mostrador'}</td>
            <td className="px-3 py-1.5 text-xs">{lines.filter(l => l.sale_id === s.id).map(l => l.description).join(' · ')}{s.cancelled_at && <span className="block no-underline">Cancelada: {s.cancel_reason}</span>}</td>
            <td className="px-3 py-1.5 text-xs">{pays.filter(p => p.sale_id === s.id).map(p => methods.find(m => m.id === p.payment_method_id)?.name).join(', ')}</td>
            <td className="px-3 py-1.5 text-right">{money(s.total_cents)}</td><td className="px-3 py-1.5 text-xs">{s.seller_name}</td>
            <td className="px-3 py-1.5 text-right">{!s.cancelled_at && (can('cashbox', 'configure') || (s.created_by === user?.id && date === todayMx())) && <button className="text-xs text-red-600" onClick={() => cancel(s)}>Cancelar</button>}</td>
          </tr>)}
            {!sales.length && <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-400">Sin ventas este día.</td></tr>}</tbody>
        </table>
      </div>
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      <p className="text-xs text-slate-500">Esto es el flujo de caja: el dinero que entró este día. Una mensualidad pagada por adelantado entra completa hoy aunque corresponda a otro mes.</p>
    </div>
  );
}

// ---------------------------------------------------------------- Cerrar caja
function CloseCash({ session, methods, onDone }: { session: Session; methods: Method[]; onDone: () => void }) {
  const [cash, setCash] = useState(0); const [counted, setCounted] = useState(''); const [note, setNote] = useState(''); const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      const s = await supabase.from('sales').select('id').eq('session_id', session.id).is('cancelled_at', null); const ids = (s.data ?? []).map(x => x.id);
      if (!ids.length) return setCash(0);
      const cashIds = methods.filter(m => m.kind === 'efectivo').map(m => m.id);
      const p = await supabase.from('sale_payments').select('amount_cents,payment_method_id').in('sale_id', ids);
      setCash((p.data ?? []).filter(x => cashIds.includes(x.payment_method_id)).reduce((n, x) => n + Number(x.amount_cents), 0));
    })();
  }, [session.id, methods]);
  const expected = Number(session.opening_cents) + cash; const diff = counted ? toCents(counted) - expected : 0;
  async function close() {
    const { error } = await supabase.rpc('close_cash', { p_session: session.id, p_counted: counted ? toCents(counted) : null, p_note: note });
    if (error) setMsg(error.message); else onDone();
  }
  return (
    <div className="space-y-2 rounded-xl border-2 border-red-200 bg-white p-4 text-sm shadow-sm">
      <h3 className="font-semibold">Cerrar caja</h3>
      <p>Fondo {money(session.opening_cents)} + efectivo cobrado {money(cash)} = <b>debe haber {money(expected)}</b></p>
      <div className="flex flex-wrap items-end gap-2"><label className="text-xs">Efectivo contado<input autoFocus className={`${field} block w-32`} value={counted} onChange={e => setCounted(e.target.value)} /></label>
        <label className="grow text-xs">Nota<input className={`${field} block w-full`} value={note} onChange={e => setNote(e.target.value)} placeholder="Retiros, diferencias…" /></label>
        <button className="rounded-lg bg-red-600 px-4 py-2 text-white" onClick={close}>Cerrar caja</button><button className="text-slate-500" onClick={onDone}>Cancelar</button></div>
      {counted && <p className={diff === 0 ? 'text-green-700' : 'text-amber-700'}>{diff === 0 ? 'Cuadra exacto.' : diff > 0 ? `Sobran ${money(diff)}` : `Faltan ${money(-diff)}`}</p>}
      {msg && <p className="text-red-700">{msg}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- Adeudos
function Debts({ co }: { co: string }) {
  const [rows, setRows] = useState<{ id: string; name: string; items: OwedItem[] }[] | null>(null); const [q, setQ] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    setRows(null);
    (async () => {
      const subs = await supabase.from('subscriptions').select('student_id').eq('company_id', co).is('cancelled_at', null).not('student_id', 'is', null);
      const ids = [...new Set((subs.data ?? []).map(x => x.student_id as string))];
      const r = await computeOwed({ company: co, studentIds: ids }); if (r.error) setMsg(r.error);
      const st = ids.length ? await supabase.from('students').select('id,full_name').in('id', ids) : { data: [] };
      const nm = new Map((st.data ?? []).map(x => [x.id, x.full_name]));
      setRows(ids.map(id => ({ id, name: nm.get(id) ?? '', items: r.items.filter(i => i.studentId === id) })).filter(x => x.items.length).sort((a, b) => b.items.reduce((n, i) => n + i.amount, 0) - a.items.reduce((n, i) => n + i.amount, 0)));
    })();
  }, [co]);
  if (!rows) return <p className="text-sm text-slate-400">Calculando adeudos…</p>;
  const list = rows.filter(r => !q || r.name.toLowerCase().includes(q.toLowerCase()));
  const total = rows.reduce((n, r) => n + r.items.reduce((m, i) => m + i.amount, 0), 0);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3"><input className={field} placeholder="Buscar alumna" value={q} onChange={e => setQ(e.target.value)} />
        <span className="text-sm">{rows.length} alumnas deben <b>{money(total)}</b> hoy (con recargos del día)</span>
        <button className="ml-auto rounded-lg border px-3 py-2 text-sm print:hidden" onClick={() => window.print()}>Imprimir</button></div>
      <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
        <table className="w-full text-sm"><thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Alumna</th><th className="px-3 py-2">Debe</th><th className="px-3 py-2 text-right">Total hoy</th></tr></thead>
          <tbody>{list.map(r => <tr key={r.id} className="border-t align-top"><td className="px-3 py-1.5 font-medium">{r.name}</td>
            <td className="px-3 py-1.5 text-xs">{r.items.map(i => <span key={i.key} className={`mr-2 inline-block ${i.overdue ? 'text-red-700' : ''}`}>{i.kind === 'anualidad' ? `Anualidad ${i.year}` : `${i.kind === 'cambio_plan' ? 'Cambio de plan ' : ''}${monthName(i.month!.slice(0, 7))}`} {money(i.amount)}</span>)}</td>
            <td className="px-3 py-1.5 text-right font-semibold">{money(r.items.reduce((n, i) => n + i.amount, 0))}</td></tr>)}
            {!list.length && <tr><td colSpan={3} className="px-3 py-6 text-center text-green-700">Nadie debe.</td></tr>}</tbody></table>
      </div>
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      <p className="text-xs text-slate-500">Cuenta las mensualidades desde el mes en que se empezó a cobrar en este sistema (Cobranza → Reglas). En rojo, meses vencidos.</p>
    </div>
  );
}
