"""Per-invocation inbox policy inside the installed Hermes runtime.

The shared profile remains the owner of identity, memory and MCP configuration.
Chat content cannot acquire sending or arbitrary execution authority through tools.
"""
import json
import argparse
import contextlib
import signal
import sys
from pathlib import Path


BLOCK = "This inbox invocation permits raw skill reading and read-only knowledge MCP queries. Sending requires the inbox composer."
BEEPER_TOOLS = frozenset({"send_message", "edit_message", "delete_message", "get_chat", "get_messages", "list_chats", "search_chats", "search_messages", "mark_chat_read", "get_accounts"})


def safe_skill_view(name, file_path=None, **_kwargs):
    """Use Hermes resolution and containment, bypass shell rendering and dependency activation."""
    from tools import skills_tool as skills
    from tools.skills_tool_plugin import _read_skill_text, _serve_skill_file
    try:
        if not isinstance(name, str) or skills.skill_lookup_path_error(name):
            raise ValueError("invalid skill")
        if ":" in name:
            from hermes_cli.plugins import get_plugin_manager
            skill_md = get_plugin_manager().find_plugin_skill(name)
            if skill_md is None:
                raise ValueError("missing skill")
            skill_md = Path(skill_md)
            skill_dir = skill_md.parent
        else:
            roots, _active = skills.skill_search_dirs()
            error, skill_dir, skill_md = skills.locate_skill(name, None, roots)
            if error is not None:
                return error
        if file_path is not None:
            if not isinstance(file_path, str) or skill_dir is None:
                raise ValueError("invalid skill file")
            return _serve_skill_file(skill_dir, file_path, name)
        if skill_md.stat().st_size > 128 * 1024:
            raise ValueError("skill too large")
        return json.dumps({"success": True, "name": name, "content": _read_skill_text(skill_md)}, ensure_ascii=False)
    except BaseException:
        return json.dumps({"success": False, "error": BLOCK})


class InboxToolPolicy:
    def __init__(self, config):
        self.provenance = {}
        self.beeper_servers = set()
        for server, settings in (config.get("mcp_servers") or {}).items():
            if not isinstance(settings, dict):
                continue
            identity = json.dumps([server, settings.get("command"), settings.get("args"), settings.get("url")]).lower()
            if "beeper" in identity or "23373" in identity:
                self.beeper_servers.add(server)

    def capture(self, server, tools):
        from tools.mcp_tool_registration import _annotation_read_only_hint
        from tools import mcp_tool_schema as schema
        for tool in tools:
            if tool.name in BEEPER_TOOLS:
                self.beeper_servers.add(server)
            exposed = schema._convert_mcp_schema(server, tool)["name"]
            self.provenance[exposed] = (server, tool.name, _annotation_read_only_hint(tool))

    def permits(self, name, args, depth=0):
        try:
            if not isinstance(name, str) or not isinstance(args, dict) or depth > 2:
                return False
            if name == "skills_list":
                return set(args) <= {"category"} and all(isinstance(v, str) for v in args.values())
            if name == "skill_view":
                return set(args) <= {"name", "file_path"} and isinstance(args.get("name"), str) and all(isinstance(v, str) for v in args.values())
            if name in {"tool_search", "tool_describe"}:
                return True
            if name == "tool_call":
                from tools.tool_search import normalize_tool_call_entries
                calls, error = normalize_tool_call_entries(args)
                return error is None and bool(calls) and all(self.permits(call["name"], call["arguments"], depth + 1) for call in calls)
            origin = self.provenance.get(name)
            if origin is None:
                return False
            server, raw_name, read_only = origin
            if server in self.beeper_servers or raw_name in BEEPER_TOOLS or read_only is not True:
                return False
            from tools import mcp_tool
            from tools.mcp_tool_handlers import _tool_is_read_only
            return mcp_tool._mcp_tool_server_names.get(name) == server and _tool_is_read_only(server, raw_name) is True
        except BaseException:
            # Hermes' generic hook exception handler is fail-open. This guard must veto explicitly.
            return False


