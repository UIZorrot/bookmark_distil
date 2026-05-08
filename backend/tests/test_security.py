import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.security import digest_email_verification_code, mint_email_verification_code


class EmailVerificationCodeTests(unittest.TestCase):
    def test_mints_six_digit_numeric_code(self):
        code = mint_email_verification_code()

        self.assertEqual(len(code), 6)
        self.assertTrue(code.isdigit())

    def test_digests_code_with_pepper(self):
        self.assertEqual(
            digest_email_verification_code("123456", "pepper"),
            digest_email_verification_code("123456", "pepper"),
        )
        self.assertNotEqual(
            digest_email_verification_code("123456", "pepper"),
            digest_email_verification_code("123456", "different-pepper"),
        )


if __name__ == "__main__":
    unittest.main()
