#!/usr/bin/env python3
"""Resolve (and on first run, persist) the work-status brief's ADO context.

The skill needs three things before it can query Azure DevOps: the project, the
team, and which repos to sweep. Two of them are derivable from a git remote, so
nobody should have to hand-write a config file to use the skill.

    resolve-context.py                      # status as JSON on stdout
    resolve-context.py --write '<json>'     # persist a resolved context

Status output:

    {"configPath": "...", "exists": false, "source": "discovered",
     "config": null, "error": null,
     "discovered": {"org": "...", "project": "...", "repos": [...],
                    "team": null, "ambiguous": []}}

An existing config short-circuits discovery — it is the user's stated intent and
outranks anything inferred. `team` is never guessed here: it needs an API call,
so the caller resolves it and passes it to --write.

Read-only apart from --write. Stdlib only.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import unquote

DEFAULT_CONFIG = "~/.claude/work-status.json"
ALLOWED_KEYS = {"project", "team", "repos", "boardConvention"}

# https://[org@]dev.azure.com/<org>/<project>/_git/<repo>
_HTTPS = re.compile(
    r"^https?://(?:[^@/]+@)?dev\.azure\.com/([^/]+)/([^/]+)/_git/([^/]+?)(?:\.git)?/?$", re.I
)
# git@ssh.dev.azure.com:v3/<org>/<project>/<repo>   (and the ssh:// spelling)
_SSH = re.compile(
    r"^(?:ssh://)?[^@]*@?ssh\.dev\.azure\.com[:/]v3/([^/]+)/([^/]+)/([^/]+?)(?:\.git)?/?$", re.I
)
# https://<org>.visualstudio.com/<project>/_git/<repo>   (legacy host)
_LEGACY = re.compile(
    r"^https?://([^./]+)\.visualstudio\.com/(?:DefaultCollection/)?([^/]+)/_git/([^/]+?)(?:\.git)?/?$",
    re.I,
)


def parse_ado_remote(url):
    """Pull org/project/repo out of an ADO remote, or None if it is not one.

    Never raises — a non-ADO or malformed remote is an expected input, not an
    error, because the caller sweeps every remote it can find.
    """
    if not isinstance(url, str):
        return None
    url = url.strip()
    if not url:
        return None
    for pattern in (_HTTPS, _SSH, _LEGACY):
        m = pattern.match(url)
        if m:
            org, project, repo = (unquote(g) for g in m.groups())
            if org and project and repo:
                return {"org": org, "project": project, "repo": repo}
    return None


def validate(cfg):
    """Return a list of human-readable problems; empty means valid."""
    if not isinstance(cfg, dict):
        return ["config must be a JSON object"]

    problems = []
    unknown = sorted(set(cfg) - ALLOWED_KEYS)
    if unknown:
        problems.append(f"unknown key(s): {', '.join(unknown)}")

    project = cfg.get("project")
    if not isinstance(project, str) or not project.strip():
        problems.append("project must be a non-empty string")

    repos = cfg.get("repos")
    if not isinstance(repos, list) or not repos:
        problems.append("repos must be a non-empty list")
    elif not all(isinstance(r, str) and r.strip() for r in repos):
        problems.append("repos must contain only non-empty strings")

    if "team" in cfg:
        team = cfg["team"]
        if team is not None and (not isinstance(team, str) or not team.strip()):
            problems.append("team must be a non-empty string when present")

    if "boardConvention" in cfg:
        bc = cfg["boardConvention"]
        if not isinstance(bc, dict):
            problems.append("boardConvention must be an object")
        elif not all(isinstance(v, bool) for v in bc.values()):
            problems.append("boardConvention values must be true or false")

    return problems


def discover(remotes):
    """Derive what a set of git remotes can prove about the ADO context.

    Anything it cannot prove is named in `ambiguous` rather than guessed, so the
    caller knows exactly what is left to ask about.
    """
    parsed = [p for p in (parse_ado_remote(u) for u in remotes or []) if p]
    seen, unique = set(), []
    for p in parsed:
        key = (p["org"], p["project"], p["repo"])
        if key not in seen:
            seen.add(key)
            unique.append(p)

    out = {"org": None, "project": None, "repos": [], "team": None, "ambiguous": []}
    if not unique:
        out["ambiguous"].append("no Azure DevOps remote found, so project and repos need input")
        return out

    projects = sorted({p["project"] for p in unique})
    if len(projects) > 1:
        out["ambiguous"].append(
            "remotes span more than one project ("
            + ", ".join(projects)
            + "), so project needs input"
        )
        return out

    orgs = sorted({p["org"] for p in unique})
    out["org"] = orgs[0] if len(orgs) == 1 else None
    out["project"] = projects[0]
    out["repos"] = sorted({p["repo"] for p in unique})
    return out


def config_path(p=DEFAULT_CONFIG):
    return Path(p).expanduser()


def read_config(path):
    """{exists, config, error} — a broken file reports, it does not raise."""
    path = Path(path)
    if not path.is_file():
        return {"exists": False, "config": None, "error": None}
    try:
        return {"exists": True, "config": json.loads(path.read_text()), "error": None}
    except json.JSONDecodeError as exc:
        return {"exists": True, "config": None, "error": f"invalid JSON: {exc}"}
    except OSError as exc:
        return {"exists": True, "config": None, "error": str(exc)}


def write_config(path, cfg):
    """Validate, then replace atomically so a crash cannot leave a partial file.

    Validation runs before the temp file exists, so an invalid config leaves the
    directory exactly as it was — including any previously good config.
    """
    problems = validate(cfg)
    if problems:
        raise ValueError("; ".join(problems))

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".work-status-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(cfg, fh, indent=2)
            fh.write("\n")
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def git_remotes(cwd=None):
    """Every remote URL configured here. Read-only; empty list on any failure."""
    try:
        out = subprocess.run(
            ["git", "remote", "-v"], cwd=cwd, capture_output=True, text=True, timeout=10
        )
    except Exception:
        return []
    if out.returncode != 0:
        return []
    urls = []
    for line in out.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[1] not in urls:
            urls.append(parts[1])
    return urls


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=DEFAULT_CONFIG)
    ap.add_argument(
        "--remote",
        action="append",
        default=None,
        help="remote URL to consider (repeatable); defaults to this repo's remotes",
    )
    ap.add_argument("--write", metavar="JSON", help="validate and persist this config")
    args = ap.parse_args()

    path = config_path(args.config)

    if args.write is not None:
        try:
            cfg = json.loads(args.write)
        except json.JSONDecodeError as exc:
            sys.exit(f"--write needs valid JSON: {exc}")
        try:
            write_config(path, cfg)
        except (ValueError, OSError) as exc:
            sys.exit(f"refusing to write {path}: {exc}")
        print(json.dumps({"written": str(path), "config": cfg}, indent=2))
        return

    existing = read_config(path)
    result = {
        "configPath": str(path),
        "exists": existing["exists"],
        "source": "config" if existing["config"] else "discovered",
        "config": existing["config"],
        "error": existing["error"],
        "discovered": None,
    }
    # An existing config is the user's stated intent; do not second-guess it.
    if not existing["config"]:
        remotes = args.remote if args.remote is not None else git_remotes()
        result["discovered"] = discover(remotes)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
