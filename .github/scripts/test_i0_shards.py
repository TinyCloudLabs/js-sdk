import importlib.util
import json
from pathlib import Path
import tempfile
import subprocess
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
            report.write_text("\n".join(json.dumps({"file": str(root / name), "skipped": False}) for name in ["a.test.mjs", "a.test.mjs", "b.test.mjs"]))
            self.assertEqual(i0.node_executed_files(report, root), ["a.test.mjs", "b.test.mjs"])

    def test_skip_only_bun_file_cannot_satisfy_execution_coverage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = root / "bun.xml"
            report.write_text(f'''<testsuites>
              <testsuite name="skip-only.test.ts" tests="1" skipped="1" assertions="0">
              <testcase name="not run" file="{root}/skip-only.test.ts"><skipped/></testcase></testsuite>
              <testsuite name="mixed.test.ts" tests="2" skipped="1">
              <testcase name="not run" file="{root}/mixed.test.ts"><skipped/></testcase>
              <testcase name="ran" file="{root}/mixed.test.ts"/></testsuite>
            </testsuites>''')
            self.assertEqual(i0.bun_executed_files(report, root), ["mixed.test.ts"])

    def test_bun_relative_files_are_resolved_from_producer_cwd(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = root / "bun.xml"
            report.write_text('''<testsuites><testsuite name="test/actual.test.ts">
              <testcase name="ran" file="test/actual.test.ts"/></testsuite></testsuites>''')
            self.assertEqual(
                i0.bun_executed_files(report, root, root / "packages/courier"),
                ["packages/courier/test/actual.test.ts"],
            )

    def test_known_skip_only_files_require_skipped_evidence_and_never_execution(self):
        expected = {"one": ["active.test.ts", "known.test.mjs"]}
        known = ["known.test.mjs"]
        i0.validate_coverage(expected, {"one": ["active.test.ts"]}, {"one": known}, known)
        for actual, skipped in [
            (["active.test.ts"], []),
            (["active.test.ts", "known.test.mjs"], []),
            (["active.test.ts", "known.test.mjs"], known),
        ]:
            with self.subTest(actual=actual, skipped=skipped), self.assertRaises(ValueError):
                i0.validate_coverage(expected, {"one": actual}, {"one": skipped}, known)
        with self.assertRaises(ValueError):
            i0.validate_coverage({"one": ["active.test.ts"]}, {"one": ["active.test.ts"]}, {"one": []}, known)
        with self.assertRaises(ValueError):
            i0.validate_coverage(expected, {"one": []}, {"one": ["active.test.ts", *known]}, known)

    def test_real_node_report_attributes_helper_tests_and_rejects_empty_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "skip-only.test.mjs").write_text("import {test} from 'node:test'; test.skip('not run', () => {});")
            (root / "mixed.test.mjs").write_text("import {test} from 'node:test'; test.skip('not run', () => {}); test('ran', () => {});")
            (root / "helper.mjs").write_text("import {test} from 'node:test'; export function scenario() { test('helper-defined', () => {}); }")
            (root / "caller.test.mjs").write_text("import {scenario} from './helper.mjs'; scenario();")
            (root / "empty.test.mjs").write_text("// no tests")
            executed, skipped = [], []
            for file in ["skip-only.test.mjs", "mixed.test.mjs", "caller.test.mjs", "empty.test.mjs"]:
                report = root / f"{file}.jsonl"
                subprocess.run([
                    "node", "--test",
                    f"--test-reporter={Path(__file__).with_name('i0-node-reporter.mjs').resolve()}",
                    f"--test-reporter-destination={report}", str(root / file),
                ], check=True, capture_output=True)
                executed.extend(i0.node_executed_files(report, root))
                skipped.extend(i0.node_skipped_files(report, root))
            self.assertEqual(sorted(executed), ["caller.test.mjs", "mixed.test.mjs"])
            self.assertEqual(sorted(skipped), ["mixed.test.mjs", "skip-only.test.mjs"])


if __name__ == "__main__":
    unittest.main()
