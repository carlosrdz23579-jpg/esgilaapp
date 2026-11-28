import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { supabase } from './supabase';
import { useAuth } from './auth';

/** Preferencias de apariencia de cada usuario. Se guardan en el navegador (para que no parpadee)
 *  y en su cuenta (para que se vean igual en cualquier computadora o celular). */
export interface UiPrefs {
  theme: 'claro' | 'oscuro' | 'sistema';
  fontSize: 'chica' | 'normal' | 'grande' | 'muy_grande';
  accent: string;
  language: 'es' | 'en';
  compactMenu: boolean;
  menuMode: 'grupos' | 'personal';
  menuOrder: string[];
  menuHidden: string[];
  tabs: Record<string, string[]>;       // orden de pestañas por módulo
}
export const ACCENTS: Record<string, { label: string; rgb: string }> = {
  esgila: { label: 'Morado ESGILA', rgb: '147 51 234' },
  azul: { label: 'Azul', rgb: '37 99 235' },
  rosa: { label: 'Rosa', rgb: '219 39 119' },
  esmeralda: { label: 'Esmeralda', rgb: '5 150 105' },
  naranja: { label: 'Naranja', rgb: '234 88 12' },
  grafito: { label: 'Grafito', rgb: '71 85 105' },
};
const DEFAULTS: UiPrefs = { theme: 'claro', fontSize: 'normal', accent: 'esgila', language: 'es', compactMenu: false, menuMode: 'grupos', menuOrder: [], menuHidden: [], tabs: {} };
const KEY = 'esgila:ui';

interface Ctx { prefs: UiPrefs; set: (p: Partial<UiPrefs>) => void; reset: () => void }
const PrefsCtx = createContext<Ctx>({ prefs: DEFAULTS, set: () => {}, reset: () => {} });
export const usePrefs = () => useContext(PrefsCtx);

function apply(p: UiPrefs) {
  const d = document.documentElement;
  const dark = p.theme === 'oscuro' || (p.theme === 'sistema' && matchMedia('(prefers-color-scheme: dark)').matches);
  d.classList.toggle('dark', dark);
  d.dataset.font = p.fontSize;
  d.style.setProperty('--brand', (ACCENTS[p.accent] ?? ACCENTS.esgila).rgb);
  d.lang = p.language;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#11101a' : '#f6f5fb');
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [prefs, setPrefs] = useState<UiPrefs>(() => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return DEFAULTS; } });
  const timer = useRef<number>();
  // al entrar, lo guardado en la cuenta manda
  useEffect(() => {
    const saved = (user as unknown as { ui_prefs?: Partial<UiPrefs> } | null)?.ui_prefs;
    if (saved && Object.keys(saved).length) setPrefs(p => ({ ...p, ...saved }));
  }, [user]);
  useEffect(() => {
    apply(prefs); localStorage.setItem(KEY, JSON.stringify(prefs));
    if (prefs.theme !== 'sistema') return;
    const mq = matchMedia('(prefers-color-scheme: dark)'); const h = () => apply(prefs);
    mq.addEventListener('change', h); return () => mq.removeEventListener('change', h);
  }, [prefs]);
  const set = useCallback((p: Partial<UiPrefs>) => {
    setPrefs(cur => {
      const next = { ...cur, ...p };
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => { supabase.rpc('set_my_profile', { p_prefs: next }).then(() => {}); }, 600);
      return next;
    });
  }, []);
  const reset = useCallback(() => set(DEFAULTS), [set]);
  return <PrefsCtx.Provider value={{ prefs, set, reset }}>{children}</PrefsCtx.Provider>;
}

/** Reduce una imagen (para fotos) antes de subirla. */
export async function shrinkImage(file: File, max = 600): Promise<Blob> {
  try {
    const img = await createImageBitmap(file); const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return await new Promise<Blob>(res => c.toBlob(b => res(b ?? file), 'image/jpeg', 0.86));
  } catch { return file; }
}
