"""gh-proxy FastAPI app: HMAC-gated GitHub REST + git proxy.

Robomp calls every endpoint with HMAC headers (see `robomp.proxy_hmac`).
Authenticated requests dispatch to a single `GitHubClient` instance holding
the PAT, or to `robomp.git_ops` for git transport. The PAT never leaves
this process.

Endpoint payloads are deliberately typed (no generic GitHub passthrough):
each one names exactly one operation robomp performs.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.responses import JSONResponse

from robomp.config import Settings
from robomp.git_ops import (
    GitCommandError,
    HeadDriftError,
)
from robomp.git_ops import (
    clone as git_clone,
)
from robomp.git_ops import (
    fetch_prune as git_fetch_prune,
)
from robomp.git_ops import (
    fetch_ref as git_fetch_ref,
)
from robomp.git_ops import (
    push as git_push,
)
from robomp.github_client import GitHubClient, GitHubError
from robomp.proxy_hmac import HEADER_SIGNATURE, HEADER_TIMESTAMP, verify
from robomp.sandbox import workspace_key as compute_workspace_key

log = logging.getLogger(__name__)


def _serialize(obj: Any) -> Any:
    """Best-effort serializer for dataclasses + tuples → JSON-safe payload."""
    if hasattr(obj, "__dataclass_fields__"):
        data = asdict(obj)
        return {k: _serialize(v) for k, v in data.items()}
    if isinstance(obj, tuple):
        return [_serialize(v) for v in obj]
    if isinstance(obj, list):
        return [_serialize(v) for v in obj]
    if isinstance(obj, dict):
        return {k: _serialize(v) for k, v in obj.items()}
    return obj


def _gh_error_response(exc: GitHubError) -> JSONResponse:
    return JSONResponse(
        {
            "error": {
                "kind": "github",
                "status": exc.status,
                "message": exc.message,
                "retry_after": exc.retry_after,
            }
        },
        status_code=exc.status,
    )


def _git_error_response(exc: GitCommandError, *, head_drift: bool = False) -> JSONResponse:
    payload: dict[str, Any] = {
        "error": {
            "kind": "head_drift" if head_drift else "git",
            "returncode": exc.returncode,
            "cmd": exc.cmd,
            "stdout": exc.stdout,
            "stderr": exc.stderr,
        }
    }
    # 409 for head drift (concurrent commit detected); 502 for everything else.
    return JSONResponse(payload, status_code=409 if head_drift else 502)


def _require_str(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise HTTPException(400, f"missing/invalid '{field}'")
    return value


def _require_int(value: Any, field: str) -> int:
    if not isinstance(value, int):
        raise HTTPException(400, f"missing/invalid '{field}'")
    return value


def _optional_str_list(value: Any, field: str) -> list[str] | None:
    if value is None:
        return None
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise HTTPException(400, f"invalid '{field}': must be array of strings")
    return list(value)


def _pool_dir(cfg: Settings, repo: str) -> Path:
    if "/" not in repo or repo.startswith("/") or ".." in repo.split("/"):
        raise HTTPException(400, f"invalid repo {repo!r}")
    return Path(cfg.workspace_root) / "_pool" / repo.replace("/", "__")


def _workspace_repo_dir(cfg: Settings, workspace_key: str) -> Path:
    # Defense-in-depth: workspace_key is constructed by `sandbox.workspace_key`
    # as `<repo_with_underscores>__<number>`. Reject anything outside that shape.
    if "/" in workspace_key or workspace_key.startswith(".") or ".." in workspace_key:
        raise HTTPException(400, f"invalid workspace_key {workspace_key!r}")
    return Path(cfg.workspace_root) / workspace_key / "repo"


def _resolve_token(cfg: Settings) -> str:
    if cfg.github_token is None:
        # Will already have been caught at startup, but stay defensive.
        raise HTTPException(500, "gh-proxy: GITHUB_TOKEN not configured")
    return cfg.github_token.get_secret_value()


def _resolve_hmac_key(cfg: Settings) -> bytes:
    if cfg.gh_proxy_hmac_key is None:
        raise HTTPException(500, "gh-proxy: ROBOMP_GH_PROXY_HMAC_KEY not configured")
    return cfg.gh_proxy_hmac_key.get_secret_value().encode("utf-8")


def create_proxy_app(settings: Settings) -> FastAPI:
    """Build the gh-proxy FastAPI app bound to `settings`."""

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.github = GitHubClient(_resolve_token(settings))
        app.state.settings = settings
        yield

    app = FastAPI(title="robomp-gh-proxy", version="0.1.0", lifespan=lifespan)

    async def _authenticate(request: Request) -> bytes:
        body = await request.body()
        ts = request.headers.get(HEADER_TIMESTAMP)
        sig = request.headers.get(HEADER_SIGNATURE)
        result = verify(
            method=request.method,
            path=request.url.path,
            body=body,
            timestamp=ts,
            signature=sig,
            key=_resolve_hmac_key(settings),
        )
        if not result.ok:
            log.warning(
                "gh-proxy auth rejected",
                extra={"reason": result.reason, "path": request.url.path},
            )
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "unauthenticated")
        return body

    # ---- meta ----
    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    # ---- reads ----
    @app.get("/gh/v1/authenticated_login")
    async def authenticated_login(request: Request) -> dict[str, str]:
        await _authenticate(request)
        github: GitHubClient = request.app.state.github
        try:
            login = await github.get_authenticated_login()
        except GitHubError as exc:
            raise HTTPException(exc.status, exc.message) from exc
        return {"login": login}

    @app.get("/gh/v1/repo")
    async def get_repo(request: Request, repo: str) -> JSONResponse:
        await _authenticate(request)
        github: GitHubClient = request.app.state.github
        try:
            info = await github.get_repo(repo)
        except GitHubError as exc:
            return _gh_error_response(exc)
        return JSONResponse(_serialize(info))

    @app.get("/gh/v1/issue")
    async def get_issue(request: Request, repo: str, number: int) -> JSONResponse:
        await _authenticate(request)
        github: GitHubClient = request.app.state.github
        try:
            info = await github.get_issue(repo, number)
        except GitHubError as exc:
            return _gh_error_response(exc)
        return JSONResponse(_serialize(info))

    @app.get("/gh/v1/issues")
    async def list_issues(request: Request, repo: str, state: str = "open", limit: int = 30) -> JSONResponse:
        await _authenticate(request)
        github: GitHubClient = request.app.state.github
        try:
            items = await github.list_issues(repo, state=state, limit=limit)
        except GitHubError as exc:
            return _gh_error_response(exc)
        return JSONResponse({"items": [_serialize(s) for s in items]})

    @app.get("/gh/v1/comments")
    async def list_comments(request: Request, repo: str, number: int) -> JSONResponse:
        await _authenticate(request)
        github: GitHubClient = request.app.state.github
        try:
            items = await github.list_comments(repo, number)
        except GitHubError as exc:
            return _gh_error_response(exc)
        return JSONResponse({"items": [_serialize(c) for c in items]})

    @app.get("/gh/v1/review_comments")
    async def list_review_comments(request: Request, repo: str, pr_number: int) -> JSONResponse:
        await _authenticate(request)
        github: GitHubClient = request.app.state.github
        try:
            items = await github.list_review_comments(repo, pr_number)
        except GitHubError as exc:
            return _gh_error_response(exc)
        return JSONResponse({"items": [_serialize(c) for c in items]})

    @app.get("/gh/v1/pr_reviews")
    async def list_pr_reviews(request: Request, repo: str, pr_number: int) -> JSONResponse:
        await _authenticate(request)
        github: GitHubClient = request.app.state.github
        try:
            items = await github.list_pr_reviews(repo, pr_number)
        except GitHubError as exc:
            return _gh_error_response(exc)
        return JSONResponse({"items": [_serialize(r) for r in items]})

    # ---- writes ----
    async def _json_body(request: Request) -> dict[str, Any]:
        await _authenticate(request)
        try:
            data = await request.json()
        except Exception as exc:
            raise HTTPException(400, f"invalid json: {exc}") from exc
        if not isinstance(data, dict):
            raise HTTPException(400, "json body must be an object")
        return data

    @app.post("/gh/v1/post_comment")
    async def post_comment(request: Request) -> JSONResponse:
        data = await _json_body(request)
        repo = _require_str(data.get("repo"), "repo")
        number = _require_int(data.get("number"), "number")
        body = _require_str(data.get("body"), "body")
        github: GitHubClient = request.app.state.github
        try:
            info = await github.post_comment(repo, number, body)
        except GitHubError as exc:
            return _gh_error_response(exc)
        return JSONResponse(_serialize(info))

    @app.post("/gh/v1/open_pull_request")
    async def open_pull_request(request: Request) -> JSONResponse:
        data = await _json_body(request)
        repo = _require_str(data.get("repo"), "repo")
        head = _require_str(data.get("head"), "head")
        base = _require_str(data.get("base"), "base")
        title = _require_str(data.get("title"), "title")
        body = _require_str(data.get("body"), "body")
        draft = bool(data.get("draft", False))
        mcm = bool(data.get("maintainer_can_modify", True))
        github: GitHubClient = request.app.state.github
        try:
            pr = await github.open_pull_request(
                repo=repo,
                head=head,
                base=base,
                title=title,
                body=body,
                draft=draft,
                maintainer_can_modify=mcm,
            )
        except GitHubError as exc:
            return _gh_error_response(exc)
        return JSONResponse(_serialize(pr))

    @app.post("/gh/v1/request_reviewers")
    async def request_reviewers(request: Request) -> JSONResponse:
        data = await _json_body(request)
        repo = _require_str(data.get("repo"), "repo")
        pr_number = _require_int(data.get("pr_number"), "pr_number")
        reviewers = _optional_str_list(data.get("reviewers"), "reviewers")
        team_reviewers = _optional_str_list(data.get("team_reviewers"), "team_reviewers")
        github: GitHubClient = request.app.state.github
        try:
            await github.request_reviewers(
                repo=repo,
                pr_number=pr_number,
                reviewers=reviewers,
                team_reviewers=team_reviewers,
            )
        except GitHubError as exc:
            return _gh_error_response(exc)
        return JSONResponse({"ok": True})

    @app.post("/gh/v1/add_issue_labels")
    async def add_issue_labels(request: Request) -> JSONResponse:
        data = await _json_body(request)
        repo = _require_str(data.get("repo"), "repo")
        number = _require_int(data.get("number"), "number")
        labels = _optional_str_list(data.get("labels"), "labels") or []
        github: GitHubClient = request.app.state.github
        try:
            applied = await github.add_issue_labels(repo, number, labels)
        except GitHubError as exc:
            return _gh_error_response(exc)
        return JSONResponse({"labels": list(applied)})

    @app.post("/gh/v1/add_assignees")
    async def add_assignees(request: Request) -> JSONResponse:
        data = await _json_body(request)
        repo = _require_str(data.get("repo"), "repo")
        number = _require_int(data.get("number"), "number")
        assignees = _optional_str_list(data.get("assignees"), "assignees") or []
        github: GitHubClient = request.app.state.github
        try:
            await github.add_assignees(repo, number, assignees)
        except GitHubError as exc:
            return _gh_error_response(exc)
        return JSONResponse({"ok": True})

    # ---- git transport ----
    @app.post("/gh/v1/git/clone")
    async def git_clone_endpoint(request: Request) -> JSONResponse:
        data = await _json_body(request)
        repo = _require_str(data.get("repo"), "repo")
        clone_url = _require_str(data.get("clone_url"), "clone_url")
        default_branch = _require_str(data.get("default_branch"), "default_branch")
        target = _pool_dir(settings, repo)
        try:
            git_clone(
                target,
                clone_url=clone_url,
                default_branch=default_branch,
                token=_resolve_token(settings),
            )
        except GitCommandError as exc:
            return _git_error_response(exc)
        return JSONResponse({"pool_dir": str(target)})

    @app.post("/gh/v1/git/fetch")
    async def git_fetch_endpoint(request: Request) -> JSONResponse:
        data = await _json_body(request)
        repo = _require_str(data.get("repo"), "repo")
        target = _pool_dir(settings, repo)
        try:
            git_fetch_prune(target, token=_resolve_token(settings))
        except GitCommandError as exc:
            return _git_error_response(exc)
        return JSONResponse({"pool_dir": str(target)})

    @app.post("/gh/v1/git/fetch_ref")
    async def git_fetch_ref_endpoint(request: Request) -> JSONResponse:
        data = await _json_body(request)
        repo = _require_str(data.get("repo"), "repo")
        ref = _require_str(data.get("ref"), "ref")
        target = _pool_dir(settings, repo)
        # fetch_ref is intentionally best-effort; never surfaces a 5xx.
        git_fetch_ref(target, ref, token=_resolve_token(settings))
        return JSONResponse({"pool_dir": str(target)})

    @app.post("/gh/v1/git/push")
    async def git_push_endpoint(request: Request) -> JSONResponse:
        data = await _json_body(request)
        repo = _require_str(data.get("repo"), "repo")
        workspace_key = _require_str(data.get("workspace_key"), "workspace_key")
        branch = _require_str(data.get("branch"), "branch")
        expected_head = _require_str(data.get("expected_head"), "expected_head")
        # Sanity-check workspace_key matches the repo claim.
        expected_prefix = repo.replace("/", "__") + "__"
        if not workspace_key.startswith(expected_prefix):
            raise HTTPException(400, "workspace_key does not match repo")
        repo_dir = _workspace_repo_dir(settings, workspace_key)
        if not repo_dir.is_dir():
            raise HTTPException(404, f"workspace not found: {workspace_key}")
        try:
            result = git_push(
                repo_dir,
                branch=branch,
                expected_head=expected_head,
                token=_resolve_token(settings),
            )
        except HeadDriftError as exc:
            return _git_error_response(exc, head_drift=True)
        except GitCommandError as exc:
            return _git_error_response(exc)
        return JSONResponse({"head": result.head, "branch": result.branch})

    # Expose for tests
    app.state.workspace_key_fn = compute_workspace_key  # type: ignore[attr-defined]
    return app


__all__ = ["create_proxy_app"]
