"""Regression checks for the invocation policy without importing an agent or credentials."""
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location("inbox_policy", Path(__file__).parents[1] / "contrib/inbox-hermes.py")
policy_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy_module)


def module(name, **values):
    value = types.ModuleType(name)
    value.__dict__.update(values)
    return value


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.servers = {}
        self.hints = {}
        self.modules = {
            "tools": module("tools"),
            "tools.mcp_tool_registration": module("registration", _annotation_read_only_hint=lambda tool: tool.annotations.get("readOnlyHint") is True),
            "tools.mcp_tool_schema": module("schema", _convert_mcp_schema=lambda server, tool: {"name": f"mcp__{server}__{tool.name}"}),
            "tools.mcp_tool": module("mcp", _mcp_tool_server_names=self.servers),
            "tools.mcp_tool_handlers": module("handlers", _tool_is_read_only=lambda server, raw: self.hints.get((server, raw)) is True),
            "tools.tool_search": module("search", normalize_tool_call_entries=lambda args: (args.get("calls") or [{"name": args.get("name"), "arguments": args.get("arguments")}], None)),
        }
        self.scope = patch.dict(sys.modules, self.modules)
        self.scope.start()
        self.addCleanup(self.scope.stop)
        self.policy = policy_module.InboxToolPolicy({"mcp_servers": {"opaque-alias": {"url": "http://localhost:23373/mcp"}}})

    def capture(self, server, name, read_only):
        tool = types.SimpleNamespace(name=name, annotations={"readOnlyHint": read_only})
        self.policy.capture(server, [tool])
        exposed = f"mcp__{server}__{name}"
        self.servers[exposed] = server
        self.hints[(server, name)] = read_only
        return exposed

    def test_read_only_requires_captured_annotation_and_current_provenance(self):
        good = self.capture("knowledge", "lookup", True)
        self.assertTrue(self.policy.permits(good, {}))
        for annotation in [False, None, "true", 1]:
            self.assertFalse(self.policy.permits(self.capture("knowledge", "other", annotation), {}))
        self.servers[good] = "different-origin"
        self.assertFalse(self.policy.permits(good, {}))
        self.assertFalse(self.policy.permits("mcp__knowledge__uncaptured", {}))

    def test_beeper_is_denied_through_server_aliases_and_raw_tool_identity(self):
        aliased = self.capture("opaque-alias", "lookup", True)
        self.assertFalse(self.policy.permits(aliased, {}))
        beeper = self.capture("random-name", "get_messages", True)
        self.assertFalse(self.policy.permits(beeper, {}))
        self.assertFalse(self.policy.permits(self.capture("random-name", "other_read", True), {}))

    def test_unknown_mutating_tools_and_concurrent_calls_are_denied(self):
        names = ["terminal", "execute_code", "browser_exec", "delegate_task", "write_file", "patch", "skill_manage", "unknown"] * 4
        with ThreadPoolExecutor(max_workers=4) as pool:
            self.assertFalse(any(pool.map(lambda name: self.policy.permits(name, {}), names)))

    def test_deferred_calls_validate_every_underlying_tool(self):
        good = self.capture("knowledge", "lookup", True)
        self.assertTrue(self.policy.permits("tool_call", {"name": good, "arguments": {}}))
        for name in ["terminal", "execute_code", "delegate_task", "uncaptured"]:
            self.assertFalse(self.policy.permits("tool_call", {"name": name, "arguments": {}}))
            self.assertFalse(self.policy.permits("tool_call", {"calls": [{"name": good, "arguments": {}}, {"name": name, "arguments": {}}]}))
        self.assertFalse(self.policy.permits("tool_call", {"name": "tool_call", "arguments": {"name": "tool_call", "arguments": {}}}))

    def test_skill_arguments_and_hook_errors_fail_closed(self):
        self.assertTrue(self.policy.permits("skill_view", {"name": "safe"}))
        self.assertFalse(self.policy.permits("skill_view", {"name": "safe", "preprocess": True}))
        self.assertFalse(self.policy.permits("skills_list", {"category": {"command": "execute"}}))
        self.assertFalse(self.policy.permits("skill_view", None))
        good = self.capture("knowledge", "lookup", True)
        self.modules["tools.mcp_tool_handlers"]._tool_is_read_only = lambda *_: 1 / 0
        self.assertFalse(self.policy.permits(good, {}))

    def test_skill_reader_returns_literal_shell_blocks_and_deps(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            skill = root / "SKILL.md"
            content = "---\nname: safe\ndeps: [must-never-install]\n---\n!`touch must-never-run`\n"
            skill.write_text(content)
            def unsafe(*_args, **_kwargs):
                raise AssertionError("unsafe skill evaluation")
            sys.modules["tools.skills_tool"] = module("skills", skill_lookup_path_error=lambda _name: None, skill_search_dirs=lambda: ([], root), locate_skill=lambda *_: (None, root, skill), skill_view=unsafe, _preprocess_skill=unsafe)
            sys.modules["tools.skills_tool_plugin"] = module("skill_helpers", _read_skill_text=lambda path: path.read_text(), _serve_skill_file=unsafe)
            result = json.loads(policy_module.safe_skill_view("safe"))
            self.assertEqual(result["content"], content)
            self.assertFalse((root / "must-never-run").exists())


if __name__ == "__main__":
    unittest.main()
