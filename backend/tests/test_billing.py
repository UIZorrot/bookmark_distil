import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.routes_billing import pricing_region_for_country


class PricingRegionTests(unittest.TestCase):
    def test_defaults_to_high_price_region(self):
        self.assertEqual(pricing_region_for_country(None), "us")
        self.assertEqual(pricing_region_for_country(""), "us")
        self.assertEqual(pricing_region_for_country("US"), "us")
        self.assertEqual(pricing_region_for_country("DE"), "us")

    def test_uses_cn_price_only_for_china(self):
        self.assertEqual(pricing_region_for_country("CN"), "cn")
        self.assertEqual(pricing_region_for_country("cn"), "cn")


if __name__ == "__main__":
    unittest.main()
