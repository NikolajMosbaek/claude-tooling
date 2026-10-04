#!/usr/bin/env python3
"""Tests for resolve-context.py. Run: python3 scripts/test-resolve-context.py

Stdlib only — the skill must not require anything beyond python3.
"""

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

_here = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("resolve_context", _here / "resolve-context.py")
rc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rc)


class ParseAdoRemote(unittest.TestCase):
    def test_https_form_with_org_as_userinfo(self):
        got = rc.parse_ado_remote(
            "https://Contoso@dev.azure.com/Contoso/Payments/_git/mobile-app"
        )
        self.assertEqual(got, {"org": "Contoso", "project": "Payments", "repo": "mobile-app"})

    def test_https_form_without_userinfo(self):
        got = rc.parse_ado_remote("https://dev.azure.com/Contoso/Payments/_git/api")
        self.assertEqual(got, {"org": "Contoso", "project": "Payments", "repo": "api"})

    def test_dot_git_suffix_is_stripped(self):
        got = rc.parse_ado_remote("https://dev.azure.com/Contoso/Payments/_git/api.git")
        self.assertEqual(got["repo"], "api")

    def test_ssh_v3_form(self):
        got = rc.parse_ado_remote("git@ssh.dev.azure.com:v3/Contoso/Payments/api")
        self.assertEqual(got, {"org": "Contoso", "project": "Payments", "repo": "api"})

    def test_legacy_visualstudio_host(self):
        got = rc.parse_ado_remote("https://contoso.visualstudio.com/Payments/_git/api")
        self.assertEqual(got, {"org": "contoso", "project": "Payments", "repo": "api"})

    def test_percent_encoded_project_is_decoded(self):
        got = rc.parse_ado_remote("https://dev.azure.com/Contoso/My%20Project/_git/api")
        self.assertEqual(got["project"], "My Project")

    def test_non_ado_remote_returns_none(self):
        self.assertIsNone(rc.parse_ado_remote("https://github.com/foo/bar.git"))
        self.assertIsNone(rc.parse_ado_remote("git@github.com:foo/bar.git"))

    def test_garbage_returns_none_rather_than_raising(self):
        for bad in ("", "   ", "not a url", "https://dev.azure.com/OnlyOrg"):
            self.assertIsNone(rc.parse_ado_remote(bad), bad)


class Validate(unittest.TestCase):
    def test_minimal_config_is_valid(self):
        self.assertEqual(rc.validate({"project": "P", "repos": ["r"]}), [])

    def test_missing_project_is_an_error(self):
        self.assertIn("project", " ".join(rc.validate({"repos": ["r"]})))

    def test_empty_repos_is_an_error(self):
        self.assertIn("repos", " ".join(rc.validate({"project": "P", "repos": []})))

    def test_repos_must_be_a_list_of_strings(self):
        self.assertTrue(rc.validate({"project": "P", "repos": "r"}))
        self.assertTrue(rc.validate({"project": "P", "repos": [1]}))

    def test_board_convention_values_must_be_boolean(self):
        bad = {"project": "P", "repos": ["r"], "boardConvention": {"prOpenMeansTasksDone": "yes"}}
        self.assertTrue(rc.validate(bad))
        ok = {"project": "P", "repos": ["r"], "boardConvention": {"prOpenMeansTasksDone": True}}
        self.assertEqual(rc.validate(ok), [])

    def test_unknown_top_level_key_is_reported(self):
        self.assertTrue(rc.validate({"project": "P", "repos": ["r"], "sprint": 19}))


class Discover(unittest.TestCase):
    def test_single_ado_remote_resolves_project_and_repo(self):
        got = rc.discover(["https://dev.azure.com/Contoso/Payments/_git/api"])
        self.assertEqual(got["project"], "Payments")
        self.assertEqual(got["repos"], ["api"])
        self.assertEqual(got["ambiguous"], [])

    def test_two_repos_in_one_project_are_both_kept(self):
        got = rc.discover([
            "https://dev.azure.com/Contoso/Payments/_git/api",
            "https://dev.azure.com/Contoso/Payments/_git/web",
        ])
        self.assertEqual(sorted(got["repos"]), ["api", "web"])
        self.assertEqual(got["ambiguous"], [])

    def test_duplicate_remotes_are_deduped(self):
        got = rc.discover(["https://dev.azure.com/Contoso/Payments/_git/api"] * 3)
        self.assertEqual(got["repos"], ["api"])

    def test_remotes_spanning_two_projects_are_ambiguous(self):
        got = rc.discover([
            "https://dev.azure.com/Contoso/Payments/_git/api",
            "https://dev.azure.com/Contoso/Billing/_git/ledger",
        ])
        self.assertIn("project", " ".join(got["ambiguous"]))
        self.assertIsNone(got["project"])

    def test_no_ado_remote_is_ambiguous_not_a_crash(self):
        got = rc.discover(["https://github.com/foo/bar.git"])
        self.assertIsNone(got["project"])
        self.assertTrue(got["ambiguous"])

    def test_team_is_never_guessed(self):
        got = rc.discover(["https://dev.azure.com/Contoso/Payments/_git/api"])
        self.assertIsNone(got.get("team"))


