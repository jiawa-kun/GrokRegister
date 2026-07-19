# -*- coding: utf-8 -*-
"""跨进程 SQLite 标签写入并发冒烟。"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


class TestGraStoreConcurrency(unittest.TestCase):
    def test_parallel_push_tags_no_loss(self) -> None:
        td = tempfile.mkdtemp(prefix="gra-store-")
        os.environ["DATA_DIR"] = td
        os.environ["GRA_SQLITE_PATH"] = str(Path(td) / "gra_store.sqlite")
        import gra_sqlite
        import account_tags

        if gra_sqlite._CONN is not None:
            try:
                gra_sqlite._CONN.close()
            except Exception:
                pass
        gra_sqlite._CONN = None
        gra_sqlite._DB_PATH = None
        account_tags._MIGRATED = False
        # 测试隔离：禁止从仓库旧 JSON 迁移污染
        account_tags._json_path_candidates = lambda: [Path(td) / "account_tags.json"]

        from account_tags import dump_all, set_push_tag

        run_id = uuid.uuid4().hex[:8]
        workers = 8
        per = 20
        total = workers * per

        def _write_range(start: int) -> int:
            n = 0
            for i in range(start, start + per):
                set_push_tag(
                    channel="auth_cpa",
                    ok=True,
                    email=f"{run_id}-user{i}@example.com",
                )
                n += 1
            return n

        wrote = 0
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futs = [ex.submit(_write_range, i * per) for i in range(workers)]
            for f in as_completed(futs):
                wrote += int(f.result())

        data = dump_all()
        emails = data.get("by_email") or {}
        self.assertEqual(wrote, total)
        self.assertEqual(len(emails), total)
        for i in range(total):
            key = f"{run_id}-user{i}@example.com"
            self.assertIn(key, emails)
            self.assertTrue(emails[key].get("push_auth_cpa_ok") is True)

        try:
            if gra_sqlite._CONN is not None:
                gra_sqlite._CONN.close()
        except Exception:
            pass
        gra_sqlite._CONN = None
        gra_sqlite._DB_PATH = None



if __name__ == "__main__":
    unittest.main()
