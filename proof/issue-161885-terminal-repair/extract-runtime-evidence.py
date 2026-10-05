#!/usr/bin/env python3
"""Read-only replay-result validator; writes only the requested sanitized report.

No source imports, subprocesses, network, tests, builds, or source/index writes.
Run AFTER both unchanged fixtures have finished. A raw JSON file is not success:
both fixtures save it from finally, even when a later assertion/cleanup fails.

Example (paths are private local inputs, never copied to the report):
  python3 extract-runtime-evidence.py --runtime-dir ../runtime --replay-dir ../replay \
    --expected-head 3c0f7e4c5cdade301b896970c9afbf4ab253de5e \
    --expected-tree 61d9f1df2cc6b2d313609d49564c897bdc5e977e \
    --readonly-exit-code 0 --controls-exit-code 0 --output sanitized-runtime.json

Exit 0 means the scoped checks below passed; it is NOT a full-product/provenance
pass. Exit 1 means a recorded check failed; exit 2 means required command status
or an input was missing/unreadable. Inspect unproven and provenance separately.
Optional --end-state accepts a separately recorded JSON object with fields head,
sourceTree, trackedWorktreeClean. It is caller-supplied evidence, not reverified
by this extractor. The caller owns before/after source identity and toolchain.
"""

import argparse
import hashlib
import json
import re
from collections import Counter, defaultdict
from pathlib import Path


PINNED_HARNESS = {
    "readonly": "32e7a754c43071eff00462d578990cb6085fc54dd7ee14f308a23e5f9e1f123e",
    "controls": "d7e9449aa04fb316f9c5d23eee46d25bcd6019ab8e740966b8e59752d076627f",
}
FILES = {
    "readonly": "gateway-final-readonly-routing.mts",
    "controls": "gateway-final-loader-controls.mts",
}
RESULT_FILES = {
    "readonly": "final-readonly-routing-results.json",
    "controls": "final-loader-controls-results.json",
}
AGENTS = ("main", "withfallback", "direct")
ANSWERS = {"main": "CLI_FIXTURE_ANSWER", "withfallback": "LOOPBACK_FIXTURE_ANSWER", "direct": "LOOPBACK_FIXTURE_ANSWER"}
READ_TOOLS = {"web_search", "web_fetch", "memory_search", "memory_get", "read"}
PHASES = {"start", "end", "error", "fallback_step", "model", "finishing"}
ERRORS = {"AbortError", "NotSupportedError", "ProviderAuthError", "FailoverError", "Error", "TimeoutError"}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def error_name(error):
    name = error.get("name") if isinstance(error, dict) else None
    return name if name in ERRORS else ("other" if name else None)


