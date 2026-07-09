import type {
	DeployedAppSummary,
	EvalCriteriaSummary,
	EvalSignalSummary,
	JsonValue,
} from "../../src/types";

export interface TranscriptArtifact {
	result?: string;
	messages?: TranscriptMessage[];
	evaluation?: EvalCriteriaSummary;
	signal?: EvalSignalSummary;
	deployedApps?: DeployedAppSummary[];
	error?: string;
}

export interface TranscriptMessage {
	role: "user" | "assistant";
	content: string | TranscriptBlock[];
}

export type TranscriptBlock =
	| TextBlock
	| ThinkingBlock
	| RedactedThinkingBlock
	| ToolUseBlock
	| ToolResultBlock
	| UnknownBlock;

export interface TextBlock {
	type: "text";
	text?: string;
}

export interface ThinkingBlock {
	type: "thinking";
	thinking?: string;
}

export interface RedactedThinkingBlock {
	type: "redacted_thinking";
}

export interface ToolUseBlock {
	type: "tool_use";
	id?: string;
	name?: string;
	input?: JsonValue;
}

export interface ToolResultBlock {
	type: "tool_result";
	tool_use_id?: string;
	is_error?: boolean;
	content?: unknown;
}

export interface UnknownBlock {
	type?: string;
	[key: string]: unknown;
}

export type RenderBlock =
	| { kind: "text"; text: string }
	| { kind: "thinking"; text: string }
	| { kind: "redacted_thinking" }
	| { kind: "tool_use"; call: ToolUseBlock; result?: ToolResultBlock }
	| { kind: "tool_result"; result: ToolResultBlock }
	| { kind: "unknown"; block: TranscriptBlock };

export interface RenderMessage {
	role: TranscriptMessage["role"];
	blocks: RenderBlock[];
}

function isTextBlock(block: TranscriptBlock): block is TextBlock {
	return block.type === "text";
}

function isThinkingBlock(block: TranscriptBlock): block is ThinkingBlock {
	return block.type === "thinking";
}

function isRedactedThinkingBlock(
	block: TranscriptBlock,
): block is RedactedThinkingBlock {
	return block.type === "redacted_thinking";
}

function isToolUseBlock(block: TranscriptBlock): block is ToolUseBlock {
	return block.type === "tool_use";
}

function isToolResultBlock(block: TranscriptBlock): block is ToolResultBlock {
	return block.type === "tool_result";
}

export function buildRenderMessages(messages: TranscriptMessage[] = []): RenderMessage[] {
	const resultById = new Map<string, ToolResultBlock>();
	const callIds = new Set<string>();

	for (const message of messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (isToolResultBlock(block) && block.tool_use_id != null) {
				resultById.set(block.tool_use_id, block);
			}
			if (isToolUseBlock(block) && block.id != null) {
				callIds.add(block.id);
			}
		}
	}

	return messages
		.map((message) => {
			const blocks = renderBlocks(message.content, resultById, callIds);
			return { role: message.role, blocks };
		})
		.filter((message) => message.blocks.length > 0);
}

function renderBlocks(
	content: TranscriptMessage["content"],
	resultById: Map<string, ToolResultBlock>,
	callIds: Set<string>,
): RenderBlock[] {
	if (typeof content === "string") {
		return content ? [{ kind: "text", text: content }] : [];
	}
	if (!Array.isArray(content)) {
		return [];
	}

	const rendered: RenderBlock[] = [];
	for (const block of content) {
		if (isTextBlock(block)) {
			if (block.text) rendered.push({ kind: "text", text: block.text });
			continue;
		}
		if (isThinkingBlock(block)) {
			rendered.push({
				kind: "thinking",
				text: String(block.thinking ?? "").slice(0, 4000),
			});
			continue;
		}
		if (isRedactedThinkingBlock(block)) {
			rendered.push({ kind: "redacted_thinking" });
			continue;
		}
		if (isToolUseBlock(block)) {
			rendered.push({
				kind: "tool_use",
				call: block,
				result: block.id != null ? resultById.get(block.id) : undefined,
			});
			continue;
		}
		if (isToolResultBlock(block)) {
			if (block.tool_use_id != null && callIds.has(block.tool_use_id)) continue;
			rendered.push({ kind: "tool_result", result: block });
			continue;
		}
		rendered.push({ kind: "unknown", block });
	}
	return rendered;
}

export function toolResultOut(block: ToolResultBlock): string {
	const content = block.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((item) => {
				if (typeof item === "string") return item;
				if (
					item &&
					typeof item === "object" &&
					"text" in item &&
					typeof item.text === "string"
				) {
					return item.text;
				}
				return stringify(item);
			})
			.join("\n");
	}
	return stringify(content);
}

export function stringify(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}
