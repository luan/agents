# Test Quality

## Gate

Every test must answer: **"What bug would this catch?"** No realistic scenario = delete.

## TDD

1. Write failing test
2. Confirm red
3. Minimal implementation to pass
4. Confirm green
5. Refactor, stay green

No test infrastructure in project? Note it, proceed without tests.
Visuals? Skip tests unless you can automate them. Checking that text shows up is not useful in and of itself.

## Banned

- **Tautology** — returns what you told it, obvious
- **Getter/setter** — compiler catches this
- **Implementation mirror** — test duplicates production formula
- **Constant echo** — `assert_eq!(MY_CONST, 42)` restates definition
- **Content absence** — `assert!(!contains("blabla"))` false positives, brittle
- **Happy-path-only** — bugs live at boundaries
- **Coverage padding** — executes without asserting
- **No-assertion smoke** — constructs object, asserts nothing
- **Feature absence** — don't assert that unrelated, deleted, or never-implemented behavior is absent. Test only behavior that exists in the current contract.
- **Sleeps** — non-deterministic, slow, brittle. Synchronize on events instead.

## What to Test

Boundaries, error paths, state transitions, race conditions, real integrations, round-trip invariants, known-answer algorithm checks.

## Mocks

Last resort. Every mock removes a real integration.

- Mock external services only (network, filesystem, clock, third-party APIs)
- Never mock the thing under test
- Never mock collaborators you own
- 3+ mocks = design too coupled — simplify the design

## Deletion Test

"If I delete this test and break the code, does another test catch it?" Yes = redundant. Delete.

## Failures

All tests pass before committing. You own every failure you can see, regardless of who introduced it. Fix the failure, then continue.

## Pre-Commit

Before writing any test:

1. State the bug scenario in one sentence
2. "Field doesn't store value" → don't write it
3. Assertion mirrors production formula → use known-answer
4. Tests a constant → don't write it
5. Compiler catches it → don't write it
