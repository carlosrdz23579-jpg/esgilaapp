# esgilaapp — Sistema administrativo ESGILA (RR.HH. y nómina multiempresa)

Stack: React + TypeScript + Tailwind (Vite) y Supabase. Decisiones fijas en `docs/ARQUITECTURA.md`.

## Contenido

| Ruta | Qué es |
|---|---|
| `docs/ARQUITECTURA.md` | Decisiones técnicas y mapa de módulos |
| `supabase/migrations/0001…0006` | Esquema, permisos, RLS, Head Coach, calendarios de pago, corte y días laborables |
| `supabase/seed/` | Carga inicial (ESGILA CAR y Viñedos) y calendario quincenal; se pueden repetir sin duplicar |
| `packages/domain/src` | Cálculo puro: nómina, efectivo y calendario de pagos (centavos/minutos enteros) |
| `apps/web` | Aplicación React (inicio de sesión, menú por permisos, Empleados, Empresas y calendarios) |

## Reglas de pago de ESGILA (en `pay-calendar.ts` y migración 0006)

- Quincenal: pago el 15 y el último día del mes.
- El día de pago **no** entra en la quincena que se paga: pago del 15 = del último día del mes anterior al 14; pago del último día = del 15 al penúltimo.
- Si el día de pago no es laborable para la persona, se le paga su último día laborable anterior (lunes a sábado → sábado; lunes a jueves → jueves). El corte del periodo no se mueve.

## Pruebas

```
# Lógica (Node 22+)
cd packages/domain/src
node --experimental-strip-types --test domain.test.ts pay-calendar.test.ts

# Base de datos: todas las migraciones + seeds + verificaciones en un Postgres 16 desechable
scripts/test-db.sh

# Aplicación
cd apps/web && npm install && npx tsc -p tsconfig.json --noEmit && npx vite build
```

## Migraciones

Se aplican en orden, cada una una sola vez, en el SQL Editor de Supabase. 0003 y 0004 se aplicaron a mano; aquí quedan registradas para que el repositorio coincida con la base de datos. `apps/web/.env.local` nunca se sube.
