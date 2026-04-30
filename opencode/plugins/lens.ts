import { spawn } from "node:child_process";
import type { Plugin } from "@opencode-ai/plugin";

export const id = "agents-lens";

export const server: Plugin = async ({ directory }) => {
  const hook = (name: string, payload: any) =>
    runLensHook(name, payload, directory);

  return {
    async event({ event }) {
      if (event.type === "session.created") {
        const sessionID = event.properties?.info?.id;
        if (sessionID) {
          await hook(
            "lens-session-start",
            basePayload(directory, sessionID, "SessionStart"),
          );
        }
      }
      if (event.type === "session.idle") {
        const sessionID = event.properties?.sessionID;
        if (sessionID) {
          await hook(
            "lens-turn-end",
            basePayload(directory, sessionID, "Stop"),
          );
          await hook(
            "lens-agent-end",
            basePayload(directory, sessionID, "Stop"),
          );
        }
      }
    },

    async "tool.execute.before"(input, output) {
      await hook("lens-pre-tool", {
        ...basePayload(directory, input.sessionID, "PreToolUse"),
        tool_name: input.tool,
        tool_call_id: input.callID,
        tool_input: output.args,
      });
    },

    async "tool.execute.after"(input, output) {
      await hook("lens-post-tool", {
        ...basePayload(directory, input.sessionID, "PostToolUse"),
        tool_name: input.tool,
        tool_call_id: input.callID,
        tool_input: input.args,
        tool_response: {
          title: output.title,
          output: output.output,
          metadata: output.metadata,
        },
      });
    },
  };
};

function basePayload(cwd: string, sessionID: string, hookEventName: string) {
  return {
    session_id: sessionID,
    turn_id: sessionID,
    cwd,
    hook_event_name: hookEventName,
  };
}

async function runLensHook(name: string, payload: any, cwd: string) {
  await new Promise((resolve) => {
    const child = spawn("ct", ["hook", name], {
      cwd,
      env: { ...process.env, CT_LENS_HOST: "opencode" },
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", resolve);
    child.on("close", resolve);
    child.stdin.end(JSON.stringify(payload));
  });
}
