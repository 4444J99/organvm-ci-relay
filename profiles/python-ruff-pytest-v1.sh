#!/usr/bin/env bash
set -euo pipefail

python -m pip install --disable-pip-version-check --no-input -e '.[dev]'
python -m pytest tests/ -q
python -m ruff check src/
