#!/usr/bin/env python3
"""Collect local Claude Code + git state for the /work-status brief.

Emits a single JSON object on stdout. Read-only: never writes to any repo,
never fetches, never mutates git state. Safe to run at any time.

Usage:
    collect-local.py [--since ISO8601] [--sessions-days N]

--since defaults to the previous work day at 00:00 local time (Monday
reaches back to Friday), which is the window for "what landed since I
last looked".
"""

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

PROJECTS_DIR = Path.home() / ".claude" / "projects"
SESSION_TAIL_BYTES = 400_000  # enough to reach the last real exchange
MAX_SESSIONS = 40


def run(args, cwd=None, timeout=20):
    """Run a command, returning stripped stdout or '' on any failure."""
    try:
        out = subprocess.run(
            args, cwd=cwd, capture_output=True, text=True, timeout=timeout
        )
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        return ""


def previous_work_day(now):
    """Monday reaches back to Friday; otherwise yesterday."""
    delta = 3 if now.weekday() == 0 else (2 if now.weekday() == 6 else 1)
    d = now - timedelta(days=delta)
    return d.replace(hour=0, minute=0, second=0, microsecond=0)


# --------------------------------------------------------------------------
# Sessions
# --------------------------------------------------------------------------


def text_of(message):
    """Flatten a message's content to plain text, skipping tool plumbing."""
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""
    parts = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text", ""))
    return "\n".join(parts).strip()


def tail_lines(path, nbytes):
    """Read the last nbytes of a file and return whole lines."""
    size = path.stat().st_size
    with path.open("rb") as fh:
        if size > nbytes:
            fh.seek(size - nbytes)
            fh.readline()  # discard the partial first line
        data = fh.read()
    return data.decode("utf-8", errors="replace").splitlines()


def is_noise(text):
    """Local-command echoes and hook injections aren't real user turns."""
    if not text:
        return True
    markers = (
        "<local-command-stdout>",
        "<command-name>",
        "<system-reminder>",
        "[SYSTEM NOTIFICATION",
        "Caveat: The messages below were generated",
    )
    return any(m in text[:400] for m in markers)


# A session rename is appended to the transcript when it happens, so the title
# is not necessarily on line 1 — take the last one written.
TITLE_RE = re.compile(rb'"customTitle"\s*:\s*"((?:[^"\\]|\\.)*)"')


def title_of(path, head):
    try:
        found = TITLE_RE.findall(path.read_bytes())
    except Exception:
        found = []
    if found:
        try:
            return json.loads(b'"' + found[-1] + b'"')
        except Exception:
            pass
    if isinstance(head, dict):
        return head.get("customTitle") or head.get("summary")
    return None


def read_session(path):
    """Extract a compact status record from one session transcript."""
    rec = {
        "sessionId": path.stem,
        "file": str(path),
        "mtime": datetime.fromtimestamp(
            path.stat().st_mtime, tz=timezone.utc
        ).isoformat(),
        "sizeBytes": path.stat().st_size,
        "title": None,
        "cwd": None,
        "gitBranch": None,
        "lastUser": None,
        "lastAssistant": None,
        "lastTimestamp": None,
        "turns": None,
    }

    try:
        with path.open("r", errors="replace") as fh:
            head = json.loads(fh.readline() or "{}")
    except Exception:
        head = {}
    rec["title"] = title_of(path, head)

    try:
        lines = tail_lines(path, SESSION_TAIL_BYTES)
    except Exception:
        return rec

    for line in lines:
        try:
            d = json.loads(line)
        except Exception:
            continue
        if not isinstance(d, dict):
            continue
        if d.get("isSidechain"):
            continue  # subagent traffic, not the main thread

        rec["cwd"] = d.get("cwd") or rec["cwd"]
        rec["gitBranch"] = d.get("gitBranch") or rec["gitBranch"]
        rec["lastTimestamp"] = d.get("timestamp") or rec["lastTimestamp"]
        if d.get("messageCount"):
            rec["turns"] = d["messageCount"]

        if d.get("isMeta"):
            continue
        msg = d.get("message")
        role = msg.get("role") if isinstance(msg, dict) else None
        body = text_of(msg)
        if role == "user" and not is_noise(body):
            rec["lastUser"] = body[:600]
        elif role == "assistant" and body:
            rec["lastAssistant"] = body[:600]

    return rec


def collect_sessions(cutoff_days):
    """Every session transcript touched inside the window, newest first."""
    if not PROJECTS_DIR.is_dir():
        return []
    cutoff = datetime.now().timestamp() - cutoff_days * 86400
    files = [
        p
        for p in PROJECTS_DIR.glob("*/*.jsonl")
        if p.stat().st_size > 0 and p.stat().st_mtime >= cutoff
    ]
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return [read_session(p) for p in files[:MAX_SESSIONS]]


# --------------------------------------------------------------------------
# Git
# --------------------------------------------------------------------------


def repo_root(path):
    return run(["git", "rev-parse", "--show-toplevel"], cwd=path) or None


