import { spawn } from "node:child_process";
import type { Plugin } from "@opencode-ai/plugin";

export const id = "agents-lens";

export const server: Plugin = async ({ client, directory }) => {
  const queuedReports = new Set<string>();
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
          const response = await hook(
            "lens-turn-end",
            basePayload(directory, sessionID, "Stop"),
          );
          await queueFollowup(client, directory, sessionID, response, queuedReports);
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
  const stdout = await new Promise<string>((resolve) => {
    let output = "";
    const child = spawn("ct", ["hook", name], {
      cwd,
      env: { ...process.env, CT_LENS_HOST: "opencode" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(output));
    child.stdin.end(JSON.stringify(payload));
  });
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

async function queueFollowup(
  client: any,
  directory: string,
  sessionID: string,
  response: any,
  queuedReports: Set<string>,
) {
  const context = response?.context;
  if (context?.requires_followup !== true || context?.inject !== true) return;
  const content = typeof context.content === "string" ? context.content.trim() : "";
  if (!content) return;
  const fingerprint = typeof context.fingerprint === "string" ? context.fingerprint : content;
  if (queuedReports.has(fingerprint)) return;
  queuedReports.add(fingerprint);
  await client.session.promptAsync({
    path: { id: sessionID },
    query: { directory },
    body: {
      parts: [
        {
          type: "text",
          text: content,
          synthetic: true,
          metadata: {
            source: "lens",
            fingerprint,
            severity: context.severity,
          },
        },
      ],
    },
  });
}
