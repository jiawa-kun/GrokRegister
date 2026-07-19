# -*- coding: utf-8 -*-
"""Auth 成功判定：dead 必失败；pending_reprobe 独立状态。"""
from __future__ import annotations

import unittest


class TestAuthOkLogic(unittest.TestCase):
    def test_ok_formula(self) -> None:
        def compute(still: bool, probe_ok: bool, dead: bool, fake_alive: bool) -> bool:
            return bool(still) and probe_ok and not dead and not fake_alive

        self.assertTrue(compute(True, True, False, False))
        self.assertFalse(compute(True, False, True, False))  # dead
        self.assertFalse(compute(True, False, False, False))  # pending
        self.assertFalse(compute(True, True, False, True))  # fake alive
        self.assertFalse(compute(False, True, True, False))  # deleted

    def test_pending_reprobe(self) -> None:
        def pending(still, dead, fake_alive, probe_ok, probe_error) -> bool:
            return bool(still) and not dead and not fake_alive and not probe_ok and probe_error

        self.assertTrue(pending(True, False, False, False, True))
        self.assertFalse(pending(True, True, False, False, True))
        self.assertFalse(pending(True, False, False, True, False))


if __name__ == "__main__":
    unittest.main()
