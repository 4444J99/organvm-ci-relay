#!/usr/bin/env bash
set -euo pipefail

python -m pip install --disable-pip-version-check --no-input \
  'organvm-ontologia @ git+https://github.com/meta-organvm/organvm-ontologia.git'
python -m pip install --disable-pip-version-check --no-input -e '.[dev]'
python -m ruff check src/ tests/ --ignore SIM105
python -m pyright src/
python -m pytest tests/ -q
