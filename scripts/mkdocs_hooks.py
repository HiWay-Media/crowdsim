"""MkDocs build hooks for the crowdsim documentation site.

Both hooks exist for the same reason: the markdown in docs/ has to stay correct
when it is read in the repository on GitHub, which is where most people will
meet it first. Nothing here changes a source file.

1. `on_page_markdown` rewrites links that point outside docs/
   (`../ci/README.md`, `../profiles/example.json`,
   `../cache-ab/candidate.conf.template`). Those relative paths resolve in the
   repository and mean nothing once the page is served from /crowdsim/, so they
   become github.com URLs.

2. `on_files` generates the Changelog page from the repository's CHANGELOG.md
   instead of duplicating it — the release script and release.yml both expect
   that file at the root. Its links are written relative to the root, one level
   off for a page inside docs/, so they are resolved on the way in.

A pymdownx.snippets include would be shorter, but snippets are expanded during
markdown conversion — after `on_page_markdown` and after MkDocs has already
validated the page's links, so every cross-reference in the changelog would be
reported as broken under --strict.
"""

import os
import re

from mkdocs.structure.files import File

REPO_BLOB = "https://github.com/HiWay-Media/crowdsim/blob/main/"

# [text](../some/path), optionally with an #anchor. Absolute URLs never match.
_OUTSIDE_LINK = re.compile(r"\]\(\.\./([^)\s#]+)(#[^)\s]*)?\)")

# [text](any/relative/path) — applied only to the generated changelog.
_ROOT_LINK = re.compile(r"\]\((?!https?:|#|/)([^)\s#]+)(#[^)\s]*)?\)")

_CHANGELOG_HEADER = """# Changelog

Every crowdsim release, from the notes shipped with its tag. The source of this
page is [`CHANGELOG.md`]({blob}CHANGELOG.md) at the repository root.

""".format(blob=REPO_BLOB)


def _to_blob(match):
    path, anchor = match.group(1), match.group(2) or ""
    # The one file outside docs/ that the site does have a page for: pages link
    # to ../CHANGELOG.md so the reference also works when read on GitHub.
    if path == "CHANGELOG.md":
        return "](changelog.md" + anchor + ")"
    return "](" + REPO_BLOB + path + anchor + ")"


def _from_repo_root(match):
    """Resolve a root-relative link as seen from a page inside docs/."""
    path, anchor = match.group(1), match.group(2) or ""
    if path.startswith("docs/"):
        return "](" + path[len("docs/"):] + anchor + ")"
    return "](" + REPO_BLOB + path + anchor + ")"


def on_files(files, config, **kwargs):
    root = os.path.dirname(os.path.abspath(config["config_file_path"]))
    source = os.path.join(root, "CHANGELOG.md")
    if not os.path.exists(source):
        return files

    with open(source, encoding="utf-8") as handle:
        body = handle.read()

    # Drop the changelog's own H1: the generated page supplies the page title,
    # and two H1s would give the theme's table of contents two roots.
    body = re.sub(r"\A#\s+.*?\n+", "", body, count=1)
    body = _ROOT_LINK.sub(_from_repo_root, body)

    files.append(
        File.generated(config, "changelog.md", content=_CHANGELOG_HEADER + body)
    )
    return files


def on_page_markdown(markdown, page, config, files, **kwargs):
    return _OUTSIDE_LINK.sub(_to_blob, markdown)
