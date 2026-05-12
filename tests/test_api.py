import unittest

from fastapi.testclient import TestClient

import main


class FinSightApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client_cm = TestClient(main.app)
        cls.client = cls.client_cm.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.client_cm.__exit__(None, None, None)

    def test_health_endpoint(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["status"], "ok")
        self.assertGreater(payload["stock_rows"], 0)

    def test_companies_endpoint(self):
        response = self.client.get("/companies")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertGreaterEqual(len(payload), 8)
        self.assertIn("symbol", payload[0])
        self.assertIn("data_source", payload[0])

    def test_summary_endpoint_accepts_short_symbol(self):
        response = self.client.get("/summary/INFY")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["symbol"], "INFY.NS")
        self.assertIn("momentum_score", payload)

    def test_compare_endpoint_returns_correlation(self):
        response = self.client.get("/compare?symbol1=INFY&symbol2=TCS&days=30")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("return_correlation", payload)
        self.assertIn("winner", payload)

    def test_refresh_endpoint(self):
        response = self.client.post("/refresh")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["symbols_processed"], len(main.DEFAULT_COMPANIES))
        self.assertIn("sources", payload)


if __name__ == "__main__":
    unittest.main()
