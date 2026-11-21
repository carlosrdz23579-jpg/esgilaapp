// Carga y evalúa la asistencia (checadas + horario + excepciones + revisiones) de una empresa en un rango.
// La usan Asistencia (para revisar) y Nómina (para calcular): una sola forma de llegar a los mismos días.
import { supabase } from './supabase';
import { blocksForDate, reviewDay, type WeeklyBlock, type DayException, type Review, type ReviewKind, type ReviewedDay } from '@domain/attendance';

export interface EmpLite { id: string; full_name: string; company_id: string; state: string; work_days?: number[]; department_id?: string; group_id?: string | null }
export interface EmpAttendance { emp: EmpLite; hasSchedule: boolean; days: ReviewedDay[]; byDate: Record<string, string[]> }

export const addDays = (iso: string, n: number) => {
  const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + n)); return d.toISOString().slice(0, 10);
};

export async function loadAttendance(companyId: string, emps: EmpLite[], from: string, to: string): Promise<EmpAttendance[]> {
  const [co, ws, sx, rv] = await Promise.all([
    supabase.from('companies').select('late_tolerance_min').eq('id', companyId).single(),
    supabase.from('employee_work_schedules').select('employee_id,blocks,effective_from,created_at').eq('company_id', companyId).lte('effective_from', to)
      .order('effective_from', { ascending: false }).order('created_at', { ascending: false }),
    supabase.from('schedule_exceptions').select('employee_id,date,kind,blocks,replaces_base').eq('company_id', companyId).is('cancelled_at', null).gte('date', from).lte('date', to),
    supabase.from('attendance_reviews').select('employee_id,date,kind,times,reason').eq('company_id', companyId).is('cancelled_at', null).gte('date', from).lte('date', to),
  ]);
  const err = co.error ?? ws.error ?? sx.error ?? rv.error; if (err) throw err;
  const tol = (co.data as { late_tolerance_min: number }).late_tolerance_min;
  const punches = await Promise.all(emps.map(e => supabase.rpc('employee_punches', { p_employee: e.id, p_from: from, p_to: to })));
  const pErr = punches.find(p => p.error)?.error; if (pErr) throw pErr;
  return emps.map((emp, k) => {
    const byDate: Record<string, string[]> = {};
    for (const p of (punches[k].data as { date: string; times: string[] }[]) ?? []) byDate[p.date] = [...(byDate[p.date] ?? []), ...p.times];
    const scheds = ((ws.data ?? []) as { employee_id: string; blocks: WeeklyBlock[]; effective_from: string }[]).filter(s => s.employee_id === emp.id);
    const exs: DayException[] = ((sx.data ?? []) as { employee_id: string; date: string; kind: DayException['kind']; blocks: DayException['blocks']; replaces_base: boolean }[])
      .filter(x => x.employee_id === emp.id).map(x => ({ date: x.date, kind: x.kind, blocks: x.blocks, replacesBase: x.replaces_base }));
    const revs: Review[] = ((rv.data ?? []) as { employee_id: string; date: string; kind: ReviewKind; times: string[] | null; reason: string }[])
      .filter(r => r.employee_id === emp.id).map(r => ({ date: r.date, kind: r.kind, times: r.times ?? undefined, reason: r.reason }));
    const days: ReviewedDay[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const sched = scheds.find(s => s.effective_from <= d);
      days.push(reviewDay(d, byDate[d] ?? [], blocksForDate(d, sched?.blocks ?? [], exs), tol, revs));
    }
    return { emp, hasSchedule: scheds.length > 0, days, byDate };
  });
}
