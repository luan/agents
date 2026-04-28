#!/usr/bin/env bash
# Human-in-the-loop reproduction loop. Copy this file and replace the example
# steps with the exact manual actions needed for the bug under investigation.

set -euo pipefail

step() {
  printf '\n>>> %s\n' "$1"
  read -r -p "    [Enter when done] " _
}

capture() {
  local var="$1" question="$2" answer
  printf '\n>>> %s\n' "$question"
  read -r -p "    > " answer
  printf -v "$var" '%s' "$answer"
}

# --- edit below ---------------------------------------------------------

step "<open the affected system and reach the starting state>"

capture REPRODUCED "<perform the trigger>. Did the reported symptom occur? (y/n)"

capture OBSERVED "Describe the observed result, including exact error text if any:"

# --- edit above ---------------------------------------------------------

printf '\n--- Captured ---\n'
printf 'REPRODUCED=%s\n' "$REPRODUCED"
printf 'OBSERVED=%s\n' "$OBSERVED"
