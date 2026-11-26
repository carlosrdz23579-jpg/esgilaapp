-- =====================================================================
-- 0035  Módulos de permiso para la parte de finanzas (va SOLO, como 0017 y 0029).
--   billing   cobranza: view = ver planes, saldos y cobros · edit = asignar planes, becas y cobrar
--             configure = catálogo (planes, precios, productos, formas de pago, anualidad, reglas)
--   cashbox   caja por vendedor (abrir/cerrar, cortes)
--   bank      conciliación bancaria
--   expenses  gastos administrativos, costos e inversión
-- =====================================================================
alter type app.perm_module add value if not exists 'billing';
alter type app.perm_module add value if not exists 'cashbox';
alter type app.perm_module add value if not exists 'bank';
alter type app.perm_module add value if not exists 'expenses';