def text_content(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(text_content(part) for part in value)
    if isinstance(value, dict):
        # Only visible text blocks; tool arguments, metadata, and grants are ignored.
        return value.get("text", "") if isinstance(value.get("text"), str) else ""
    return ""


def messages(history):
    if not isinstance(history, dict) or not isinstance(history.get("messages"), list):
        return None
    rows = []
    for entry in history["messages"]:
        if not isinstance(entry, dict):
            continue
        message = entry.get("message", entry)
        if isinstance(message, dict):
            rows.append((message.get("role"), text_content(message.get("content", message.get("text", "")))))
    return rows


def history_summary(history):
    rows = messages(history)
    if rows is None:
        return {"available": False}
    generated = ("Answer turn 0.", "Answer turn 1.", "FAIL_CLI:", "CLI_HOLD", "CANCEL_PROBE", "Return one concise answer.", "Answer the latest replacement request.")
    return {
        "available": True,
        "visible_message_count": len(rows),
        "visible_user_count": sum(role == "user" for role, _ in rows),
        "visible_assistant_count": sum(role == "assistant" for role, _ in rows),
        "human_sentinel_user_count": sum(role == "user" and "HISTORY_SENTINEL: Remember the copper telescope." in text for role, text in rows),
        "cli_assistant_answer_count": sum(role == "assistant" and "CLI_FIXTURE_ANSWER" in text for role, text in rows),
        "loopback_assistant_answer_count": sum(role == "assistant" and "LOOPBACK_FIXTURE_ANSWER" in text for role, text in rows),
        "visible_generated_consult_user_count": sum(role == "user" and any(token in text for token in generated) for role, text in rows),
    }


def flag_values(argv, flag):
    values = []
    for index, arg in enumerate(argv):
        if arg == flag:
            following = []
            for next_arg in argv[index + 1:]:
                if next_arg.startswith("--"):
                    break
                following.append(next_arg)
            values.append(following)
        elif arg.startswith(flag + "="):
            values.append([arg[len(flag) + 1:]])
    return values


def policy_summary(argv):
    native = flag_values(argv, "--tools")
    allowed = flag_values(argv, "--allowedTools") + flag_values(argv, "--allowed-tools")
    names = []
    for group in allowed:
        for value in group:
            names.extend(item for item in value.replace(",", " ").split() if item)
    stripped = [name.removeprefix("mcp__openclaw__") for name in names]
    native_empty = len(native) == 1 and native[0] == [""]
    exact = len(allowed) == 1 and set(stripped) == READ_TOOLS and all(name.startswith("mcp__openclaw__") for name in names)
    return {
        "native_tools_explicitly_empty": native_empty,
        "allowed_mcp_tool_names": sorted(set(stripped) & READ_TOOLS),
        "other_allowed_tool_count": sum(name not in READ_TOOLS for name in stripped),
        "wildcard_observed": any("*" in name for name in names),
        "exact_expected_readonly_mcp_policy": exact,
        "reduced_launch_policy_observed": native_empty and exact,
    }


def lifecycle_summary(raw, fixture):
    grouped = defaultdict(list)
    malformed = 0
    for event in raw.get("events", []):
        if not isinstance(event, dict) or event.get("event") != "agent":
            continue
        payload = event.get("payload")
        if not isinstance(payload, dict) or payload.get("stream") != "lifecycle":
            continue
        if not isinstance(payload.get("runId"), str) or not isinstance(payload.get("data"), dict):
            malformed += 1
            continue
        grouped[payload["runId"]].append(payload)
    output = []
    for number, (_, events) in enumerate(grouped.items(), 1):
        session_keys = {event.get("sessionKey") for event in events if isinstance(event.get("sessionKey"), str)}
        expected_sessions = {
            **{f"agent:{agent}:{'controls-proof' if fixture == 'controls' else 'readonly-proof'}": agent for agent in AGENTS},
            **({"agent:main:normal-proof": "normal-main", "agent:withfallback:normal-fallback-proof": "normal-fallback"} if fixture == "readonly" else {}),
        }
        routes = {expected_sessions[key] for key in session_keys if key in expected_sessions}
        route = next(iter(routes)) if len(routes) == 1 else "unclassified"
        counts = Counter(event["data"].get("phase") for event in events)
        terminals = [event for event in events if event["data"].get("phase") in ("end", "error")]
        output.append({
            "run_alias": f"{fixture}-run-{number:02d}",
            "route": route,
            "phase_counts": {phase: counts[phase] for phase in sorted(PHASES) if counts[phase]},
            "other_phase_count": sum(count for phase, count in counts.items() if phase not in PHASES),
            "terminal_count": len(terminals),
            "terminal_phases": [event["data"]["phase"] for event in terminals],
            "fallback_next_candidate_event_count": sum(event["data"].get("phase") == "fallback_step" and event["data"].get("fallbackStepFinalOutcome") == "next_fallback" for event in events),
        })
    return {"scope": "Recorded Gateway agent/lifecycle events before fixture result snapshot; raw run/session IDs omitted", "runs": output, "run_count": len(output), "malformed_lifecycle_event_count": malformed}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-dir", required=True, type=Path)
    parser.add_argument("--replay-dir", required=True, type=Path)
    parser.add_argument("--expected-head", required=True)
    parser.add_argument("--expected-tree", required=True)
    parser.add_argument("--readonly-exit-code", type=int)
    parser.add_argument("--controls-exit-code", type=int)
    parser.add_argument("--end-state", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if not all(len(value) == 40 and set(value) <= set("0123456789abcdef") for value in (args.expected_head, args.expected_tree)):
        parser.error("Expected identities must be full lowercase SHA-1 IDs")
    checks = []

    def check(name, condition, evidence="recorded_values"):
        checks.append({"check": name, "passed": bool(condition), "evidence": evidence})

    raw, provenance = {}, {}
    try:
        for fixture in FILES:
            result_bytes = (args.runtime_dir / RESULT_FILES[fixture]).read_bytes()
            script_bytes = (args.replay_dir / FILES[fixture]).read_bytes()
            raw[fixture] = json.loads(result_bytes)
            if not isinstance(raw[fixture], dict):
                raise ValueError("Result must be an object")
            provenance[fixture] = {
                "result_sha256": digest(result_bytes),
                "harness_sha256": digest(script_bytes),
                "recorded_head_matches_expected": raw[fixture].get("head") == args.expected_head,
                "recorded_tree_matches_expected": raw[fixture].get("sourceTree") == args.expected_tree,
                "host_command_exit_code": getattr(args, fixture + "_exit_code"),
            }
            check(f"{fixture}_pinned_harness", digest(script_bytes) == PINNED_HARNESS[fixture], "script_sha256")
            check(f"{fixture}_source_head", provenance[fixture]["recorded_head_matches_expected"])
            check(f"{fixture}_source_tree", provenance[fixture]["recorded_tree_matches_expected"])
            check(f"{fixture}_host_command_exit_zero", provenance[fixture]["host_command_exit_code"] == 0, "caller_supplied_host_exit_status")
            exit_path = args.runtime_dir / f"{fixture}-exit-code.txt"
            if exit_path.exists():
                exit_bytes = exit_path.read_bytes()
                recorded_exit = int(exit_bytes.decode().strip())
                provenance[fixture]["host_exit_receipt_sha256"] = digest(exit_bytes)
                check(f"{fixture}_host_exit_receipt_matches", recorded_exit == provenance[fixture]["host_command_exit_code"], "host_exit_receipt")
            log_path = args.runtime_dir / f"{fixture}-host.log"
            if log_path.exists():
                log_bytes = log_path.read_bytes()
                log_lines = log_bytes.decode().splitlines()
                closed_lines = [line for line in log_lines if "remainingFixtureChildrenTerminated " in line]
                cleanup_counts = [len(json.loads(line.split("remainingFixtureChildrenTerminated ", 1)[1])) for line in closed_lines]
                clean_shutdown_count = sum("[shutdown] completed cleanly in " in line for line in log_lines)
                elapsed = [float(match[1]) for line in log_lines if (match := re.fullmatch(r"([0-9]+(?:\.[0-9]+)?) seconds", line))]
                provenance[fixture].update({"host_log_sha256": digest(log_bytes), "fixture_closed_marker_count": len(closed_lines), "owned_idle_children_signaled_on_cleanup": cleanup_counts, "gateway_clean_shutdown_marker_count": clean_shutdown_count, "cleanup_evidence_scope": "Original fixture host checked each recorded PID's exact fixture command path before SIGTERM. No child-exit join or global reaping assertion; later process-namespace continuity was not established.", "elapsed_seconds_recorded": elapsed[-1] if elapsed else None})
                check(f"{fixture}_one_completed_cleanup_marker", len(closed_lines) == 1, "host_log")
                check(f"{fixture}_one_clean_gateway_shutdown_marker", clean_shutdown_count == 1, "host_log")
        end_state = json.loads(args.end_state.read_bytes()) if args.end_state else None
    except (OSError, ValueError, TypeError):
        # Never print raw exception messages: paths/result data are private.
        print("Evidence input is missing, unreadable, or not valid JSON; no report was generated.")
        return 2

    def rows(fixture, kind, agent=None):
        return [row for row in raw[fixture].get("results", []) if isinstance(row, dict) and row.get("kind") == kind and (agent is None or row.get("agent") == agent)]

    readonly = []
    for agent in AGENTS:
        found = rows("readonly", "readonly-talk", agent)
        check(f"readonly_{agent}_one_result", len(found) == 1)
        row = found[0] if len(found) == 1 else {}
        result = row.get("result", {})
        answer_ok = isinstance(result, dict) and result.get("text") == ANSWERS[agent] and "error" not in row
        check(f"readonly_{agent}_expected_answer", answer_ok)
        check(f"readonly_{agent}_restricted_scopes", row.get("scopes") == ["operator.read", "operator.talk"])
        history = history_summary(row.get("history"))
        check(f"readonly_{agent}_history_available", history.get("available"))
        check(f"readonly_{agent}_generated_prompt_hidden", history.get("visible_generated_consult_user_count") == 0)
        readonly.append({"agent": agent, "expected_fixture_answer_observed": answer_ok, "error_name": error_name(row.get("error")), "restricted_scopes_recorded": row.get("scopes") == ["operator.read", "operator.talk"], "history": history})
    normal = []
    for kind in ("normal", "normal-fallback"):
        found = rows("readonly", kind)
        check(f"{kind}_one_result", len(found) == 1)
        row = found[0] if len(found) == 1 else {}
        waited = row.get("waited", {})
        ok = isinstance(waited, dict) and waited.get("status") == "ok"
        check(f"{kind}_wait_status_ok", ok)
        normal.append({"kind": kind, "wait_status_ok": ok})
    launches = [row for row in raw["readonly"].get("cli", []) if isinstance(row, dict) and row.get("kind") == "launch" and isinstance(row.get("argv"), list) and all(isinstance(arg, str) for arg in row["argv"]) and "--input-format" in row["argv"]]
    policies = [{"launch_ordinal": index + 1, **policy_summary(row["argv"])} for index, row in enumerate(launches)]
    # Fixture order: main Talk, fallback Talk, normal main, normal fallback.
    # Require exactly four JSONL launches before assigning the first two to Talk.
    check("readonly_exactly_four_jsonl_launches_for_ordered_policy_mapping", len(launches) == 4)
    check("readonly_first_two_talk_launches_reduced", len(policies) == 4 and all(row["reduced_launch_policy_observed"] for row in policies[:2]))

    claims, histories = [], []
    for agent in AGENTS:
        found = rows("controls", "claimed-consult", agent)
        check(f"controls_{agent}_two_claimed_turns", len(found) == 2 and {row.get("turn") for row in found} == {0, 1})
        for turn in (0, 1):
            matching = [row for row in found if row.get("turn") == turn]
            row = matching[0] if len(matching) == 1 else {}
            ok = row.get("claimed") is True and isinstance(row.get("result"), dict) and row["result"].get("text") == ANSWERS[agent]
            check(f"controls_{agent}_turn_{turn}_answer_and_claim", ok)
            claims.append({"agent": agent, "turn": turn, "answer_and_first_claim_observed": ok})
        snapshots = {}
        for kind in ("before-history", "after-history"):
            found = rows("controls", kind, agent)
            check(f"controls_{agent}_{kind}_one_snapshot", len(found) == 1)
            snapshots[kind] = history_summary(found[0].get("history") if len(found) == 1 else None)
        before, after = snapshots["before-history"], snapshots["after-history"]
        check(f"controls_{agent}_initial_sentinel_visible", before.get("human_sentinel_user_count") == 1)
        check(f"controls_{agent}_initial_answers_absent", before.get("cli_assistant_answer_count") == 0 and before.get("loopback_assistant_answer_count") == 0)
        key = "cli_assistant_answer_count" if agent == "main" else "loopback_assistant_answer_count"
        other = "loopback_assistant_answer_count" if agent == "main" else "cli_assistant_answer_count"
        check(f"controls_{agent}_two_answers_retained", after.get(key) == 2 and after.get(other) == 0)
        check(f"controls_{agent}_only_two_visible_assistant_messages", after.get("visible_assistant_count") == 2)
        check(f"controls_{agent}_generated_prompts_hidden", after.get("visible_generated_consult_user_count") == 0)
        check(f"controls_{agent}_no_other_visible_user_turns", after.get("visible_user_count") == after.get("human_sentinel_user_count") and after.get("available"))
        if agent != "direct":
            check(f"controls_{agent}_human_sentinel_retained", after.get("human_sentinel_user_count") == 1)
        histories.append({"agent": agent, "before": before, "after_two_turns": after, "direct_sentinel_regression_gate": "not asserted; report this observation without claiming a fresh baseline comparison" if agent == "direct" else None})

    steering_rows = rows("controls", "cli-steering-replacement")
    steering = steering_rows[0] if len(steering_rows) == 1 else {}
    check("controls_cli_steering_replacement_one_result", len(steering_rows) == 1)
    steering_ok = error_name(steering.get("steeringError")) == "NotSupportedError" and error_name(steering.get("cancelled", {}).get("error")) == "AbortError" and steering.get("replacement") == {"text": "CLI_FIXTURE_ANSWER"}
    check("controls_cli_steering_cancel_replacement", steering_ok)
    boundary_rows = rows("controls", "transition-cancellation")
    boundary = boundary_rows[0] if len(boundary_rows) == 1 else {}
    boundary_ok = len(boundary_rows) == 1 and boundary.get("transitionObserved") is True and boundary.get("successorRequests") == 0 and error_name(boundary.get("cancelled", {}).get("error")) == "AbortError"
    check("controls_candidate_boundary_cancel_no_successor", boundary_ok)
    cancel_rows = rows("controls", "cancellation", "direct")
    cancel = cancel_rows[0] if len(cancel_rows) == 1 else {}
    cancel_ok = len(cancel_rows) == 1 and error_name(cancel.get("cancelled", {}).get("error")) == "AbortError" and cancel.get("failureClaim") is False
    check("controls_direct_cancellation_and_no_failure_claim", cancel_ok)
    cancel_history = history_summary(cancel.get("history"))
    check("controls_direct_cancel_no_extra_answer", cancel_history.get("loopback_assistant_answer_count") == 2 and cancel_history.get("cli_assistant_answer_count") == 0)
    direct_after = next(row["after_two_turns"] for row in histories if row["agent"] == "direct")
    check("controls_direct_cancel_visible_history_unchanged", cancel_history == direct_after and cancel_history.get("available"))
    check("controls_direct_cancel_prompt_hidden", cancel_history.get("visible_generated_consult_user_count") == 0)

    lifecycle = {fixture: lifecycle_summary(raw[fixture], fixture) for fixture in FILES}
    readonly_runs = lifecycle["readonly"]["runs"]
    check("readonly_five_distinct_recorded_lifecycle_runs", len(readonly_runs) == 5)
    check("readonly_each_run_has_exactly_one_end_terminal", len(readonly_runs) == 5 and all(row["terminal_phases"] == ["end"] for row in readonly_runs))
    check("readonly_lifecycle_route_cardinality", Counter(row["route"] for row in readonly_runs) == Counter({"main": 1, "withfallback": 1, "direct": 1, "normal-main": 1, "normal-fallback": 1}))
    check("readonly_no_malformed_lifecycle_events", lifecycle["readonly"]["malformed_lifecycle_event_count"] == 0)
    control_runs = lifecycle["controls"]["runs"]
    check("controls_ten_distinct_recorded_lifecycle_runs", len(control_runs) == 10)
    check("controls_each_run_has_exactly_one_terminal", len(control_runs) == 10 and all(row["terminal_count"] == 1 for row in control_runs))
    check("controls_lifecycle_route_cardinality", Counter(row["route"] for row in control_runs) == Counter({"main": 4, "withfallback": 3, "direct": 3}))
    check("controls_terminal_outcomes_seven_end_three_error", Counter(phase for row in control_runs for phase in row["terminal_phases"]) == Counter({"end": 7, "error": 3}))
    for route, expected in {"main": ["end", "end", "error", "end"], "withfallback": ["end", "end", "error"], "direct": ["end", "end", "error"]}.items():
        check(f"controls_{route}_terminal_order_matches_scenarios", [row["terminal_phases"] for row in control_runs if row["route"] == route] == [[phase] for phase in expected])
    check("controls_no_malformed_lifecycle_events", lifecycle["controls"]["malformed_lifecycle_event_count"] == 0)
    # Require the final fallback run to contain the observed boundary then one error.
    fallback_runs = [row for row in control_runs if row["route"] == "withfallback"]
    check("controls_cancelled_fallback_run_has_boundary_and_one_error", len(fallback_runs) == 3 and fallback_runs[-1]["fallback_next_candidate_event_count"] >= 1 and fallback_runs[-1]["terminal_phases"] == ["error"])
    for fixture in FILES:
        check(f"{fixture}_result_arrays_well_formed", all(isinstance(raw[fixture].get(key), list) for key in ("results", "cli", "requests", "events")))
    missing_status = any(provenance[fixture]["host_command_exit_code"] is None for fixture in FILES)
    post_state = {
        "supplied": end_state is not None,
        "expected_head_match": isinstance(end_state, dict) and end_state.get("head") == args.expected_head,
        "expected_tree_match": isinstance(end_state, dict) and end_state.get("sourceTree") == args.expected_tree,
        "tracked_worktree_clean": isinstance(end_state, dict) and end_state.get("trackedWorktreeClean") is True,
        "untracked_files_reported_absent": isinstance(end_state, dict) and end_state.get("untrackedFiles") == [],
        "receipt_sha256": digest(args.end_state.read_bytes()) if args.end_state else None,
        "method": "Caller-supplied post-run observation; extractor does not access checkout or Git index",
    }
    if end_state is not None:
        check("post_run_identity_and_clean_worktree", post_state["expected_head_match"] and post_state["expected_tree_match"] and post_state["tracked_worktree_clean"], "caller_supplied_post_run_source_observation")
    failed = [item["check"] for item in checks if not item["passed"]]
    report = {
        "schema_version": 1,
        "status": "incomplete_missing_host_command_status" if missing_status else ("scoped_checks_failed" if failed else "scoped_checks_passed"),
        "scope": "Isolated real source Gateway with actual host-injected consultation callback, deterministic local CLI JSONL executable, and HTTP loopback model fixture; synthetic Talk media offer is nonfunctional",
        "expected_source_head": args.expected_head,
        "expected_source_tree": args.expected_tree,
        "publication_readiness": "Not decided by this extractor; reconcile scoped checks, unproven fields, complete host logs, source/build provenance, and separately recorded regression/gate results",
        "provenance": {"inputs": provenance, "post_run_state": post_state, "extractor_sha256": digest(Path(__file__).read_bytes()), "not_a_committed_head_claim": True},
        "observed": {
            "readonly_talk": readonly,
            "ordinary_writer_controls": normal,
            "readonly_cli_launch_policy": {"mapping_basis": "first two of exactly four JSONL launches, using fixed sequential fixture order; launch-policy observation, not attempted tool-call enforcement", "launches": policies},
            "adopted_claim_turns": claims,
            "history": histories,
            "cli_steering_cancel_replacement": {"recorded_contract_satisfied": steering_ok},
            "candidate_boundary_cancellation": {"recorded_contract_satisfied": boundary_ok, "successor_http_requests": 0 if boundary.get("successorRequests") == 0 else None, "scope": "same configured CLI-to-HTTP fallback boundary exercised once"},
            "direct_cancellation": {"recorded_contract_satisfied": cancel_ok, "history": cancel_history, "upstream_close_awaited_before_record": len(cancel_rows) == 1 and provenance["controls"]["harness_sha256"] == PINNED_HARNESS["controls"]},
            "terminal_events": lifecycle,
        },
        "harness_assertions_not_independently_recorded": [
            "Each of six repeated adopted successful turns refuses a second claimAppend; requires unchanged harness and successful host exit",
            "CLI steering rejection does not itself abort its signal; later explicit cancellation rejects and denies failure claim; replacement claims once",
            "Candidate-boundary cancellation denies failure append claim",
        ],
        "checks": checks,
        "failed_checks": failed,
        "unproven": [
            "Actual provider sendAppend or browser/voice assistant transcript append custody; claimAppend only proves claim acceptance, not an append side effect",
            "Preflight-failure terminal-backstop/adopted-failure append custody; these replay scenarios do not exercise it; report production regressions separately",
            "Live microphone, functioning WebRTC/media, commercial provider or real Claude Code integration, device, installed package, updater, release, or deployment",
            "Reduced-tool enforcement against an attempted forbidden tool call; replay observes launch arguments only",
            "Fresh baseline comparison on the current main base; recovered publication is prior-source evidence only",
            "Exhaustive cancellation boundaries, fallback directions, multi-candidate/retry schedules, reconnect races, or events emitted after the saved snapshot",
            "Joined CLI-child shutdown or global child reaping; unchanged fixtures record command-path-checked SIGTERM attempts but do not await child exits, and later process-namespace continuity was not established",
            "Current toolchain/dependency versions, build identity, external review, full checks, or CI status unless separately established",
        ],
        "sanitization": "Whitelist-only derivation. No raw Gateway events, run/session identifiers, runtime grants, full argv/prompts, host paths/PIDs/ports, error messages, credentials, or raw logs included.",
    }
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"status": report["status"], "failed_checks": failed, "report_sha256": digest(args.output.read_bytes())}))
    return 2 if missing_status else (1 if failed else 0)


if __name__ == "__main__":
    raise SystemExit(main())
