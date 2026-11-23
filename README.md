# esgilaapp — Sistema administrativo ESGILA (RR.HH. y nómina multiempresa)

Stack: React + TypeScript + Tailwind (Vite) y Supabase. Decisiones fijas en `docs/ARQUITECTURA.md`.

## Contenido

| Ruta | Qué es |
|---|---|
| `docs/ARQUITECTURA.md` | Decisiones técnicas y mapa de módulos |
| `supabase/migrations/0001…0020` | Esquema, permisos, RLS, calendarios de pago, Head Coach, horarios, checador (entre sucursales), conceptos de pago, tolerancia por empresa, descuentos, ingresos extra, checadas y revisión de asistencia, nómina con versiones, tarifa base para retardo, préstamos, efectivo, permisos nuevos (0017, va sola), calentamiento (solo coaches, 0019), datos generales del expediente |
| `supabase/seed/` | Carga inicial (ESGILA CAR y Viñedos) y calendario quincenal; se pueden repetir sin duplicar |
| `packages/domain/src` | Cálculo puro: nómina, efectivo, calendario de pagos e importador del reloj checador (centavos/minutos enteros) |
| `apps/web` | Aplicación React: Empleados (horario, pago, descuentos, ingresos extra, Head Coach), Empresas y calendarios, Asistencia (subir reporte del checador y revisar excepciones), Nómina (calcular por periodo, versiones/restaurar, publicar, confirmación del empleado, autorizar) |

## Reglas de pago de ESGILA (en `pay-calendar.ts` y migración 0006)

- Quincenal: pago el 15 y el último día del mes.
- El día de pago **no** entra en la quincena que se paga: pago del 15 = del último día del mes anterior al 14; pago del último día = del 15 al penúltimo.
- Si el día de pago no es laborable para la persona, se le paga su último día laborable anterior (lunes a sábado → sábado; lunes a jueves → jueves). El corte del periodo no se mueve.

## Pruebas

```
# Lógica (Node 22+)
cd packages/domain/src
node --experimental-strip-types --test *.test.ts

# Base de datos: todas las migraciones + seeds + verificaciones en un Postgres 16 desechable
scripts/test-db.sh

# Aplicación
cd apps/web && npm install && npx tsc -p tsconfig.json --noEmit && npx vite build
```

## Migraciones

Se aplican en orden, cada una una sola vez, en el SQL Editor de Supabase. 0003 y 0004 se aplicaron a mano; aquí quedan registradas para que el repositorio coincida con la base de datos. `apps/web/.env.local` nunca se sube.

## Lectura de Excel (SheetJS)

`apps/web` usa SheetJS desde su CDN oficial (`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`), como recomienda el proyecto; la versión de npm (0.18.5) está abandonada y tiene vulnerabilidades conocidas. Se carga solo al abrir la pantalla de Asistencia. El importador se verificó con los reportes reales de octubre de ambos checadores (no incluidos en el repositorio).