def discover_repos(sessions):
    """Git roots implied by recent session activity, deduped."""
    roots = set()
    for s in sessions:
        cwd = s.get("cwd")
        if cwd and os.path.isdir(cwd):
            root = repo_root(cwd)
            if root:
                roots.add(root)
    # A worktree's root is its own path; fold each back to its main checkout.
    mains = set()
    for r in roots:
        common = run(["git", "rev-parse", "--path-format=absolute",
                      "--git-common-dir"], cwd=r)
        if common.endswith("/.git"):
            mains.add(common[: -len("/.git")])
        else:
            mains.add(r)
    return sorted(mains)


def worktree_state(path, default_branch):
    """Branch health for one worktree. No network, no mutation."""
    branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=path)
    upstream = run(
        ["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        cwd=path,
    )
    dirty = run(["git", "status", "--porcelain"], cwd=path)
    ahead = behind = None
    if upstream:
        counts = run(
            ["git", "rev-list", "--left-right", "--count", f"{upstream}...HEAD"],
            cwd=path,
        )
        if counts and "\t" in counts:
            behind, ahead = (int(x) for x in counts.split("\t"))

    # Upstream configured but absent on the remote => merged or deleted.
    configured = run(["git", "config", f"branch.{branch}.merge"], cwd=path)
    upstream_gone = bool(configured) and not upstream

    behind_default = None
    if default_branch:
        c = run(
            ["git", "rev-list", "--count", f"HEAD..{default_branch}"], cwd=path
        )
        behind_default = int(c) if c.isdigit() else None

    last = run(["git", "log", "-1", "--format=%h|%ad|%s", "--date=short"], cwd=path)
    h, d, subject = (last.split("|", 2) + ["", "", ""])[:3]

    return {
        "path": path,
        "name": os.path.basename(path),
        # Agent scratchpad worktrees are disposable plumbing, not your work.
        "transient": path.startswith(("/private/tmp/", "/tmp/", "/var/folders/")),
        "detached": branch == "HEAD",
        "branch": branch or None,
        "upstream": upstream or None,
        "upstreamGone": upstream_gone,
        "dirtyFiles": len(dirty.splitlines()) if dirty else 0,
        "ahead": ahead,
        "behind": behind,
        "behindDefault": behind_default,
        "lastCommit": {"sha": h, "date": d, "subject": subject} if h else None,
    }


def collect_repo(root, since_iso):
    default = ""
    for cand in ("origin/main", "origin/master"):
        if run(["git", "rev-parse", "--verify", "--quiet", cand], cwd=root):
            default = cand
            break

    worktrees = []
    porcelain = run(["git", "worktree", "list", "--porcelain"], cwd=root)
    for line in porcelain.splitlines():
        if line.startswith("worktree "):
            wt = line.split(" ", 1)[1]
            if os.path.isdir(wt):
                worktrees.append(worktree_state(wt, default))

    merges = []
    if default:
        # --first-parent without --merges: ADO squash-merges land as ordinary
        # commits ("Merged PR <id>: ..."), so --merges would miss all of them.
        log = run(
            [
                "git", "log", default, "--first-parent",
                f"--since={since_iso}", "--pretty=%h|%ad|%an|%s", "--date=short",
            ],
            cwd=root,
        )
        seen = set()
        for line in log.splitlines():
            parts = line.split("|", 3)
            if len(parts) == 4 and parts[0] not in seen:
                seen.add(parts[0])
                merges.append(
                    {
                        "sha": parts[0],
                        "date": parts[1],
                        "author": parts[2],
                        "subject": parts[3],
                        "prId": (
                            m.group(1)
                            if (m := re.match(r"Merged PR (\d+):", parts[3]))
                            else None
                        ),
                    }
                )

    return {
        "root": root,
        "name": os.path.basename(root),
        "defaultBranch": default or None,
        "worktrees": worktrees,
        "landed": merges,
    }


# --------------------------------------------------------------------------


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", help="ISO8601 window start")
    ap.add_argument("--sessions-days", type=int, default=7)
    ap.add_argument(
        "--fetch",
        action="store_true",
        help="git fetch each repo first so 'what landed' is current",
    )
    args = ap.parse_args()

    now = datetime.now()
    since = args.since or previous_work_day(now).isoformat()

    sessions = collect_sessions(args.sessions_days)
    roots = discover_repos(sessions)
    if args.fetch:
        for r in roots:
            # Updates remote-tracking refs only; never touches local branches.
            run(["git", "fetch", "--all", "--quiet", "--prune"], cwd=r, timeout=90)
    repos = [collect_repo(r, since) for r in roots]

    # Two checkouts of the same project (e.g. a bare review clone) collide on
    # basename; disambiguate with the parent directory so the brief can tell
    # them apart.
    counts = {}
    for r in repos:
        counts[r["name"]] = counts.get(r["name"], 0) + 1
    for r in repos:
        if counts[r["name"]] > 1:
            r["name"] = f"{os.path.basename(os.path.dirname(r['root']))}/{r['name']}"

    json.dump(
        {
            "generatedAt": now.astimezone().isoformat(),
            "since": since,
            "weekday": now.strftime("%A"),
            "sessions": sessions,
            "repos": repos,
        },
        sys.stdout,
        indent=2,
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
