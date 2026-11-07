#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
    echo 'Сначала выполните make setup и make prepare. Карты берутся из resources/Maps; make maps извлекает встроенные карты.' >&2
    exit 1
fi
exec .venv/bin/python -m server.app "$@"
