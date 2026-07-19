from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

_ENV_CONFIG_PATH = "GRA_CONFIG_PATH"


def runtime_config_path() -> Path:
    raw = str(os.environ.get(_ENV_CONFIG_PATH) or "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return Path(__file__).resolve().parent / "config.json"


def load_runtime_config(default: dict[str, Any] | None = None) -> dict[str, Any]:
    path = runtime_config_path()
    try:
        if path.is_file():
            data = json.loads(path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
    except Exception:
        pass
    return dict(default or {})