def install_policy():
    # main applies --profile before imports cache HERMES_HOME.
    from hermes_cli.main import main
    from hermes_cli import plugins
    from hermes_cli.config import load_config
    from hermes_cli.plugins import PluginContext, PluginManifest
    from tools import mcp_tool_registration, skills_tool
    from tools.registry import registry

    policy = InboxToolPolicy(load_config())
    original_candidates = mcp_tool_registration._tool_candidates

    def candidates(server, tools, should_register, tool_timeout):
        tools = tuple(tools)
        policy.capture(server, tools)
        return original_candidates(server, tools, should_register, tool_timeout)

    mcp_tool_registration._tool_candidates = candidates
    skills_tool.skill_view = safe_skill_view
    # Preloads/slash helpers also reference this callable. Raw text never expands shell blocks.
    skills_tool._preprocess_skill = lambda content, *_args, **_kwargs: content
    schema = registry.get_schema("skill_view")
    if not isinstance(schema, dict):
        raise RuntimeError("unsupported skill registry")
    registry.register(name="skill_view", toolset="skills", schema=schema,
                      handler=lambda args, **_kwargs: safe_skill_view(**args), override=True)

    plugins.discover_plugins()
    context = PluginContext(PluginManifest(name="pi-super-inbox-policy"), plugins.get_plugin_manager())

    def guard(tool_name="", args=None, **_kwargs):
        try:
            if policy.permits(tool_name, args):
                return None
        except BaseException:
            pass
        return {"action": "block", "message": BLOCK}

    context.register_hook("pre_tool_call", guard)
    original_dispatch = plugins._dispatch_pre_tool_call_hooks

    def dispatch(name, args, **kwargs):
        try:
            block, modified = original_dispatch(name, args, **kwargs)
            effective = args if modified is None else modified
            if not policy.permits(name, effective):
                return BLOCK, effective
            return block, effective
        except BaseException:
            return BLOCK, args

    # Validate AFTER other profile hooks finish rewriting arguments. Both ordinary and
    # deferred dispatch use this central gate, including concurrent tool batches.
    plugins._dispatch_pre_tool_call_hooks = dispatch
    if not plugins.has_hook("pre_tool_call") or dispatch("terminal", {"command": "true"})[0] != BLOCK or dispatch("skills_list", {})[0] is not None:
        raise RuntimeError("policy installation failed")
    return load_config()


def run_agent(config, provider, model, prompt):
    """Use the local SDK so the profile's shared gateway cannot escape this policy/process."""
    from hermes_cli.env_loader import load_hermes_dotenv
    from hermes_cli.runtime_provider import resolve_runtime_provider
    from hermes_cli.tools_config import _get_platform_tools
    from hermes_state import SessionDB
    from run_agent import AIAgent
    from agent.interrupt_compat import request_hard_interrupt
    load_hermes_dotenv()
    runtime = resolve_runtime_provider(requested=provider, target_model=model)
    if runtime.get("command") or runtime.get("args") or runtime.get("api_mode") not in {"chat_completions", "codex_responses", "anthropic_messages", "bedrock_converse"}:
        raise RuntimeError("external agent runtimes are unavailable in the inbox")
    agent = None
    database = SessionDB()
    try:
        agent = AIAgent(
            model=model, provider=runtime.get("provider"), requested_provider=provider,
            api_key=runtime.get("api_key"), base_url=runtime.get("base_url"),
            api_mode=runtime.get("api_mode"), credential_pool=runtime.get("credential_pool"),
            acp_command=runtime.get("command"), acp_args=runtime.get("args"),
            enabled_toolsets=sorted(_get_platform_tools(config, "cli")),
            disabled_toolsets=(config.get("agent") or {}).get("disabled_toolsets"),
            max_iterations=20, run_budget_seconds=110, max_tokens=4000,
            fallback_model={},
            quiet_mode=True, load_soul_identity=True, session_db=database, platform="cli",
            clarify_callback=lambda *_args, **_kwargs: "Approval unavailable in this inbox invocation. Return an informational answer.",
        )
        if agent.api_mode not in {"chat_completions", "codex_responses", "anthropic_messages", "bedrock_converse"}:
            raise RuntimeError("external agent runtime override")

        def interrupt(_signum, _frame):
            request_hard_interrupt(agent, "inbox request deadline")
            raise SystemExit(143)

        signal.signal(signal.SIGTERM, interrupt)
        signal.signal(signal.SIGINT, interrupt)
        result = agent.run_conversation(user_message=prompt)
        if not isinstance(result, dict) or result.get("failed") or result.get("interrupted") or result.get("partial") or result.get("completed") is False:
            raise RuntimeError("agent failed")
        return {"type": "result", "exit_code": 0, "text": result.get("final_response") or ""}
    finally:
        try:
            from tools.mcp_tool_lifecycle import shutdown_mcp_servers
            shutdown_mcp_servers()
        finally:
            try:
                if agent is not None:
                    agent.close()
            finally:
                database.close()


if __name__ == "__main__":
    try:
        parser = argparse.ArgumentParser()
        parser.add_argument("--profile", choices=["chatassistant"], required=True)
        parser.add_argument("--provider", required=True)
        parser.add_argument("--model", required=True)
        options = parser.parse_args()
        prompt = sys.stdin.read(128 * 1024)
        sys.argv = [sys.argv[0], "--profile", options.profile]
        # Profile/runtime libraries may print diagnostics. Only our protocol uses stdout.
        with contextlib.redirect_stdout(sys.stderr):
            config = install_policy()
            result = run_agent(config, options.provider, options.model, prompt)
        print(json.dumps({"type": "inbox_policy", "version": 1}), flush=True)
        print(json.dumps(result, ensure_ascii=False), flush=True)
    except SystemExit:
        raise
    except BaseException:
        print("Inbox Hermes policy unavailable", file=sys.stderr)
        sys.exit(1)
