import { useEffect, useState } from 'react';
import { supabase } from './supabase';

/** Ocupación por día (0 domingo … 6 sábado) de cada grupo en un mes. El cupo es por día. */
export function useGroupLoads(groupIds: string[], month: string) {
  const [loads, setLoads] = useState<Record<string, number[]>>({});
  const key = groupIds.join(',');
  useEffect(() => {
    if (!groupIds.length) return setLoads({});
    Promise.all(groupIds.map(id => supabase.rpc('group_load', { p_class: id, p_month: `${month.slice(0, 7)}-01` }))).then(rs => {
      const out: Record<string, number[]> = {};
      groupIds.forEach((id, i) => { const arr = [0, 0, 0, 0, 0, 0, 0]; for (const r of (rs[i].data as { weekday: number; taken: number }[]) ?? []) arr[r.weekday] = r.taken; out[id] = arr; });
      setLoads(out);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, month]);
  return loads;
}
export const WD_SHORT = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
/** "Lun 10/12 · Mar 12/12" con los días que tienen alumnas */
export const loadLabel = (l: number[] | undefined, cap: number | null) =>
  (l ?? []).map((n, d) => (n ? `${WD_SHORT[d]} ${n}${cap ? `/${cap}` : ''}` : '')).filter(Boolean).join(' · ') || 'sin alumnas';
export const dayFull = (l: number[] | undefined, cap: number | null, d: number) => cap !== null && (l?.[d] ?? 0) >= cap;
