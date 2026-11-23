-- =====================================================================
-- 0017  Nuevos módulos de permiso (se agregan solos: un valor nuevo de enum no puede
-- usarse en la misma transacción en que se crea, por eso va en su propia migración).
-- Ejecuta este archivo ANTES de 0018.
--   warmup          calentamiento (marcar por día)
--   followup        notas y observaciones de empleados
--   indicators      catálogo de indicadores de rendimiento
--   planning        planeaciones de clase (revisar)
--   uniform         registro diario de uniforme
-- =====================================================================
alter type app.perm_module add value if not exists 'warmup';
alter type app.perm_module add value if not exists 'followup';
alter type app.perm_module add value if not exists 'indicators';
alter type app.perm_module add value if not exists 'planning';
alter type app.perm_module add value if not exists 'uniform';
