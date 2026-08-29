#!/usr/bin/env python3
"""Run redacted, real-environment smoke checks against the ytops CLI.

This script intentionally drives the built CLI instead of importing application
modules. It therefore exercises the same public JSON/exit-code contract that a
user or skill would use. No OAuth code, state, token, secret, cookie, or raw API
response is written to the report.

The default suite is safe to run before an OAuth connection exists. Use
``--suite full`` only after selecting a test channel and, where applicable,
providing a public video URL and Reporting report type. OAuth authorization is
interactive and must be opted into with ``--auth-start`` or ``--auth-complete``.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import webbrowser
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Sequence


DEFAULT_REDIRECT_URI = "http://127.0.0.1:8765/oauth2callback"

SENSITIVE_KEY_RE = re.compile(
    r"(?:access.?token|refresh.?token|client.?secret|authorization|cookie|"
    r"password|api.?key|credential|private.?key|jwt|channel.?id|video.?id|"
    r"playlist.?id|report.?id|job.?id)",
    re.IGNORECASE,
)
SENSITIVE_VALUE_RE = re.compile(
    r"(?:Bearer\s+\S+|AIza[A-Za-z0-9_-]{20,}|ya29\.[A-Za-z0-9._-]+|"
    r"1//[A-Za-z0-9_-]+|GOCSPX-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)",
    re.IGNORECASE,
)
CHANNEL_ID_RE = re.compile(r"^UC[A-Za-z0-9_-]{22}$")
PROJECT_ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class CommandResult:
    args: tuple[str, ...]
    exit_code: int
    payload: dict[str, Any] | None
    stdout: str
    stderr: str
    duration_ms: int


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="对已构建的 ytops CLI 执行脱敏真实环境测试。"
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=PROJECT_ROOT / "ytops-config.json",
        help="已初始化的频道运营配置路径（默认：ytops-config.json）",
    )
    parser.add_argument(
        "--cli",
        type=Path,
        default=PROJECT_ROOT / "dist" / "cli.js",
        help="构建后的 CLI 入口（默认：dist/cli.js）",
    )
    parser.add_argument(
        "--suite",
        choices=("smoke", "full"),
        default="smoke",
        help="smoke 只检查公开链路、配置和 OAuth 环境；full 追加频道只读 API。",
    )
    parser.add_argument(
        "--channel",
        help="已完成 OAuth 接入并显式选择的频道 ID（full 必需）",
    )
    parser.add_argument(
        "--video-url",
        help="用于 inspect/captions list 的公开单视频 HTTPS URL",
    )
    parser.add_argument(
        "--search-query",
        default="YouTube",
        help="公开搜索词（默认：YouTube）",
    )
    parser.add_argument(
        "--search-limit",
        type=int,
        default=3,
        help="公开搜索结果数量，范围 1-50（默认：3）",
    )
    parser.add_argument(
        "--report-type",
        help="Reporting 官方 reportTypeId；full 且启用 Reporting 时必需",
    )
    parser.add_argument(
        "--redirect-uri",
        default=os.environ.get("YTOPS_GOOGLE_OAUTH_REDIRECT_URI", DEFAULT_REDIRECT_URI),
        help="OAuth 回调地址（默认读取 YTOPS_GOOGLE_OAUTH_REDIRECT_URI）",
    )
    parser.add_argument(
        "--auth-start",
        action="store_true",
        help="显式启动 OAuth；配合 --open-browser 打开授权页面",
    )
    parser.add_argument(
        "--open-browser",
        action="store_true",
        help="与 --auth-start 一起使用时打开授权地址（地址不会写入报告）",
    )
    parser.add_argument(
        "--show-auth-url",
        action="store_true",
        help="显式在终端显示一次性 OAuth 授权地址；不要保存或转发该地址",
    )
    parser.add_argument(
        "--auth-complete",
        action="store_true",
        help="显式完成 OAuth；code/state 从环境变量读取，不在命令行中传递",
    )
    parser.add_argument(
        "--oauth-code-env",
        default="YTOPS_OAUTH_CODE",
        help="OAuth 一次性 code 所在环境变量（默认：YTOPS_OAUTH_CODE）",
    )
    parser.add_argument(
        "--oauth-state-env",
        default="YTOPS_OAUTH_STATE",
        help="OAuth state 所在环境变量（默认：YTOPS_OAUTH_STATE）",
    )
    parser.add_argument(
        "--with-analytics-scope",
        action="store_true",
        help="auth-start 时显式请求 Analytics 只读 scope",
    )
    parser.add_argument(
        "--with-comments-scope",
        action="store_true",
        help="auth-start 时显式请求评论读取 scope",
    )
    parser.add_argument(
        "--include-analytics",
        action="store_true",
        help="full 套件中执行 Analytics；需要已授权 Analytics scope",
    )
    parser.add_argument(
        "--include-breakdown",
        action="store_true",
        help="full 套件中执行一次高维 Analytics（日维度）查询",
    )
    parser.add_argument(
        "--include-reporting",
        action="store_true",
        help="full 套件中执行 Reporting；需要 --report-type",
    )
    parser.add_argument(
        "--include-comments",
        action="store_true",
        help="full 套件中执行评论同步；需要已授权评论 scope",
    )
    parser.add_argument(
        "--media-file",
        type=Path,
        help="本地媒体文件；提供后执行 process probe",
    )
    parser.add_argument(
        "--include-local-media",
        action="store_true",
        help="在临时目录执行 process audio/clip；需要 --media-file",
    )
    parser.add_argument(
        "--download-url",
        help="已获授权的单视频 URL；用于可选下载/字幕工件检查",
    )
    parser.add_argument(
        "--download-output-dir",
        type=Path,
        help="可选下载输出目录；不会自动清理其中已有文件",
    )
    parser.add_argument(
        "--include-authorized-media",
        action="store_true",
        help="执行 captions fetch 和 download；必须同时确认权利",
    )
    parser.add_argument(
        "--download-kind",
        choices=("audio", "video", "both"),
        default="audio",
        help="授权下载类型（默认：audio）",
    )
    parser.add_argument(
        "--download-language",
        default="en",
        help="授权字幕语言（默认：en）",
    )
    parser.add_argument(
        "--rights-confirmed",
        action="store_true",
        help="确认对 --download-url 内容拥有使用或下载权利",
    )
    parser.add_argument(
        "--include-scheduler-status",
        action="store_true",
        help="读取 Windows 调度任务状态（只读）",
    )
    parser.add_argument(
        "--include-scheduler-run",
        action="store_true",
        help="执行一次到期同步调度周期；可能触发多个频道同步",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=float,
        default=120.0,
        help="每个 CLI 调用的超时时间（默认：120 秒）",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="输出完整脱敏 JSON 报告；默认输出摘要",
    )
    return parser.parse_args()


def redact_text(value: str) -> str:
    """Remove known credential-shaped values before any text reaches output."""
    redacted = SENSITIVE_VALUE_RE.sub("<已隐藏>", value)
    redacted = re.sub(r"https?://\S+", "<URL>", redacted)
    redacted = re.sub(r"UC[A-Za-z0-9_-]{22}", "<频道ID>", redacted)
    redacted = re.sub(
        r"(?i)(client[_-]?secret|refresh[_-]?token|access[_-]?token|authorization|cookie|password|api[_-]?key|code|state)\s*[:=]\s*[^\s,;]+",
        r"\1=<已隐藏>",
        redacted,
    )
    return redacted


def redact_command_args(args: Sequence[str]) -> str:
    sensitive_options = {
        "--code",
        "--state",
        "--client-secret",
        "--access-token",
        "--refresh-token",
    }
    path_options = {
        "--config",
        "--output-dir",
        "--download-output-dir",
        "--output",
    }
    redacted: list[str] = []
    hide_next = False
    hide_after_commands = {"search"}
    for arg in args:
        if hide_next:
            redacted.append("<已隐藏>")
            hide_next = False
            continue
        if redacted and redacted[-1] in hide_after_commands:
            redacted.append("<搜索词>")
        elif CHANNEL_ID_RE.fullmatch(arg):
            redacted.append("<频道ID>")
        elif arg.startswith("https://"):
            redacted.append("<URL>")
        elif re.match(r"^(?:[A-Za-z]:[\\/]|[.]{0,2}[\\/]|/)", arg):
            redacted.append("<路径>")
        else:
            redacted.append(redact_text(arg))
        if arg in sensitive_options or arg in path_options:
            hide_next = True
    return "ytops --json " + " ".join(redacted)


def redact_value(value: Any, *, key: str | None = None) -> Any:
    if key is not None and SENSITIVE_KEY_RE.search(key) and isinstance(value, str):
        return "<已隐藏>"
    if isinstance(value, dict):
        return {str(k): redact_value(v, key=str(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [redact_value(item) for item in value]
    if isinstance(value, str):
        return redact_text(value)
    return value


def summarize_payload(payload: dict[str, Any] | None) -> dict[str, Any]:
    if payload is None:
        return {"json": False}

    summary: dict[str, Any] = {
        "json": True,
        "ok": payload.get("ok"),
    }
    data = payload.get("data")
    error = payload.get("error")
    if isinstance(error, dict):
        summary["error"] = {
            "code": error.get("code"),
            "kind": error.get("kind"),
            "retryable": error.get("retryable"),
            "message": redact_text(str(error.get("message", ""))),
        }
    if isinstance(data, dict):
        for key in (
            "valid",
            "created",
            "updated",
            "profileName",
            "youtubeDataClientIdConfigured",
            "youtubeDataClientSecretConfigured",
            "status",
            "coverage",
            "selectionRequired",
            "selectedChannelId",
            "channelId",
            "source",
            "dataAsOf",
            "reportStatus",
            "rowCount",
            "pages",
            "items",
        ):
            if key in data:
                summary[key] = redact_value(data[key], key=key)
        for key in (
            "videos",
            "channels",
            "availableChannels",
            "connections",
            "entries",
            "rows",
            "comments",
        ):
            candidate = data.get(key)
            if isinstance(candidate, list):
                count_key = (
                    "availableChannelsCount"
                    if key == "availableChannels"
                    else f"{key}Count"
                )
                summary[count_key] = len(candidate)
        tools = data.get("tools")
        if isinstance(tools, list):
            summary["tools"] = [
                {
                    "name": item.get("name"),
                    "required": item.get("required"),
                    "available": item.get("available"),
                    "version": item.get("version"),
                }
                for item in tools
                if isinstance(item, dict)
            ]
        scopes = data.get("scopes")
        if isinstance(scopes, list) and all(
            isinstance(scope, str) for scope in scopes
        ):
            summary["scopes"] = [scope.rsplit("/", 1)[-1] for scope in scopes]
        coverage_entries = data.get("entries")
        if isinstance(coverage_entries, list):
            summary["coverageEntries"] = [
                {
                    "capability": item.get("capability"),
                    "status": item.get("status"),
                    "reportStatus": item.get("reportStatus"),
                }
                for item in coverage_entries
                if isinstance(item, dict)
            ]
        state = data.get("state")
        if isinstance(state, dict):
            summary["state"] = {
                key: redact_value(state[key], key=key)
                for key in (
                    "status",
                    "coverage",
                    "phase",
                    "dataAsOf",
                    "nextRetryAt",
                    "rowCount",
                    "pages",
                    "items",
                    "error",
                )
                if key in state
            }
        if isinstance(data.get("task"), dict):
            task = data["task"]
            summary["task"] = {
                key: redact_value(task[key], key=key)
                for key in ("status", "coverage", "dataAsOf", "nextRetryAt", "error")
                if key in task
            }
    return redact_value(summary)


def command_succeeded(result: CommandResult) -> bool:
    return (
        result.exit_code == 0
        and isinstance(result.payload, dict)
        and result.payload.get("ok") is True
    )


def payload_has_terminal_failure(payload: dict[str, Any] | None) -> bool:
    if not isinstance(payload, dict):
        return True
    data = payload.get("data")
    if not isinstance(data, dict):
        return False
    if (
        data.get("status") in {"unavailable", "failed"}
        and not payload_has_accepted_restriction(payload)
    ):
        return True
    if data.get("success") is False and not payload_has_accepted_restriction(payload):
        return True
    for container_key in ("state", "task"):
        container = data.get(container_key)
        if (
            isinstance(container, dict)
            and container.get("status") == "failed"
            and not payload_has_accepted_restriction(payload)
        ):
            return True
    return False


def payload_has_accepted_restriction(payload: dict[str, Any] | None) -> bool:
    if not isinstance(payload, dict):
        return False
    data = payload.get("data")
    if not isinstance(data, dict):
        return False
    accepted_coverages = {"permission-denied", "qualification-limited"}
    if data.get("coverage") in accepted_coverages or data.get("status") in accepted_coverages:
        return True
    for container_key in ("state", "task"):
        container = data.get(container_key)
        if isinstance(container, dict) and container.get("coverage") in accepted_coverages:
            return True
        if isinstance(container, dict):
            error = container.get("error")
            if isinstance(error, dict) and error.get("kind") in {
                "permission",
                "permission-denied",
                "qualification",
            }:
                return True
    error = data.get("error")
    if isinstance(error, dict) and error.get("kind") in {
        "permission",
        "permission-denied",
        "qualification",
    }:
        return True
    return False


def run_cli(
    cli_path: Path,
    args: Sequence[str],
    *,
    timeout_seconds: float,
    drop_environment: Sequence[str] = (),
) -> CommandResult:
    command = ("node", str(cli_path), "--json", *args)
    started = time.monotonic()
    child_environment = os.environ.copy()
    for name in drop_environment:
        child_environment.pop(name, None)
    try:
        completed = subprocess.run(
            command,
            cwd=cli_path.parent.parent if cli_path.parent.name == "dist" else Path.cwd(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
            check=False,
            env=child_environment,
        )
        exit_code = completed.returncode
        stdout = completed.stdout
        stderr = completed.stderr
    except subprocess.TimeoutExpired as error:
        exit_code = 124
        timeout_stdout = error.stdout or ""
        stdout = (
            timeout_stdout.decode("utf-8", errors="replace")
            if isinstance(timeout_stdout, bytes)
            else timeout_stdout
        )
        stderr = f"命令超过 {timeout_seconds:g} 秒未完成。"
    except OSError as error:
        exit_code = 127
        stdout = ""
        stderr = f"无法启动 CLI：{error}"

    payload: dict[str, Any] | None
    try:
        parsed = json.loads(stdout)
        payload = parsed if isinstance(parsed, dict) else None
    except (json.JSONDecodeError, TypeError):
        payload = None

    return CommandResult(
        args=tuple(args),
        exit_code=exit_code,
        payload=payload,
        stdout=stdout,
        stderr=stderr,
        duration_ms=round((time.monotonic() - started) * 1000),
    )


def result_record(name: str, result: CommandResult, *, expected_success: bool | None = None) -> dict[str, Any]:
    json_ok = isinstance(result.payload, dict)
    command_ok = command_succeeded(result)
    terminal_failure = payload_has_terminal_failure(result.payload)
    accepted_restriction = command_ok and payload_has_accepted_restriction(result.payload)
    actual_success = command_ok and not terminal_failure and not accepted_restriction
    record: dict[str, Any] = {
        "name": name,
        "command": redact_command_args(result.args),
        "exitCode": result.exit_code,
        "durationMs": result.duration_ms,
        "success": actual_success,
        "acceptedRestriction": accepted_restriction,
        "payload": summarize_payload(result.payload),
    }
    if expected_success is not None:
        record["expectedSuccess"] = expected_success
        record["passed"] = actual_success == expected_success
    else:
        record["passed"] = actual_success or accepted_restriction
    if result.stderr.strip():
        record["stderrPresent"] = True
        record["stderrLength"] = len(result.stderr)
    if not json_ok and result.stdout.strip():
        record["stdoutPresent"] = True
        record["stdoutLength"] = len(result.stdout)
    return record


def append_check(
    checks: list[dict[str, Any]],
    name: str,
    result: CommandResult,
    *,
    expected_success: bool | None = None,
) -> None:
    checks.append(result_record(name, result, expected_success=expected_success))


def append_skipped(
    checks: list[dict[str, Any]], name: str, reason: str
) -> None:
    checks.append(
        {
            "name": name,
            "command": "未执行",
            "exitCode": None,
            "durationMs": 0,
            "success": None,
            "passed": True,
            "skipped": True,
            "reason": reason,
        }
    )


def require_existing_path(path: Path, label: str) -> str | None:
    if not path.exists():
        return f"{label}不存在：<路径>"
    if not path.is_file():
        return f"{label}不是文件：<路径>"
    return None


def validate_inputs(options: argparse.Namespace) -> list[str]:
    errors: list[str] = []
    if options.search_limit < 1 or options.search_limit > 50:
        errors.append("--search-limit 必须在 1-50 之间。")
    if options.timeout_seconds <= 0:
        errors.append("--timeout-seconds 必须大于 0。")
    if options.channel and not CHANNEL_ID_RE.fullmatch(options.channel):
        errors.append("--channel 不是有效的 YouTube 频道 ID。")
    if options.suite == "full" and not options.channel:
        errors.append("--suite full 必须提供 --channel。")
    if options.include_reporting and not options.report_type:
        errors.append("--include-reporting 必须同时提供 --report-type。")
    if options.suite != "full" and any(
        (
            options.include_analytics,
            options.include_breakdown,
            options.include_reporting,
            options.include_comments,
        )
    ):
        errors.append("频道 Analytics、Reporting 和评论检查只能在 --suite full 中启用。")
    if options.include_local_media and not options.media_file:
        errors.append("--include-local-media 必须同时提供 --media-file。")
    if options.include_authorized_media:
        if not options.download_url:
            errors.append("--include-authorized-media 必须同时提供 --download-url。")
        if not options.download_output_dir:
            errors.append(
                "--include-authorized-media 必须同时提供 --download-output-dir。"
            )
        if not options.rights_confirmed:
            errors.append(
                "--include-authorized-media 必须同时提供 --rights-confirmed。"
            )
    if options.rights_confirmed and not options.include_authorized_media:
        errors.append("--rights-confirmed 只能与 --include-authorized-media 一起使用。")
    if options.include_scheduler_run and options.suite != "full":
        errors.append("--include-scheduler-run 只能在 --suite full 中使用。")
    if options.auth_complete:
        if not os.environ.get(options.oauth_code_env, "").strip():
            errors.append(f"--auth-complete 需要环境变量 {options.oauth_code_env}。")
        if not os.environ.get(options.oauth_state_env, "").strip():
            errors.append(f"--auth-complete 需要环境变量 {options.oauth_state_env}。")
    if options.open_browser and not options.auth_start:
        errors.append("--open-browser 只能与 --auth-start 一起使用。")
    if options.show_auth_url and not options.auth_start:
        errors.append("--show-auth-url 只能与 --auth-start 一起使用。")
    return errors


def build_auth_start_args(options: argparse.Namespace) -> list[str]:
    args = [
        "ops",
        "channel",
        "auth-start",
        "--config",
        str(options.config),
        "--redirect-uri",
        options.redirect_uri,
    ]
    if options.with_analytics_scope:
        args.append("--analytics")
    if options.with_comments_scope:
        args.append("--comments")
    return args


def run_smoke_suite(options: argparse.Namespace, checks: list[dict[str, Any]]) -> dict[str, Any] | None:
    doctor = run_cli(options.cli, ("doctor",), timeout_seconds=options.timeout_seconds)
    append_check(checks, "public.doctor", doctor)

    config = run_cli(
        options.cli,
        ("config", "validate", "--config", str(options.config)),
        timeout_seconds=options.timeout_seconds,
    )
    append_check(checks, "config.validate", config)

    ops_doctor = run_cli(options.cli, ("ops", "doctor"), timeout_seconds=options.timeout_seconds)
    append_check(checks, "oauth.environment", ops_doctor)

    channel_list = run_cli(
        options.cli,
        ("ops", "channel", "list", "--config", str(options.config)),
        timeout_seconds=options.timeout_seconds,
    )
    append_check(checks, "oauth.channel-list", channel_list)

    config_explain = run_cli(
        options.cli,
        ("config", "explain"),
        timeout_seconds=options.timeout_seconds,
    )
    append_check(checks, "config.explain", config_explain)

    search = run_cli(
        options.cli,
        ("search", options.search_query, "--limit", str(options.search_limit)),
        timeout_seconds=options.timeout_seconds,
    )
    append_check(checks, "public.search", search)

    if options.video_url:
        inspect = run_cli(
            options.cli,
            ("inspect", options.video_url),
            timeout_seconds=options.timeout_seconds,
        )
        append_check(checks, "public.inspect", inspect)
        captions = run_cli(
            options.cli,
            ("captions", "list", options.video_url),
            timeout_seconds=options.timeout_seconds,
        )
        append_check(checks, "public.captions-list", captions)

    if options.media_file:
        media_error = require_existing_path(options.media_file, "本地媒体文件")
        if media_error:
            checks.append(
                {
                    "name": "local.media-input",
                    "command": "process probe",
                    "exitCode": 2,
                    "durationMs": 0,
                    "success": False,
                    "passed": False,
                    "reason": redact_text(media_error),
                }
            )
        else:
            probe = run_cli(
                options.cli,
                ("process", "probe", str(options.media_file)),
                timeout_seconds=options.timeout_seconds,
            )
            append_check(checks, "local.media-probe", probe)
            if options.include_local_media:
                with tempfile.TemporaryDirectory(prefix="ytops-real-test-") as temp_dir:
                    audio_output = Path(temp_dir) / "audio.m4a"
                    clip_output = Path(temp_dir) / "clip.mp4"
                    audio = run_cli(
                        options.cli,
                        (
                            "process",
                            "audio",
                            str(options.media_file),
                            "--output",
                            str(audio_output),
                            "--format",
                            "m4a",
                        ),
                        timeout_seconds=options.timeout_seconds,
                    )
                    append_check(checks, "local.media-audio", audio)
                    clip = run_cli(
                        options.cli,
                        (
                            "process",
                            "clip",
                            str(options.media_file),
                            "--start",
                            "00:00:00",
                            "--end",
                            "00:00:05",
                            "--output",
                            str(clip_output),
                        ),
                        timeout_seconds=options.timeout_seconds,
                    )
                    append_check(checks, "local.media-clip", clip)

    if options.include_authorized_media:
        if options.download_url is None or options.download_output_dir is None:
            append_skipped(
                checks,
                "authorized.media",
                "未提供授权媒体 URL 或输出目录。",
            )
            return auth_start_payload
        captions = run_cli(
            options.cli,
            (
                "captions",
                "fetch",
                options.download_url,
                "--language",
                options.download_language,
                "--output-dir",
                str(options.download_output_dir),
                "--rights-confirmed",
            ),
            timeout_seconds=options.timeout_seconds,
        )
        append_check(checks, "authorized.captions-fetch", captions)
        download_kinds = (
            ("audio",)
            if options.download_kind == "audio"
            else ("video",)
            if options.download_kind == "video"
            else ("audio", "video")
        )
        for kind in download_kinds:
            download = run_cli(
                options.cli,
                (
                    "download",
                    kind,
                    options.download_url,
                    "--output-dir",
                    str(options.download_output_dir),
                    "--rights-confirmed",
                ),
                timeout_seconds=options.timeout_seconds,
            )
            append_check(checks, f"authorized.download-{kind}", download)

    if options.include_scheduler_status:
        scheduler_status = run_cli(
            options.cli,
            (
                "ops",
                "channel",
                "scheduler",
                "status",
                "--config",
                str(options.config),
            ),
            timeout_seconds=options.timeout_seconds,
        )
        append_check(checks, "scheduler.status", scheduler_status)

    auth_start_payload: dict[str, Any] | None = None
    if options.auth_start:
        auth_start = run_cli(
            options.cli,
            build_auth_start_args(options),
            timeout_seconds=options.timeout_seconds,
        )
        append_check(checks, "oauth.auth-start", auth_start)
        if isinstance(auth_start.payload, dict) and auth_start.payload.get("ok") is True:
            data = auth_start.payload.get("data")
            if isinstance(data, dict):
                auth_start_payload = data
                authorization_url = data.get("authorizationUrl")
                if options.open_browser and isinstance(authorization_url, str):
                    try:
                        opened = webbrowser.open(authorization_url)
                    except Exception:
                        opened = False
                    if not opened:
                        checks.append(
                            {
                                "name": "oauth.browser-open",
                                "command": "打开授权页面",
                                "exitCode": 1,
                                "durationMs": 0,
                                "success": False,
                                "passed": False,
                                "reason": "无法自动打开默认浏览器，请手动使用 OAuth 授权流程。",
                            }
                        )
                if options.show_auth_url and isinstance(authorization_url, str):
                    print(
                        "一次性 OAuth 授权地址（不要保存、转发或写入日志）：",
                        file=sys.stderr,
                    )
                    print(authorization_url, file=sys.stderr)

    if options.auth_complete:
        complete = run_cli(
            options.cli,
            (
                "ops",
                "channel",
                "auth-complete",
                "--config",
                str(options.config),
                "--code",
                os.environ[options.oauth_code_env],
                "--state",
                os.environ[options.oauth_state_env],
            ),
            timeout_seconds=options.timeout_seconds,
            drop_environment=(options.oauth_code_env, options.oauth_state_env),
        )
        append_check(checks, "oauth.auth-complete", complete)

    return auth_start_payload


def run_full_suite(options: argparse.Namespace, checks: list[dict[str, Any]]) -> None:
    if options.channel is None:
        append_skipped(checks, "channel.suite", "未提供目标频道 ID。")
        return
    channel_args = ("--config", str(options.config), "--channel", options.channel)

    status = run_cli(
        options.cli,
        ("ops", "channel", "status", "--config", str(options.config)),
        timeout_seconds=options.timeout_seconds,
    )
    append_check(checks, "oauth.channel-status", status)

    status_data = status.payload.get("data") if isinstance(status.payload, dict) else None
    channel_ready = False
    if isinstance(status_data, dict) and status_data.get("selectionRequired") is True:
        selected = run_cli(
            options.cli,
            (
                "ops",
                "channel",
                "select",
                "--config",
                str(options.config),
                "--channel",
                options.channel,
            ),
            timeout_seconds=options.timeout_seconds,
        )
        append_check(checks, "oauth.channel-select", selected)
        selected_data = selected.payload.get("data") if isinstance(selected.payload, dict) else None
        channel_ready = command_succeeded(selected) and (
            not isinstance(selected_data, dict)
            or selected_data.get("status") == "connected"
        )
    elif isinstance(status_data, dict) and status_data.get("selectedChannelId") == options.channel:
        checks.append(
            {
                "name": "oauth.channel-select",
                "command": "未重复执行频道选择",
                "exitCode": 0,
                "durationMs": 0,
                "success": True,
                "passed": True,
                "skipped": True,
                "reason": "目标频道已经处于选中状态。",
            }
        )
        channel_ready = status_data.get("status") == "connected"
    else:
        checks.append(
            {
                "name": "oauth.channel-select",
                "command": "ops channel select",
                "exitCode": 1,
                "durationMs": 0,
                "success": False,
                "passed": False,
                "reason": "OAuth 状态没有待选择频道，且当前选中频道不是目标频道。",
            }
        )

    if not channel_ready and isinstance(status_data, dict):
        status_reason = status_data.get("reason")
        if isinstance(status_reason, str) and status_reason.strip():
            checks[-1]["reason"] = redact_text(status_reason)

    if channel_ready:
        inventory = run_cli(
            options.cli,
            ("ops", "channel", "sync", *channel_args, "--scope", "channel,uploads,videos"),
            timeout_seconds=options.timeout_seconds,
        )
        append_check(checks, "channel.inventory-sync", inventory)
        inventory_status = run_cli(
            options.cli,
            ("ops", "channel", "sync-status", *channel_args),
            timeout_seconds=options.timeout_seconds,
        )
        append_check(checks, "channel.inventory-status", inventory_status)
    else:
        reason = "目标频道尚未建立可用的 OAuth 频道接入。"
        append_skipped(checks, "channel.inventory-sync", reason)
        append_skipped(checks, "channel.inventory-status", reason)

    if options.include_analytics and channel_ready:
        analytics = run_cli(
            options.cli,
            ("ops", "channel", "analytics-sync", *channel_args, "--days", "7"),
            timeout_seconds=options.timeout_seconds,
        )
        append_check(checks, "channel.analytics-sync", analytics)
        analytics_status = run_cli(
            options.cli,
            ("ops", "channel", "analytics-status", *channel_args),
            timeout_seconds=options.timeout_seconds,
        )
        append_check(checks, "channel.analytics-status", analytics_status)
        analytics_read = run_cli(
            options.cli,
            ("ops", "channel", "analytics-read", *channel_args, "--refresh"),
            timeout_seconds=options.timeout_seconds,
        )
        append_check(checks, "channel.analytics-refresh", analytics_read)
        analytics_query = run_cli(
            options.cli,
            ("ops", "channel", "analytics-query", *channel_args),
            timeout_seconds=options.timeout_seconds,
        )
        append_check(checks, "channel.analytics-query", analytics_query)
    elif options.include_analytics:
        reason = "目标频道尚未建立可用的 OAuth 频道接入。"
        append_skipped(checks, "channel.analytics-sync", reason)
        append_skipped(checks, "channel.analytics-status", reason)
        append_skipped(checks, "channel.analytics-refresh", reason)
        append_skipped(checks, "channel.analytics-query", reason)

    if options.include_breakdown and channel_ready:
        end_date = datetime.now(timezone.utc).date()
        start_date = end_date - timedelta(days=6)
        breakdown = run_cli(
            options.cli,
            (
                "ops",
                "channel",
                "analytics-breakdown",
                *channel_args,
                "--metrics",
                "views,estimatedMinutesWatched,averageViewDuration,likes,comments,shares",
                "--dimensions",
                "day",
                "--start-date",
                start_date.isoformat(),
                "--end-date",
                end_date.isoformat(),
            ),
            timeout_seconds=options.timeout_seconds,
        )
        append_check(checks, "channel.analytics-breakdown", breakdown)
    elif options.include_breakdown:
        append_skipped(
            checks,
            "channel.analytics-breakdown",
            "目标频道尚未建立可用的 OAuth 频道接入。",
        )

    if options.include_reporting and channel_ready:
        reporting = run_cli(
            options.cli,
            (
                "ops",
                "channel",
                "reporting-sync",
                *channel_args,
                "--report-type",
                options.report_type,
            ),
            timeout_seconds=options.timeout_seconds,
        )
        append_check(checks, "channel.reporting-sync", reporting)
        reporting_status = run_cli(
            options.cli,
            ("ops", "channel", "reporting-status", *channel_args),
            timeout_seconds=options.timeout_seconds,
        )
        append_check(checks, "channel.reporting-status", reporting_status)
    elif options.include_reporting:
        reason = "目标频道尚未建立可用的 OAuth 频道接入。"
        append_skipped(checks, "channel.reporting-sync", reason)
        append_skipped(checks, "channel.reporting-status", reason)

    if options.include_comments and channel_ready:
        comments = run_cli(
            options.cli,
            ("ops", "channel", "comments-sync", *channel_args),
            timeout_seconds=options.timeout_seconds,
        )
        append_check(checks, "channel.comments-sync", comments)
        comments_status = run_cli(
            options.cli,
            ("ops", "channel", "comments-status", *channel_args),
            timeout_seconds=options.timeout_seconds,
        )
        append_check(checks, "channel.comments-status", comments_status)
    elif options.include_comments:
        reason = "目标频道尚未建立可用的 OAuth 频道接入。"
        append_skipped(checks, "channel.comments-sync", reason)
        append_skipped(checks, "channel.comments-status", reason)

    coverage = run_cli(
        options.cli,
        ("ops", "channel", "coverage", *channel_args),
        timeout_seconds=options.timeout_seconds,
    )
    append_check(checks, "channel.coverage", coverage)

    if options.include_scheduler_run:
        scheduler_run = run_cli(
            options.cli,
            (
                "ops",
                "channel",
                "scheduler",
                "run",
                "--config",
                str(options.config),
            ),
            timeout_seconds=options.timeout_seconds,
        )
        append_check(checks, "scheduler.run", scheduler_run)


def report_has_sensitive_text(report: Any) -> bool:
    serialized = json.dumps(report, ensure_ascii=False)
    return bool(SENSITIVE_VALUE_RE.search(serialized))


def print_summary(report: dict[str, Any]) -> None:
    print(f"真实测试时间：{report['startedAt']}")
    print(f"测试套件：{report['suite']}；配置：{report['configPath']}")
    print(
        f"结果：{report['passedCount']}/{report['checkCount']} 项通过；"
        f"跳过 {report['skippedCount']} 项"
    )
    for check in report["checks"]:
        mark = "跳过" if check.get("skipped") else ("通过" if check["passed"] else "失败")
        print(f"- {mark} {check['name']}（退出码 {check['exitCode']}）")
        payload = check.get("payload") or {}
        error = payload.get("error") if isinstance(payload, dict) else None
        if isinstance(error, dict) and error.get("message"):
            print(f"  {error.get('code') or 'ERROR'}：{error['message']}")
    if report.get("notes"):
        print("说明：")
        for note in report["notes"]:
            print(f"- {note}")


def main() -> int:
    options = parse_args()
    input_errors = validate_inputs(options)
    if input_errors:
        for error in input_errors:
            print(redact_text(error), file=sys.stderr)
        return 2

    options.cli = options.cli.resolve()
    options.config = options.config.resolve()
    cli_error = require_existing_path(options.cli, "CLI 入口")
    config_error = require_existing_path(options.config, "配置文件")
    if cli_error or config_error:
        for error in (cli_error, config_error):
            if error:
                print(redact_text(error), file=sys.stderr)
        return 2

    started_at = utc_now()
    checks: list[dict[str, Any]] = []
    notes: list[str] = [
        "所有命令均通过构建后的 ytops --json CLI 执行。",
        "报告只保留退出码、状态、覆盖、数据截至时间和数量摘要；OAuth code/state、令牌、客户端秘密及原始响应均不写入报告。",
    ]
    run_smoke_suite(options, checks)
    if options.suite == "full":
        run_full_suite(options, checks)
    else:
        notes.append("smoke 套件未执行频道 API；需要真实 OAuth 连接时请使用 --suite full。")

    executed_checks = [check for check in checks if not check.get("skipped")]
    passed_count = sum(1 for check in executed_checks if check["passed"])
    report: dict[str, Any] = {
        "startedAt": started_at,
        "finishedAt": utc_now(),
        "suite": options.suite,
        "configPath": "<配置路径>",
        "checkCount": len(executed_checks),
        "skippedCount": len(checks) - len(executed_checks),
        "passedCount": passed_count,
        "checks": checks,
        "notes": notes,
    }
    if report_has_sensitive_text(report):
        print("检测到报告中存在疑似敏感内容，已拒绝输出。", file=sys.stderr)
        return 1

    if options.json:
        print(json.dumps(redact_value(report), ensure_ascii=False, indent=2))
    else:
        print_summary(report)
    return 0 if passed_count == len(executed_checks) else 1


if __name__ == "__main__":
    raise SystemExit(main())
