import { useEffect, useState } from 'react';

/** Estado que sobrevive a cambiar de módulo o recargar: se guarda en este navegador. */
export function usePersisted<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const k = `esgila:${key}`;
  const [v, setV] = useState<T>(() => {
    try { const raw = localStorage.getItem(k); return raw === null ? initial : (JSON.parse(raw) as T); } catch { return initial; }
  });
  useEffect(() => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento: solo en memoria */ } }, [k, v]);
  return [v, setV];
}
