from __future__ import annotations

import subprocess
import sys
import unittest


class RealGatewayFixtureTests(unittest.TestCase):
    def test_recorded_team_gateway_fixture_is_valid(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "ugc_image_tool.contracts.cli",
                "validate",
                "contracts/fixtures/2026-08-17-team-gateway",
            ],
            check=False,
            capture_output=True,
            text=True,
            env={"PYTHONPATH": "src"},
        )

        self.assertEqual(0, result.returncode, result.stderr)


if __name__ == "__main__":
    unittest.main()
