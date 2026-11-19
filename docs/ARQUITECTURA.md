# Arquitectura – Sistema Integral multiempresa (RR.HH., nómina y efectivo)

Este documento fija las decisiones técnicas. Las etapas posteriores **no** las cambian; solo agregan migraciones y módulos.

## 1. Decisiones fijas

| Tema | Decisión | Razón |
|---|---|---|
| Frontend | React + TypeScript + Tailwind (Vite) | Pedido por el proyecto |
| Backend | Supabase: Postgres, Auth, Storage, Realtime + Edge Functions | Seguridad a nivel de fila (RLS) real |
| Dinero | Siempre **enteros en centavos** (`bigint`) | Sin errores de redondeo |
| Tiempo trabajado | **Minutos enteros** | Sin flotantes |
| Porcentajes | Puntos base (25% = 2500) | Exactitud |
| Identidad | `uuid` en todo; el nombre comercial nunca es clave | Renombrar sin perder historia |
| Lógica de cálculo | Paquete puro `packages/domain` (sin dependencias, con pruebas) | Una sola fuente de verdad, usada por UI y Edge Functions |
| Seguridad | RLS en **todas** las tablas + funciones `has_perm()` | La UI solo oculta; la base de datos es quien niega |
| Historial | Tablas append-only + `audit_log` por trigger | Trazabilidad |

## 2. Estructura del repositorio

```
gymhr/
  docs/ARQUITECTURA.md
  supabase/migrations/      # 0001 … 00NN, solo se agregan, nunca se editan las aplicadas
  supabase/functions/       # Edge Functions (autorizar nómina, snapshot de reportes, exportar)
  packages/domain/src/      # money, payroll, cash, pay-calendar (+ tests)
  apps/web/                 # React (src/modules/<modulo>, src/lib, src/components)
```

## 3. Multiempresa

- Todo dato de negocio lleva `company_id NOT NULL`.
- Integridad cruzada con **claves foráneas compuestas**: un grupo referencia `(department_id, company_id)`, un empleado referencia `(department_id, company_id)` y `(group_id, company_id)`. Es imposible, a nivel de base de datos, asignar un empleado de la empresa A a un departamento de la empresa B.
- Departamentos con el mismo nombre en distintas empresas son filas distintas (`unique (company_id, name)`).
- Razón social / RFC viven en `company_fiscal_entities` (una empresa puede tener varias; no se asume identidad fiscal común).
- Empresas inactivas no se borran (`is_active`); no hay `DELETE` para nadie.
- Selector de empresa en UI = filtro; la **autorización real** la dan las políticas RLS. "Todas las empresas" = consulta sin filtro, y solo devuelve lo que RLS permita.
- Reportes consolidados se calculan sobre `payroll_payments` (un pago = una fila), por eso no duplican.

## 4. Permisos

**Perfiles** (`app_users.role`): `director`, `admin`, `rrhh`, `empleado`. El nominista es un conjunto de permisos, no un perfil.

**Permisos individuales** (`permission_grants`): `módulo × acción × alcance`, con alcance opcional por empresa / departamento / grupo / empleado (`NULL` = sin restricción en ese nivel).

Módulos: `companies, employees, salary, payroll, payroll_hours, pay_schedules, reports_financial, reports_shared, cash, complaints, announcements, calendar, chat, users, settings`.
Acciones: `view, create, edit, authorize, delete, export, share, configure`.

Reglas que se hacen cumplir en base de datos:
1. Director = acceso total (`is_director()`).
2. **RR.HH. nunca obtiene** `salary, payroll, payroll_hours, reports_financial, cash`: lo bloquea el trigger al otorgar el permiso **y** `has_perm()` al evaluarlo (doble candado).
3. Nadie se modifica a sí mismo el rol ni los permisos; un admin solo puede otorgar permisos que él mismo tiene.
4. `salary` y `reports_financial` son independientes de `payroll`.
5. Un empleado solo lee sus filas (`employees.user_id = auth.uid()`).

## 5. Protección de información salarial

- El pago por hora **no está en `employees`**. Vive en `employee_compensation_history` (append-only), protegida por `has_perm('salary','view',…)`.
- RR.HH. consulta `employees` (sin columnas salariales) y jamás toca `employee_compensation_history`, `payroll_*` ni reportes.
- Exportaciones y reportes pasan por Edge Functions que reevalúan permisos; no se exportan tablas directamente.
- Archivos de nómina: bucket privado, ruta `company_id/employee_id/period_id/…`, política de Storage con la misma regla.
- Quejas anónimas: la identidad se guarda en `complaint_identities`, **sin ninguna política de lectura** (solo `service_role`); ni el director la ve desde la aplicación.

