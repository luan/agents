# Upstream

- Source repository: `https://github.com/IgorWarzocha/howaboua-pi-stuff`
- Source commit: `5d88318e65368b8d118d6272d283bbd0031ddcca`
- Source package: `packages/pi-codex-conversion`
- Embedded Codex source: `openai/codex@b545c94041017d000e2c8b2f6272705d21b85dfb`

The package adapts the upstream native tool to Pi with direct `pi.registerTool` registration.

Direct and Code Mode calls share the same Pi tool definition. A Code Mode
adapter exposes freeform patch input without a runtime extension dependency.

The Code Mode adapter only bridges execution. Code Mode owns tool exposure.

The direct Pi tool carries Codex's Lark grammar. OpenAI-compatible models with
grammar tools serialize it as a native freeform tool. Other providers use the
`{ input: string }` function-tool fallback.

Provider gating, display brokerage, and artifact URI behavior are intentionally absent.
