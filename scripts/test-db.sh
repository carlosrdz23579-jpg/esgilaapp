#!/usr/bin/env bash
# Aplica todas las migraciones y seeds en un Postgres 16 desechable y corre las verificaciones.
# Uso: scripts/test-db.sh   (requiere binarios de PostgreSQL 16 en el PATH o en /usr/lib/postgresql/16/bin)
set -euo pipefail
cd "$(dirname "$0")/.."
B=${PGBIN:-/usr/lib/postgresql/16/bin}
D=$(mktemp -d); PORT=${PORT:-5499}
RUN() { if [ "$(id -u)" = 0 ]; then chown -R postgres "$D"; su postgres -c "$*"; else bash -c "$*"; fi; }
RUN "$B/initdb -D $D -U postgres -A trust >/dev/null && $B/pg_ctl -D $D -o '-k /tmp -p $PORT' -l $D/log -w start >/dev/null"
trap 'RUN "$B/pg_ctl -D $D -m fast stop >/dev/null"; rm -rf "$D"' EXIT
P="psql -h /tmp -p $PORT -U postgres -v ON_ERROR_STOP=1 -q"
$P -d postgres -c "create database t"; P="$P -d t"
$P -f supabase/tests/supabase_stub.sql
for f in supabase/migrations/*.sql; do echo "== $f"; case "$f" in *0017_*|*0029_*|*0035_*) $P -f "$f";; *) $P -1 -f "$f";; esac; done
# Registro de los dos usuarios después de las migraciones (el trigger crea su app_users)
$P -c "insert into auth.users(email) values ('aldost228@gmail.com'),('carlosrdz23579@gmail.com')"
for f in supabase/seed/seed_inicial.sql supabase/seed/seed_calendarios.sql supabase/seed/seed_inicial.sql; do $P -f "$f" >/dev/null; done
for f in 0006_corte_y_dias_laborables 0007_editar_cancelar_calendarios 0009_un_expediente_conceptos_tolerancia 0008_head_coach_horarios_checador 0009_un_expediente_conceptos_tolerancia 0010_descuentos 0011_ingresos_extra 0012_checadas_y_revision 0013_nomina_versiones 0014_tarifa_retardo 0015_prestamos 0016_efectivo 0018_calentamiento 0019_calentamiento_solo_coach 0020_datos_generales 0021_anular_historial_pago 0022_usuarios_y_funciones 0023_anular_horarios 0024_calendario_coaches 0025_calentamientos_por_dia 0026_rotacion_calentamiento 0027_configuracion 0028_semanales_y_eventos 0030_alumnas 0031_abonos_varios_prestamos 0032_entregas_de_pago 0033_seguimiento_empleados 0034_planeacion_por_sucursal 0036_catalogo_planes 0037_pago_adelantado 0038_doble_disciplina 0039_tabla_de_precios 0040_tabla_con_texto 0041_cupo_por_dia 0042_datos_alumnas_y_prospectos 0043_caja_y_cobros; do $P -1 -f supabase/migrations/$f.sql >/dev/null && echo "== $f repetible"; done
$P -f supabase/tests/checks.sql
