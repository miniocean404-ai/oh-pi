"""Low-level git primitives with ephemeral PAT injection.

The PAT is supplied through `git --config-env=http.extraHeader=ENVVAR`. Git
expands the env var inside the spawned process; the secret only appears in
the spawned process's environment, never in argv visible to other UIDs via
`/proc/<pid>/cmdline`. The env var is wiped from the parent after each call.

Used by:
- `robomp.sandbox.LocalGitTransport` for in-process git operations when no
  proxy is configured.
- `robomp.proxy.server` for proxied operations on the gh-proxy side.
"""

from __future__ import annotations

import base64
import logging
import os
import re
import subprocess
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

# Per-call env var name. `git --config-env` reads the header value from this
# env entry inside the spawned process — never persisted into `.git/config`.
AUTH_ENV_VAR = "ROBOMP_GIT_HTTP_AUTH"

_CRED_URL = re.compile(r"(https?://)([^:/@\s]+):([^@/\s]+)@")


def redact_credentials(text: str | None) -> str:
    """Strip `user:password@` from any embedded URL in `text`."""
    if not text:
        return text or ""
    return _CRED_URL.sub(r"\1***@", text)


def _redacted_cmd(cmd: list[str]) -> list[str]:
    return [redact_credentials(part) for part in cmd]


class GitCommandError(RuntimeError):
    """Wraps a failed git subprocess with credentials redacted from argv and stderr."""

    def __init__(self, cmd: list[str], returncode: int, stdout: str, stderr: str) -> None:
        self.returncode = returncode
        self.stdout = redact_credentials(stdout)
        self.stderr = redact_credentials(stderr)
        self.cmd = _redacted_cmd(cmd)
        msg = self.stderr.strip() or self.stdout.strip() or f"exit {returncode}"
        super().__init__(f"git {' '.join(self.cmd[1:])} failed: {msg}")


def _basic_auth_header(token: str) -> str:
    """Build the `Authorization: Basic …` header value for a PAT.

    GitHub accepts `x-access-token:<PAT>` over HTTPS Basic auth; that form
    works for fine-grained tokens, classic PATs, and GitHub App installation
    tokens alike.
    """
    raw = f"x-access-token:{token}".encode()
    return f"Authorization: Basic {base64.b64encode(raw).decode('ascii')}"


def _run_git(
    args: list[str],
    *,
    cwd: Path | None,
    token: str | None,
    extra_env: Mapping[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run `git <args>` with optional PAT injection via `--config-env`.

    A returncode of 0 returns the populated `CompletedProcess`. Non-zero exit
    returns the same shape; callers either `_check` it or inspect manually
    (e.g. when probing for ref existence). Stdout/stderr are always
    credential-redacted before being returned.
    """
    env: dict[str, str] = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    if extra_env:
        env.update(extra_env)
    cmd: list[str] = ["git"]
    if token:
        env[AUTH_ENV_VAR] = _basic_auth_header(token)
        cmd.extend(["--config-env", f"http.extraHeader={AUTH_ENV_VAR}"])
    cmd.extend(args)
    log.debug("git", extra={"cmd": _redacted_cmd(cmd), "cwd": str(cwd) if cwd else None})
    proc = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    if proc.stdout:
        proc.stdout = redact_credentials(proc.stdout)
    if proc.stderr:
        proc.stderr = redact_credentials(proc.stderr)
    return proc


def _check(proc: subprocess.CompletedProcess[str], cmd: list[str]) -> subprocess.CompletedProcess[str]:
    if proc.returncode != 0:
        raise GitCommandError(cmd, proc.returncode, proc.stdout, proc.stderr)
    return proc


# ---------- Public primitives ----------


def clone(
    target: Path,
    *,
    clone_url: str,
    default_branch: str,
    token: str | None,
) -> None:
    """Fresh `git clone --filter=blob:none` into `target`."""
    target.parent.mkdir(parents=True, exist_ok=True)
    args = [
        "clone",
        "--filter=blob:none",
        "--no-tags",
        "--branch",
        default_branch,
        clone_url,
        str(target),
    ]
    _check(_run_git(args, cwd=None, token=token), ["git", *args])


def fetch_prune(repo_dir: Path, *, token: str | None) -> None:
    """`git fetch --prune origin` on the shared pool clone."""
    args = ["fetch", "--prune", "origin"]
    _check(_run_git(args, cwd=repo_dir, token=token), ["git", *args])


def fetch_ref(repo_dir: Path, ref: str, *, token: str | None) -> None:
    """`git fetch origin <ref>` (best-effort: caller decides to swallow)."""
    args = ["fetch", "origin", ref]
    proc = _run_git(args, cwd=repo_dir, token=token)
    if proc.returncode != 0:
        log.debug(
            "fetch_ref non-fatal failure",
            extra={"ref": ref, "stderr": proc.stderr},
        )


@dataclass(slots=True, frozen=True)
class PushResult:
    head: str
    branch: str


class HeadDriftError(GitCommandError):
    """Raised when `expected_head` no longer matches the current HEAD.

    Defends against an attacker landing a commit between the orchestrator's
    preflight gates and the actual push.
    """


def rev_parse_head(repo_dir: Path) -> str:
    """Return the SHA of HEAD or raise GitCommandError."""
    proc = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=str(repo_dir),
        check=False,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise GitCommandError(
            ["git", "rev-parse", "HEAD"],
            proc.returncode,
            proc.stdout,
            proc.stderr,
        )
    return proc.stdout.strip()


def push(
    repo_dir: Path,
    *,
    branch: str,
    expected_head: str | None,
    token: str | None,
) -> PushResult:
    """`git push --force-with-lease --set-upstream origin <branch>` from `repo_dir`.

    `--force-with-lease` lets us recover from local history rewrites (e.g. the
    agent doing `git commit --amend --reset-author --no-edit` to fix author
    identity) while still refusing the push if origin has moved since our last
    fetch — i.e. it never clobbers work the bot didn't see.

    When `expected_head` is supplied, this verifies the *local* HEAD matches
    before pushing — anything else means an unexpected commit raced in inside
    our own worktree between the orchestrator's preflight and this call, and
    the push is aborted with `HeadDriftError`. This is a separate concern from
    `--force-with-lease`, which compares against the remote ref.
    """
    head = rev_parse_head(repo_dir)
    if expected_head and head != expected_head:
        raise HeadDriftError(
            ["git", "push"],
            128,
            "",
            f"HEAD changed since preflight ({expected_head[:12]} → {head[:12]}); aborting push.",
        )
    args = ["push", "--force-with-lease", "--set-upstream", "origin", branch]
    _check(_run_git(args, cwd=repo_dir, token=token), ["git", *args])
    return PushResult(head=head, branch=branch)


__all__ = [
    "AUTH_ENV_VAR",
    "GitCommandError",
    "HeadDriftError",
    "PushResult",
    "clone",
    "fetch_prune",
    "fetch_ref",
    "push",
    "redact_credentials",
    "rev_parse_head",
]
