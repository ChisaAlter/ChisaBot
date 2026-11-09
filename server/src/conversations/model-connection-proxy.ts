import { normalizeModelBaseUrl } from "../../../shared/model-base-url";

/** The Host spends its run capability; only configured credentials reach the model endpoint. */
export function createModelConnectionProxy(
  connection: {
    provider: "openai" | "anthropic";
    baseUrl: string;
    apiKey?: string | null;
    useApiKey?: boolean;
  },
  modelIds: readonly string[],
  toolNames: readonly string[],
  runSignal: AbortSignal,
) {
  const anthropic = connection.provider === "anthropic";
  const endpoint = `${normalizeModelBaseUrl(connection.provider, connection.baseUrl)}/${anthropic ? "messages" : "chat/completions"}`;
  const models = new Set(modelIds);
  const tools = new Set(toolNames);
  return async (
    body: unknown,
    requestSignal: AbortSignal,
  ): Promise<Response> => {
    if (!body || typeof body !== "object" || Array.isArray(body))
      return Response.json(
        { error: "Model request is required." },
        { status: 400 },
      );
    const request = body as { model?: unknown; tools?: unknown };
    if (typeof request.model !== "string" || !models.has(request.model))
      return Response.json(
        { error: "This model was not selected for the run." },
        { status: 403 },
      );
    if (
      request.tools !== undefined &&
      (!Array.isArray(request.tools) ||
        request.tools.some((tool) => {
          const name = anthropic ? tool?.name : tool?.function?.name;
          return typeof name !== "string" || !tools.has(name);
        }))
    )
      return Response.json(
        { error: "The model request contains an ungranted tool." },
        { status: 403 },
      );
    if (connection.useApiKey !== false && !connection.apiKey)
      return Response.json(
        { error: "The configured model API key is missing." },
        { status: 401 },
      );
    const key = connection.useApiKey === false ? undefined : connection.apiKey;
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([runSignal, requestSignal]),
      headers: {
        "content-type": "application/json",
        ...(anthropic ? { "anthropic-version": "2023-06-01" } : {}),
        ...(key
          ? anthropic
            ? { "x-api-key": key }
            : { authorization: `Bearer ${key}` }
          : {}),
      },
      body: JSON.stringify(body),
    });
    const headers = new Headers({ "cache-control": "no-store" });
    for (const name of ["content-type", "retry-after"]) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
