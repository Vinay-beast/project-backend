#!/bin/sh
# wait-for.sh host:port -- command

set -e

host="$1"
shift
cmd="$@"

until nc -z $host 3306; do
  >&2 echo "⏳ MySQL is unavailable - sleeping"
  sleep 2
done

>&2 echo "✅ MySQL is up - executing command"
exec "$@"

