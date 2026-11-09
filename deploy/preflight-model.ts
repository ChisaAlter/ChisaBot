const key = process.env.OPENAI_API_KEY;
const base = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(
  /\/+$/,
  "",
);
const model = process.env.BOT_MODEL ?? "your-model-id";
if (!key) throw new Error("OPENAI_API_KEY is required.");
const instruction =
  "You MUST call chisabot_check with message set to OK. Do not describe a tool call.";
const tool = {
  name: "chisabot_check",
  description: "A text-only test with no external action.",
  parameters: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
};
const endpoints = [
  {
    path: "/chat/completions",
    body: {
      model,
      stream: false,
      max_tokens: 1024,
      messages: [{ role: "user", content: instruction }],
      tools: [{ type: "function", function: tool }],
      tool_choice: "auto",
    },
  },
  {
    path: "/responses",
    body: {
      model,
      stream: false,
      max_output_tokens: 1024,
      input: instruction,
      tools: [{ type: "function", ...tool }],
      tool_choice: "auto",
    },
  },
];
let verified: string | undefined;
const failures: string[] = [];
for (const endpoint of endpoints) {
  try {
    const response = await fetch(base + endpoint.path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify(endpoint.body),
    });
    if (!response.ok) {
      failures.push(endpoint.path + ": HTTP " + response.status);
      continue;
    }
    const result = (await response.json()) as {
      choices?: {
        message: {
          tool_calls?: { function: { name: string; arguments: string } }[];
        };
      }[];
      output?: { type: string; name?: string; arguments?: string }[];
    };
    const chatCall = result.choices?.[0]?.message.tool_calls?.[0]?.function;
    const responseCall = result.output?.find(
      (item) => item.type === "function_call",
    );
    const call = chatCall ?? responseCall;
    if (call?.name === "chisabot_check" && call.arguments) {
      JSON.parse(call.arguments);
      verified = endpoint.path;
      break;
    }
    failures.push(endpoint.path + ": no standard tool call");
  } catch {
    failures.push(endpoint.path + ": request failed");
  }
}
if (!verified)
  throw new Error("Model tool-call preflight failed: " + failures.join("; "));
await Bun.write(
  "/deployment/model-preflight.json",
  JSON.stringify(
    {
      model,
      tool_call: true,
      protocol: verified,
      endpoint: "configured-provider",
    },
    null,
    2,
  ) + "\n",
);
console.log("Model tool-call preflight passed:", model);
