-- =====================================================================
-- 0014  Concepto 'tarifa_retardo': tarifa por hora de referencia para la rebaja por retardo
-- de quien cobra por día o fijo (no se paga). Ej.: Madelin $300/día, rebaja sobre $65/h.
-- =====================================================================
alter table public.compensation_concepts drop constraint if exists compensation_concepts_kind_check;
alter table public.compensation_concepts add constraint compensation_concepts_kind_check
  check (kind in ('por_hora', 'por_dia', 'fijo', 'tarifa_retardo'));
