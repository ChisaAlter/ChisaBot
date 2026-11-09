import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import {
  BlockAssembler,
  createUserMessage,
  LlmError,
} from "@deepseek-ai/dsh-llm";

const instruction = `You are now acting as a compaction engine. Summarize the conversation above so the next model can continue the unfinished work.
Preserve exact user requests, corrections, constraints, identifiers, numbers, file paths, attachment references, source references, decisions, completed effects and their receipts, unresolved errors and unknown outcomes.
Keep pending work separate from completed work. Never invent a success or repeat an already completed external action. Merge prior checkpoints with newer facts; retain their still-relevant details.
Use short sections: Request, Decisions, Files and Sources, Completed Work, Pending Work, Unknown Outcomes, Next Step. Output only the checkpoint text; do not call tools.`;

/** Keep upstream surface selection, shrink validation and persistence; summarize on the bound model. */
export default class ChisaCompaction extends BasicCompactionEngine {
  async summarize(input, agent, signal) {
    // The previous header may name a retired run credential/provider. A newly selected model
    // is the currently authorized route, including while DSH checks its smaller context window.
    const target = agent.model.current();
    if (!target)
      throw new Error("No bound model is available for context compaction.");
    const maxTokens = this.config.maxTokens;
    const assembler = new BlockAssembler();
    for await (const chunk of this.ctx.llm.stream({
      ...target,
      maxTokens,
      purpose: "compaction",
      signal,
      sessionId: agent.session.id,
      messages: [
        ...input.messages,
        createUserMessage({
          content: [{ type: "text", text: instruction }],
          source: { kind: "user" },
        }),
      ],
      toolHistory: agent.session.toolHistory(),
      ...(input.tools ? { tools: [...input.tools] } : {}),
    }))
      assembler.push(chunk);
    if (
      assembler.finish.kind === "error" ||
      assembler.finish.kind === "aborted"
    ) {
      const { failure } = assembler.finish;
      throw new LlmError(failure.message, failure.code, failure);
    }
    if (assembler.finish.kind !== "stop")
      throw new Error(
        "Context summary did not finish with a complete text response.",
      );
    const rawOutput = assembler.blocks();
    if (
      rawOutput.some(
        (block) => block.type !== "text" && block.type !== "reasoning",
      )
    )
      throw new Error("Context summary returned non-text content.");
    const summary = rawOutput.filter((block) => block.type === "text");
    if (!summary.some((block) => block.text.trim()))
      throw new Error("Context summary returned no text.");
    return {
      summary,
      rawOutput,
      llmStreamCall: true,
      provider: target.provider,
      model: target.model,
      maxTokens,
      ...(assembler.usage ? { usage: assembler.usage } : {}),
    };
  }
}
