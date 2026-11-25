-- =====================================================================
-- 0029  Módulo de permiso para alumnas (va solo, igual que 0017: un valor nuevo de
-- enum no puede usarse en la misma transacción). Ejecuta este archivo ANTES de 0030.
--   students  view = ver alumnas · edit = pasar lista · create = escribir notas internas
--             configure = importar de EVO y ajustar clases
-- =====================================================================
alter type app.perm_module add value if not exists 'students';
