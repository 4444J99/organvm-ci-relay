#!/usr/bin/env bash
set -euo pipefail

python -m pip install --disable-pip-version-check --no-input \
  'organvm-ontologia @ git+https://github.com/organvm/organvm-ontologia.git@ecc7ff7e3048562164a8973281d6794db5c16029'
python -m pip install --disable-pip-version-check --no-input -e '.[dev]'
python -m ruff check src/ tests/ --ignore SIM105
python -m pyright src/
python -m pytest tests/ -q
