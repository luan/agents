#!/usr/bin/env -S uv run --script
"""Fetch, reply to, and resolve pull request review threads."""

import argparse
import json
import subprocess
import sys
from typing import Any


THREADS_QUERY = """
query($owner: String!, $repo: String!, $pr: Int!, $threads: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $threads) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          viewerCanReply
          viewerCanResolve
          path
          line
          comments(first: 100) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              author { login }
              body
              url
            }
          }
        }
      }
    }
  }
}
"""

COMMENTS_QUERY = """
query($thread: ID!, $comments: String) {
  node(id: $thread) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $comments) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          author { login }
          body
          url
        }
      }
    }
  }
}
"""

REPLY_MUTATION = """
mutation($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(
    input: {pullRequestReviewThreadId: $thread, body: $body}
  ) {
    comment { id url }
  }
}
"""

RESOLVE_MUTATION = """
mutation($thread: ID!) {
  resolveReviewThread(input: {threadId: $thread}) {
    thread { id isResolved }
  }
}
"""


def run_gh(args: list[str]) -> str:
    result = subprocess.run(["gh", *args], capture_output=True, text=True, check=True)
    return result.stdout


def graphql(query: str, variables: dict[str, str | int | None]) -> dict[str, Any]:
    args = ["api", "graphql", "-f", f"query={query}"]
    for name, value in variables.items():
        if value is None:
            continue
        flag = "-F" if isinstance(value, int) else "-f"
        args.extend([flag, f"{name}={value}"])
    return json.loads(run_gh(args))


def fetch_remaining_comments(thread_id: str, cursor: str | None) -> list[dict[str, Any]]:
    comments: list[dict[str, Any]] = []
    while cursor:
        data = graphql(COMMENTS_QUERY, {"thread": thread_id, "comments": cursor})
        connection = data["data"]["node"]["comments"]
        comments.extend(connection["nodes"])
        page = connection["pageInfo"]
        cursor = page["endCursor"] if page["hasNextPage"] else None
    return comments


def fetch_unresolved_threads(repo: str, pr_number: int) -> list[dict[str, Any]]:
    owner, name = repo.split("/", 1)
    unresolved: list[dict[str, Any]] = []
    cursor: str | None = None

    while True:
        data = graphql(
            THREADS_QUERY,
            {"owner": owner, "repo": name, "pr": pr_number, "threads": cursor},
        )
        connection = data["data"]["repository"]["pullRequest"]["reviewThreads"]
        for thread in connection["nodes"]:
            if thread["isResolved"]:
                continue

            comments = thread["comments"]
            nodes = comments["nodes"]
            page = comments["pageInfo"]
            if page["hasNextPage"]:
                nodes.extend(fetch_remaining_comments(thread["id"], page["endCursor"]))

            unresolved.append(
                {
                    "thread_id": thread["id"],
                    "path": thread["path"],
                    "line": thread["line"],
                    "viewer_can_reply": thread["viewerCanReply"],
                    "viewer_can_resolve": thread["viewerCanResolve"],
                    "comments": [
                        {
                            "id": comment["id"],
                            "author": (comment.get("author") or {}).get("login"),
                            "body": comment["body"],
                            "url": comment["url"],
                        }
                        for comment in nodes
                    ],
                }
            )

        page = connection["pageInfo"]
        if not page["hasNextPage"]:
            return unresolved
        cursor = page["endCursor"]


def reply(thread_id: str, body: str) -> dict[str, Any]:
    data = graphql(REPLY_MUTATION, {"thread": thread_id, "body": body})
    comment = data["data"]["addPullRequestReviewThreadReply"]["comment"]
    return {"replied": True, "comment_id": comment["id"], "url": comment["url"]}


def resolve(thread_id: str) -> dict[str, Any]:
    data = graphql(RESOLVE_MUTATION, {"thread": thread_id})
    thread = data["data"]["resolveReviewThread"]["thread"]
    return {"thread_id": thread["id"], "resolved": thread["isResolved"]}


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)

    fetch = commands.add_parser("fetch", help="fetch unresolved review threads")
    fetch.add_argument("--pr", type=int, required=True, help="pull request number")
    fetch.add_argument("--repo", required=True, help="owner/name")

    reply_command = commands.add_parser("reply", help="reply to a review thread")
    reply_command.add_argument("--thread-id", required=True, help="review thread node ID")
    reply_command.add_argument("--body", required=True, help="reply body")

    resolve_command = commands.add_parser("resolve", help="resolve a review thread")
    resolve_command.add_argument("--thread-id", required=True, help="review thread node ID")
    return root


def main() -> None:
    args = parser().parse_args()
    try:
        if args.command == "fetch":
            output = {"unresolved_threads": fetch_unresolved_threads(args.repo, args.pr)}
        elif args.command == "reply":
            output = reply(args.thread_id, args.body)
        else:
            output = resolve(args.thread_id)
    except (KeyError, TypeError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Error: {args.command} failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error

    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
