import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("i0_shards", Path(__file__).with_name("i0-shards.py"))
i0 = None
if Path(spec.origin).exists():
    i0 = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(i0)


class ShardCoverageTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(i0, "I0 shard execution/coverage helper is not implemented")

    def test_missing_executed_file_fails_even_when_other_shards_pass(self):
        expected = {"one": ["a.test.ts", "b.test.ts"], "two": ["c.test.mjs"]}
        with self.assertRaisesRegex(ValueError, "b.test.ts"):
            i0.validate_coverage(expected, {"one": ["a.test.ts"], "two": ["c.test.mjs"]})

    def test_extra_or_duplicate_execution_is_rejected(self):
        expected = {"one": ["a.test.ts"], "two": ["b.test.ts"]}
        for reports in [
            {"one": ["a.test.ts", "extra.test.ts"], "two": ["b.test.ts"]},
            {"one": ["a.test.ts", "a.test.ts"], "two": ["b.test.ts"]},
            {"one": ["a.test.ts"], "two": ["a.test.ts", "b.test.ts"]},
        ]:
            with self.subTest(reports=reports), self.assertRaises(ValueError):
                i0.validate_coverage(expected, reports)

    def test_missing_shard_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "two"):
            i0.validate_coverage({"one": ["a"], "two": ["b"]}, {"one": ["a"]})

    def test_complete_disjoint_execution_passes(self):
        i0.validate_coverage({"one": ["a", "b"], "two": ["c"]}, {"two": ["c"], "one": ["b", "a"]})

    def test_bun_report_uses_executed_testcases_not_empty_planned_suite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = root / "bun.xml"
            report.write_text(f'''<testsuites>
              <testsuite name="not-executed.test.ts" tests="0"/>
              <testsuite name="actual.test.ts"><testcase name="one" file="{root}/actual.test.ts"/>
              <testcase name="two" file="{root}/actual.test.ts"/></testsuite>
            </testsuites>''')
            self.assertEqual(i0.bun_executed_files(report, root), ["actual.test.ts"])

    def test_node_report_uses_actual_runner_events_and_deduplicates_tests(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = root / "node.jsonl"
            report.write_text("\n".join(json.dumps({"file": str(root / name)}) for name in ["a.test.mjs", "a.test.mjs", "b.test.mjs"]))
            self.assertEqual(i0.node_executed_files(report, root), ["a.test.mjs", "b.test.mjs"])


if __name__ == "__main__":
    unittest.main()
