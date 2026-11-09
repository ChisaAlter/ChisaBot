/**
 * The wire shapes the loopback model upstreams in these tests read: an OpenAI chat-completions
 * request and its messages. Only the fields the assertions touch are named.
 */
export type WireMessage = {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  [key: string]: unknown;
};

export type WireBody = {
  model?: string;
  stream?: boolean;
  messages: WireMessage[];
  tools?: {
    type?: string;
    function: { name: string; [key: string]: unknown };
  }[];
  [key: string]: unknown;
};

/** A row read back with raw SQL; the assertions name the columns they check. */
export type Row = Record<string, unknown>;

/** Who started a run, as the DSH agent binding receives it. */
export type Initiator = { kind: string; [key: string]: unknown };
