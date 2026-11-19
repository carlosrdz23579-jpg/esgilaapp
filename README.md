# esgilaapp — Sistema administrativo ESGILA (RR.HH. y nómina multiempresa)

Stack: React + TypeScript + Tailwind (Vite) y Supabase. Decisiones fijas en `docs/ARQUITECTURA.md`.

## Contenido de este repositorio

| Ruta | Qué es | Estado |
|---|---|---|
| `docs/ARQUITECTURA.md` | Decisiones técnicas y mapa de módulos | Original |
| `supabase/migrations/0001…0005` | Esquema, permisos, RLS, Head Coach, calendarios de pago | Probadas en orden sobre Postgres 16 limpio |
| `supabase/seed/` | Carga inicial (ESGILA CAR y Viñedos) y calendario quincenal | Probadas; se pueden repetir sin duplicar |
| `packages/domain/src` | Cálculo de nómina y de efectivo en enteros (centavos/minutos) | 11 pruebas pasan |

## Falta en este repositorio

Estas partes existen solo en la copia local de la computadora de Carlos y hay que subirlas:

- `apps/web/` completa (App.tsx, lib/auth.tsx, lib/supabase.ts, lib/money.ts, components/Shell.tsx, components/Employees.tsx, módulo Empresas y calendarios, package.json, index.css…)
- `packages/domain/src/pay-calendar.ts` y sus pruebas (etapa 5, 18 pruebas)
- `apps/web/.env.example`

`apps/web/.env.local` **no** se sube nunca.

## Probar el dominio

```
cd packages/domain/src
node --experimental-strip-types --test domain.test.ts
```

## Migraciones

Se aplican en orden, cada una una sola vez (SQL Editor de Supabase). 0003 y 0004 se aplicaron a mano en Supabase; aquí quedan registradas para que el repositorio coincida con la base de datos.
