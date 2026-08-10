#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///

import ast
import asyncio
import contextlib
import inspect
import io
import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any

_output: list[str] = []
_cwd = Path.cwd()
_protocol = sys.stdout


def _format(value: Any) -> str:
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, indent=2, default=str)
    except (TypeError, ValueError):
        return repr(value)


def display(value: Any) -> None:
    _output.append(_format(value))


def read(path: str) -> str:
    return (_cwd / path).resolve().read_text(encoding="utf-8")


_state: dict[str, Any] = {
    "__builtins__": __builtins__,
    "display": display,
    "read": read,
}


def _compile_cell(source: str, cell_id: int):
    tree = ast.parse(source, filename=f"eval-{cell_id}.py", mode="exec")
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        expression = tree.body[-1]
        tree.body[-1:] = [
            ast.Assign(
                targets=[ast.Name(id="__eval_result", ctx=ast.Store())],
                value=expression.value,
            ),
            ast.If(
                test=ast.Compare(
                    left=ast.Name(id="__eval_result", ctx=ast.Load()),
                    ops=[ast.IsNot()],
                    comparators=[ast.Constant(value=None)],
                ),
                body=[
                    ast.Expr(
                        value=ast.Call(
                            func=ast.Name(id="display", ctx=ast.Load()),
                            args=[ast.Name(id="__eval_result", ctx=ast.Load())],
                            keywords=[],
                        )
                    )
                ],
                orelse=[],
            ),
        ]
        ast.fix_missing_locations(tree)
    return compile(tree, f"eval-{cell_id}.py", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)


def _evaluate(request: dict[str, Any]) -> dict[str, Any]:
    global _cwd, _output
    cell_id = int(request["id"])
    _cwd = Path(request["cwd"]).resolve()
    os.chdir(_cwd)
    _output = []
    captured = io.StringIO()
    try:
        code = _compile_cell(str(request["code"]), cell_id)
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            result = eval(code, _state, _state)
            if inspect.isawaitable(result):
                asyncio.run(result)
        text = captured.getvalue().rstrip("\n")
        if text:
            _output.insert(0, text)
        return {"id": cell_id, "output": "\n".join(_output) or "(no output)"}
    except BaseException:
        text = captured.getvalue().rstrip("\n")
        if text:
            _output.insert(0, text)
        return {
            "id": cell_id,
            "output": "\n".join(_output),
            "error": traceback.format_exc(),
        }


def main() -> None:
    for line in sys.stdin:
        try:
            response = _evaluate(json.loads(line))
        except BaseException:
            response = {"id": -1, "output": "", "error": traceback.format_exc()}
        _protocol.write(json.dumps(response) + "\n")
        _protocol.flush()


if __name__ == "__main__":
    main()
