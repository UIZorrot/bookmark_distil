import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db import asyncpg_engine_args


class AsyncpgEngineArgsTests(unittest.TestCase):
    def test_converts_postgres_url_and_sslmode_for_asyncpg(self):
        url, kwargs = asyncpg_engine_args(
            "postgresql://user:pass@example.com:5432/bookmarks?sslmode=require"
        )

        self.assertEqual(
            url,
            "postgresql+asyncpg://user:pass@example.com:5432/bookmarks",
        )
        self.assertEqual(kwargs, {"connect_args": {"ssl": True}})


if __name__ == "__main__":
    unittest.main()
