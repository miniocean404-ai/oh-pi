"""`python -m robomp.proxy serve` — run the gh-proxy FastAPI app."""

from __future__ import annotations

import sys

import click
import uvicorn

from robomp.config import Settings, get_settings
from robomp.logging_config import configure_logging
from robomp.proxy.server import create_proxy_app


def _settings_or_die() -> Settings:
    try:
        return get_settings()
    except Exception as exc:
        click.echo(f"gh-proxy configuration error: {exc}", err=True)
        sys.exit(2)


@click.group()
def main() -> None:
    """gh-proxy control surface."""


@main.command()
def serve() -> None:
    """Run the HMAC-authenticated GitHub proxy."""
    cfg = _settings_or_die()
    configure_logging(cfg.log_dir)
    cfg.ensure_paths()
    if cfg.github_token is None:
        click.echo("gh-proxy: GITHUB_TOKEN is required in proxy mode", err=True)
        sys.exit(2)
    if cfg.gh_proxy_hmac_key is None:
        click.echo("gh-proxy: ROBOMP_GH_PROXY_HMAC_KEY is required in proxy mode", err=True)
        sys.exit(2)
    app = create_proxy_app(cfg)
    uvicorn.run(
        app,
        host=cfg.gh_proxy_bind_host,
        port=cfg.gh_proxy_bind_port,
        log_config=None,
    )


if __name__ == "__main__":
    main()
