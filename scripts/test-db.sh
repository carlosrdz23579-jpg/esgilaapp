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
for f in supabase/migrations/*.sql; do echo "== $f"; case "$f" in *0017_*) $P -f "$f";; *) $P -1 -f "$f";; esac; done
# Registro de los dos usuarios después de las migraciones (el trigger crea su app_users)
$P -c "insert into auth.users(email) values ('aldost228@gmail.com'),('carlosrdz23579@gmail.com')"
for f in supabase/seed/seed_inicial.sql supabase/seed/seed_calendarios.sql supabase/seed/seed_inicial.sql; do $P -f "$f" >/dev/null; done
for f in 0006_corte_y_dias_laborables 0007_editar_cancelar_calendarios 0009_un_expediente_conceptos_tolerancia 0008_head_coach_horarios_checador 0009_un_expediente_conceptos_tolerancia 0010_descuentos 0011_ingresos_extra 0012_checadas_y_revision 0013_nomina_versiones 0014_tarifa_retardo 0015_prestamos 0016_efectivo 0018_calentamiento 0019_calentamiento_solo_coach 0020_datos_generales; do $P -1 -f supabase/migrations/$f.sql >/dev/null && echo "== $f repetible"; done
$P -f supabase/tests/checks.sql