class ReadAndWrite(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "nested" / "work-status.json"

    def tearDown(self):
        self.dir.cleanup()

    def test_missing_file_reports_absent(self):
        got = rc.read_config(self.path)
        self.assertFalse(got["exists"])
        self.assertIsNone(got["config"])

    def test_write_then_read_round_trips(self):
        cfg = {"project": "Payments", "team": "Core", "repos": ["api"]}
        rc.write_config(self.path, cfg)
        got = rc.read_config(self.path)
        self.assertTrue(got["exists"])
        self.assertEqual(got["config"], cfg)

    def test_write_creates_parent_directory(self):
        rc.write_config(self.path, {"project": "P", "repos": ["r"]})
        self.assertTrue(self.path.is_file())

    def test_write_rejects_an_invalid_config(self):
        with self.assertRaises(ValueError):
            rc.write_config(self.path, {"repos": []})
        self.assertFalse(self.path.exists())

    def test_write_leaves_no_temp_files_behind(self):
        rc.write_config(self.path, {"project": "P", "repos": ["r"]})
        self.assertEqual([p.name for p in self.path.parent.iterdir()], ["work-status.json"])

    def test_existing_file_is_not_clobbered_on_a_failed_write(self):
        good = {"project": "P", "repos": ["r"]}
        rc.write_config(self.path, good)
        with self.assertRaises(ValueError):
            rc.write_config(self.path, {"project": "", "repos": ["r"]})
        self.assertEqual(rc.read_config(self.path)["config"], good)

    def test_unreadable_json_reports_rather_than_raising(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text("{ not json")
        got = rc.read_config(self.path)
        self.assertTrue(got["exists"])
        self.assertIsNone(got["config"])
        self.assertIn("json", (got["error"] or "").lower())

    def test_tilde_in_path_is_expanded(self):
        self.assertEqual(
            rc.config_path("~/x/work-status.json"),
            Path.home() / "x" / "work-status.json",
        )


class Cli(unittest.TestCase):
    """The model calls this as a subprocess, so the contract is the JSON on stdout."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = str(Path(self.dir.name) / "work-status.json")

    def tearDown(self):
        self.dir.cleanup()

    def _run(self, *args):
        import subprocess
        out = subprocess.run(
            [sys.executable, str(_here / "resolve-context.py"), "--config", self.path, *args],
            capture_output=True, text=True,
        )
        return out

    def test_status_reports_absent_config_and_exits_zero(self):
        out = self._run("--remote", "https://dev.azure.com/Contoso/Payments/_git/api")
        self.assertEqual(out.returncode, 0, out.stderr)
        got = json.loads(out.stdout)
        self.assertFalse(got["exists"])
        self.assertEqual(got["discovered"]["project"], "Payments")

    def test_write_persists_and_is_visible_to_the_next_call(self):
        w = self._run("--write", json.dumps({"project": "Payments", "repos": ["api"]}))
        self.assertEqual(w.returncode, 0, w.stderr)
        got = json.loads(self._run().stdout)
        self.assertTrue(got["exists"])
        self.assertEqual(got["config"]["project"], "Payments")

    def test_write_of_invalid_config_exits_nonzero_with_a_message(self):
        w = self._run("--write", json.dumps({"repos": []}))
        self.assertNotEqual(w.returncode, 0)
        self.assertTrue(w.stderr.strip())

    def test_existing_config_short_circuits_discovery(self):
        self._run("--write", json.dumps({"project": "Payments", "repos": ["api"]}))
        got = json.loads(self._run("--remote", "https://dev.azure.com/Other/Nope/_git/x").stdout)
        self.assertEqual(got["config"]["project"], "Payments")
        self.assertEqual(got["source"], "config")


if __name__ == "__main__":
    unittest.main(verbosity=2)