## 6. Cómo se relacionan los módulos

```
companies ─┬─ departments ─ groups
           ├─ pay_schedules (empresa/depto/grupo/empleado) ─► pay_periods
           └─ employees ─┬─ employee_compensation_history (tarifa vigente por fecha)
                         ├─ loans ─► loan_installments
                         └─ payroll_entries (empleado × periodo × versión)
                              ├─ payroll_day_records (día, minutos, incidencia)
                              ├─ payroll_documents (archivos versionados)
                              ├─ payroll_approvals (empleado / nominista, por versión)
                              ├─ payroll_threads/messages (observaciones y correcciones)
                              └─ payroll_payments (método efectivo|transferencia, estado)
                                    ├─► cash_requests ─► cash_breakdowns (por empleado)
                                    │        └─► cash_withdrawals ─► cash_deliveries ─► cash_reconciliations
                                    └─► reports (snapshot inmutable) ─► report_shares
complaints ─► complaint_messages (chat)      announcements ─► announcement_reads      calendar_events
```

Flujo de nómina: `borrador → pendiente_revision → con_observaciones / solicitud_correccion → en_correccion → pendiente_confirmacion → revisada_empleado → pendiente_validacion_nominista → autorizada → enviada_reportada → finalizada`.
Un trigger sobre las entradas de nómina sube `version` y marca como invalidadas las aprobaciones previas cuando cambia cualquier dato que afecte importes. Nunca hay autoautorización por silencio.

## 6.1 Resolución de calendario de pago

Prioridad: empleado > grupo > departamento > empresa, con vigencias (`effective_from/to`). Los cambios crean filas nuevas; los periodos cerrados no se tocan. Función de resolución en SQL y espejo en `pay-calendar` (etapa 5).

## 7. Cálculo de efectivo (resumen del algoritmo)

1. Por empleado: desglose con la menor cantidad de piezas respetando existencias disponibles (codicioso con límites; ver limitaciones en `cash.ts`).
2. Se suman los desgloses → retiro general (garantiza que alcanza para cada pago).
3. Importes que no sean múltiplos de $0.50 **no se redondean**: se reportan como "sin combinación exacta".
4. Retiro real distinto al solicitado → se recalcula con las existencias reales.
5. Conciliación: retirado − entregado − sobrante; el periodo no se marca "pagado" con diferencias sin revisar.

## 8. Puntos legales que requieren validación humana (no los resuelvo yo)

- **Rebaja del 25 % por retardo**: la Ley Federal del Trabajo (art. 110) limita taxativamente los descuentos al salario. El sistema calcula la regla (porcentaje configurable) pero la columna `discount_authorized` debe ser confirmada por un abogado laboral antes de que afecte pagos reales.
- **Datos personales** (LFPDPPP): aviso de privacidad, consentimiento y plazos de conservación; el diseño ya separa datos sensibles pero el aviso debe redactarlo quien corresponda.
- **CFDI de nómina, ISR, IMSS, subsidio**: fuera de alcance inicial; tablas separadas (`payroll_internal` vs `cfdi_*`) en el futuro. No se simula timbrado.
- "Nómina reportada" vs "nómina neta": se guardan por separado y la diferencia se muestra, sin inferir intención.

## 9. Etapas y estado

| Etapa | Contenido | Estado |
|---|---|---|
| 1 | Diseño y estructura | Arquitectura (este documento); UI pendiente |
| 2 | Base multiempresa | **Migración 0001 escrita** |
| 3 | Usuarios y permisos | **Migración 0001 escrita (núcleo + RLS)** |
| 4 | Empleados | Tablas y RLS en 0001; UI pendiente |
| 5 | Pagos/calendarios | Pendiente (0002) |
| 6 | Nómina | Cálculo en `packages/domain` listo; tablas pendientes (0003) |
| 7–12 | Autorización, quejas, anuncios, reportes, efectivo, pruebas | Pendientes; cálculo de efectivo en `domain` listo |

## 10. Lo que necesito de ti para conectar todo

1. Un proyecto Supabase (URL, `anon key`; la `service_role` solo en el servidor/Edge Functions, nunca en el navegador).
2. Entorno donde pueda ejecutar `npm install` y aplicar migraciones (en esta conversación no hay red).
3. Confirmación del abogado laboral sobre el punto de retardos.
