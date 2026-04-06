#!/usr/bin/env node
/**
 * Pi SDK ACP Adapter
 *
 * ACP-compliant adapter that embeds the Pi coding agent SDK directly
 * instead of spawning a subprocess. This avoids loading ~100MB of TUI
 * code that the CLI pulls in even in headless mode.
 *
 * Speaks ACP JSON-RPC over stdin/stdout using @agentclientprotocol/sdk.
 * Internally calls createAgentSession() from @mariozechner/pi-coding-agent.
 */
import { AgentSideConnection, ndJsonStream, } from "@agentclientprotocol/sdk";
import { SessionManager, createAgentSession, createCodingTools, createFindTool, createGrepTool, createLsTool, } from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
// ── CLI argument parsing ────────────────────────────────────────────
let appendSystemPrompt;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--append-system-prompt" && i + 1 < argv.length) {
        appendSystemPrompt = argv[i + 1];
        i++;
    }
}
function resolveSessionManager(cwd) {
    const sessionDir = process.env.PI_SESSION_DIR?.trim();
    if (sessionDir) {
        mkdirSync(sessionDir, { recursive: true });
        return SessionManager.continueRecent(cwd, sessionDir);
    }
    return SessionManager.continueRecent(cwd);
}
function resolveExplicitModel() {
    const modelId = process.env.DESKTOP_MODEL?.trim();
    if (!modelId) {
        return undefined;
    }
    if (modelId.startsWith("claude-")) {
        return getModel("anthropic", modelId);
    }
    if (process.env.OPENROUTER_API_KEY?.trim() && modelId.includes("/")) {
        return getModel("openrouter", modelId);
    }
    return undefined;
}
function resolvePromptInput(input) {
    if (!input) {
        return undefined;
    }
    if (existsSync(input)) {
        try {
            return readFileSync(input, "utf-8");
        }
        catch {
            return input;
        }
    }
    return input;
}
function loadContextFileFromDir(dir) {
    const candidates = ["AGENTS.md", "CLAUDE.md"];
    for (const filename of candidates) {
        const filePath = join(dir, filename);
        if (!existsSync(filePath))
            continue;
        try {
            return {
                path: filePath,
                content: readFileSync(filePath, "utf-8"),
            };
        }
        catch {
            continue;
        }
    }
    return null;
}
function loadProjectContextFiles(cwd, agentDir) {
    const contextFiles = [];
    const seenPaths = new Set();
    const globalContext = loadContextFileFromDir(agentDir);
    if (globalContext) {
        contextFiles.push(globalContext);
        seenPaths.add(globalContext.path);
    }
    const ancestorContextFiles = [];
    let currentDir = cwd;
    while (true) {
        const contextFile = loadContextFileFromDir(currentDir);
        if (contextFile && !seenPaths.has(contextFile.path)) {
            ancestorContextFiles.unshift(contextFile);
            seenPaths.add(contextFile.path);
        }
        const parentDir = resolvePath(currentDir, "..");
        if (parentDir === currentDir) {
            break;
        }
        currentDir = parentDir;
    }
    contextFiles.push(...ancestorContextFiles);
    return contextFiles;
}
function createHeadlessExtensionRuntime() {
    const notInitialized = () => {
        throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
    };
    const runtime = {
        sendMessage: notInitialized,
        sendUserMessage: notInitialized,
        appendEntry: notInitialized,
        setSessionName: notInitialized,
        getSessionName: notInitialized,
        setLabel: notInitialized,
        getActiveTools: notInitialized,
        getAllTools: notInitialized,
        setActiveTools: notInitialized,
        refreshTools: () => { },
        getCommands: notInitialized,
        setModel: () => Promise.reject(new Error("Extension runtime not initialized")),
        getThinkingLevel: notInitialized,
        setThinkingLevel: notInitialized,
        flagValues: new Map(),
        pendingProviderRegistrations: [],
        registerProvider: (name, config) => {
            runtime.pendingProviderRegistrations.push({ name, config });
        },
        unregisterProvider: (name) => {
            runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter((registration) => registration.name !== name);
        },
    };
    return runtime;
}
class HeadlessResourceLoader {
    cwd;
    agentDir;
    appendSystemPromptSource;
    extensionsResult;
    skills = [];
    skillDiagnostics = [];
    prompts = [];
    promptDiagnostics = [];
    agentsFiles = [];
    systemPrompt;
    appendSystemPrompt = [];
    pathMetadata = new Map();
    constructor({ cwd, agentDir, appendSystemPrompt }) {
        this.cwd = cwd;
        this.agentDir = agentDir;
        this.appendSystemPromptSource = appendSystemPrompt;
        this.extensionsResult = {
            extensions: [],
            errors: [],
            runtime: createHeadlessExtensionRuntime(),
        };
    }
    getExtensions() {
        return this.extensionsResult;
    }
    getSkills() {
        return {
            skills: this.skills,
            diagnostics: this.skillDiagnostics,
        };
    }
    getPrompts() {
        return {
            prompts: this.prompts,
            diagnostics: this.promptDiagnostics,
        };
    }
    getThemes() {
        return {
            themes: [],
            diagnostics: [],
        };
    }
    getAgentsFiles() {
        return {
            agentsFiles: this.agentsFiles,
        };
    }
    getSystemPrompt() {
        return this.systemPrompt;
    }
    getAppendSystemPrompt() {
        return this.appendSystemPrompt;
    }
    getPathMetadata() {
        return this.pathMetadata;
    }
    extendResources() {
    }
    async reload() {
        this.skills = [];
        this.skillDiagnostics = [];
        this.prompts = [];
        this.promptDiagnostics = [];
        this.agentsFiles = loadProjectContextFiles(this.cwd, this.agentDir);
        this.systemPrompt = undefined;
        const appendPrompt = resolvePromptInput(this.appendSystemPromptSource);
        this.appendSystemPrompt = appendPrompt ? [appendPrompt] : [];
        this.pathMetadata = new Map();
    }
}
// ── Agent implementation ────────────────────────────────────────────
class PiSdkAgent {
    conn;
    session = null;
    sessionId = "";
    cwd = "/home/user";
    cancelRequested = false;
    currentToolCalls = new Map();
    editSnapshots = new Map();
    lastEmit = Promise.resolve();
    emittedAssistantText = "";
    constructor(conn) {
        this.conn = conn;
    }
    async initialize(_params) {
        return {
            protocolVersion: 1,
            agentInfo: {
                name: "pi-sdk-acp",
                title: "Pi SDK ACP adapter",
                version: "0.1.0",
            },
            agentCapabilities: {
                promptCapabilities: {
                    image: true,
                    audio: false,
                    embeddedContext: false,
                },
            },
        };
    }
    async newSession(params) {
        this.cwd = params.cwd;
        const resourceLoader = new HeadlessResourceLoader({
            cwd: params.cwd,
            agentDir: join(homedir(), ".pi", "agent"),
            ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
        });
        await resourceLoader.reload();
        const explicitModel = resolveExplicitModel();
        const { session, extensionsResult } = await createAgentSession({
            cwd: params.cwd,
            ...(explicitModel ? { model: explicitModel } : {}),
            sessionManager: resolveSessionManager(params.cwd),
            resourceLoader,
            tools: [
                ...createCodingTools(params.cwd),
                createGrepTool(params.cwd),
                createFindTool(params.cwd),
                createLsTool(params.cwd),
            ],
        });
        this.session = session;
        this.sessionId = session.sessionId;
        // Subscribe to Pi SDK events and translate to ACP notifications
        session.subscribe((event) => this.handlePiEvent(event));
        // Build thinking modes
        const thinkingLevels = session.getAvailableThinkingLevels();
        const modes = {
            currentModeId: session.thinkingLevel,
            availableModes: thinkingLevels.map((id) => ({
                id,
                name: `Thinking: ${id}`,
            })),
        };
        return {
            sessionId: this.sessionId,
            modes,
        };
    }
    async prompt(params) {
        if (!this.session) {
            throw new Error("No session created");
        }
        this.cancelRequested = false;
        this.currentToolCalls.clear();
        this.emittedAssistantText = "";
        let promptError = null;
        // Extract text from prompt parts
        const promptParts = params.prompt ?? [];
        const text = promptParts
            .map((p) => p.type === "text" ? (p.text ?? "") : "")
            .join("");
        // session.prompt() resolves when the agent loop completes.
        // Events fire via subscribe() during execution and are translated
        // to ACP notifications in handlePiEvent().
        try {
            await this.session.prompt(text);
        }
        catch (error) {
            if (!this.cancelRequested) {
                promptError = error;
            }
        }
        // Flush any pending notifications before returning the response
        await this.lastEmit;
        if (promptError) {
            throw promptError;
        }
        const finalText = this.session.getLastAssistantText();
        if (finalText) {
            const emittedText = this.emittedAssistantText;
            const missingText = emittedText && finalText.startsWith(emittedText)
                ? finalText.slice(emittedText.length)
                : emittedText === finalText
                    ? ""
                    : finalText;
            const isRepeatedTail = Boolean(missingText && emittedText && emittedText.endsWith(missingText));
            if (missingText && !isRepeatedTail) {
                this.emittedAssistantText = finalText;
                await this.emit({
                    sessionUpdate: "agent_message_chunk",
                    content: {
                        type: "text",
                        text: missingText,
                    },
                });
                await this.lastEmit;
            }
        }
        const stopReason = this.cancelRequested ? "cancelled" : "end_turn";
        return {
            stopReason: stopReason,
        };
    }
    async cancel(_params) {
        this.cancelRequested = true;
        await this.session?.abort();
    }
    async setSessionMode(params) {
        if (!this.session)
            return;
        this.session.setThinkingLevel(params.modeId);
        await this.emit({
            sessionUpdate: "current_mode_update",
            currentModeId: params.modeId,
        });
    }
    async authenticate(_params) {
        // Auth handled via env vars (ANTHROPIC_API_KEY)
    }
    // ── Event translation ───────────────────────────────────────────
    emit(update) {
        this.lastEmit = this.lastEmit
            .then(() => this.conn.sessionUpdate({
            sessionId: this.sessionId,
            update,
        }))
            .catch(() => { });
        return this.lastEmit;
    }
    handlePiEvent(event) {
        switch (event.type) {
            case "message_update": {
                const ame = event.assistantMessageEvent;
                if (!ame)
                    break;
                if (ame.type === "text_delta" && "delta" in ame) {
                    this.emittedAssistantText += String(ame.delta);
                    this.emit({
                        sessionUpdate: "agent_message_chunk",
                        content: {
                            type: "text",
                            text: String(ame.delta),
                        },
                    });
                }
                else if (ame.type === "thinking_delta" && "delta" in ame) {
                    this.emit({
                        sessionUpdate: "agent_thought_chunk",
                        content: {
                            type: "text",
                            text: String(ame.delta),
                        },
                    });
                }
                else if (ame.type === "toolcall_start" ||
                    ame.type === "toolcall_delta" ||
                    ame.type === "toolcall_end") {
                    this.handleToolCallMessage(ame);
                }
                break;
            }
            case "tool_execution_start":
                this.handleToolExecutionStart(event);
                break;
            case "tool_execution_update":
                this.handleToolExecutionUpdate(event);
                break;
            case "tool_execution_end":
                this.handleToolExecutionEnd(event);
                break;
            case "agent_end":
                // Agent loop finished. Notifications are flushed in prompt().
                break;
        }
    }
    handleToolCallMessage(ame) {
        const toolCall = ame.toolCall ??
            ame.partial
                ?.content?.[ame.contentIndex ?? 0];
        if (!toolCall)
            return;
        const toolCallId = String(toolCall.id ?? "");
        const toolName = String(toolCall.name ?? "tool");
        if (!toolCallId)
            return;
        const rawInput = this.parseToolArgs(toolCall);
        const locations = this.toToolCallLocations(rawInput);
        const existingStatus = this.currentToolCalls.get(toolCallId);
        const status = existingStatus ?? "pending";
        if (!existingStatus) {
            this.currentToolCalls.set(toolCallId, "pending");
            this.emit({
                sessionUpdate: "tool_call",
                toolCallId,
                title: toolName,
                kind: toToolKind(toolName),
                status: status,
                locations,
                rawInput,
            });
        }
        else {
            this.emit({
                sessionUpdate: "tool_call_update",
                toolCallId,
                status: status,
                locations,
                rawInput,
            });
        }
    }
    handleToolExecutionStart(event) {
        const { toolCallId, toolName, args } = event;
        const rawInput = args;
        // Snapshot for edit diff support
        if (toolName === "edit" && rawInput) {
            const p = typeof rawInput.path === "string" ? rawInput.path : undefined;
            if (p) {
                try {
                    const abs = isAbsolute(p)
                        ? p
                        : resolvePath(this.cwd, p);
                    const oldText = readFileSync(abs, "utf8");
                    this.editSnapshots.set(toolCallId, {
                        path: p,
                        oldText,
                    });
                }
                catch {
                    // File may not exist
                }
            }
        }
        const locations = this.toToolCallLocations(rawInput);
        if (!this.currentToolCalls.has(toolCallId)) {
            this.currentToolCalls.set(toolCallId, "in_progress");
            this.emit({
                sessionUpdate: "tool_call",
                toolCallId,
                title: toolName,
                kind: toToolKind(toolName),
                status: "in_progress",
                locations,
                rawInput,
            });
        }
        else {
            this.currentToolCalls.set(toolCallId, "in_progress");
            this.emit({
                sessionUpdate: "tool_call_update",
                toolCallId,
                status: "in_progress",
                locations,
                rawInput,
            });
        }
    }
    handleToolExecutionUpdate(event) {
        const { toolCallId, partialResult } = event;
        const text = toolResultToText(partialResult);
        this.emit({
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
            content: text
                ? [{ type: "content", content: { type: "text", text } }]
                : undefined,
            rawOutput: partialResult,
        });
    }
    handleToolExecutionEnd(event) {
        const { toolCallId, result, isError } = event;
        const text = toolResultToText(result);
        const snapshot = this.editSnapshots.get(toolCallId);
        let content;
        // Generate diff for edit tool
        if (!isError && snapshot) {
            try {
                const abs = isAbsolute(snapshot.path)
                    ? snapshot.path
                    : resolvePath(this.cwd, snapshot.path);
                const newText = readFileSync(abs, "utf8");
                if (newText !== snapshot.oldText) {
                    content = [
                        {
                            type: "diff",
                            path: snapshot.path,
                            oldText: snapshot.oldText,
                            newText,
                        },
                        ...(text
                            ? [
                                {
                                    type: "content",
                                    content: { type: "text", text },
                                },
                            ]
                            : []),
                    ];
                }
            }
            catch {
                // File may have been deleted
            }
        }
        if (!content && text) {
            content = [
                { type: "content", content: { type: "text", text } },
            ];
        }
        this.emit({
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: isError ? "failed" : "completed",
            content,
            rawOutput: result,
        });
        this.currentToolCalls.delete(toolCallId);
        this.editSnapshots.delete(toolCallId);
    }
    // ── Helpers ──────────────────────────────────────────────────────
    parseToolArgs(toolCall) {
        if (toolCall.arguments &&
            typeof toolCall.arguments === "object") {
            return toolCall.arguments;
        }
        const s = String(toolCall.partialArgs ?? "");
        if (!s)
            return undefined;
        try {
            return JSON.parse(s);
        }
        catch {
            return { partialArgs: s };
        }
    }
    toToolCallLocations(args) {
        const path = typeof args?.path === "string" ? args.path : undefined;
        if (!path)
            return undefined;
        const resolvedPath = isAbsolute(path)
            ? path
            : resolvePath(this.cwd, path);
        return [{ path: resolvedPath }];
    }
}
// ── Standalone helpers ──────────────────────────────────────────────
function toToolKind(toolName) {
    if (toolName === "read")
        return "read";
    if (toolName === "write" || toolName === "edit")
        return "edit";
    return "other";
}
function toolResultToText(result) {
    if (!result)
        return "";
    const r = result;
    const content = r.content;
    if (Array.isArray(content)) {
        const texts = content
            .map((c) => c?.type === "text" && typeof c.text === "string"
            ? c.text
            : "")
            .filter(Boolean);
        if (texts.length)
            return texts.join("");
    }
    const details = r.details;
    const stdout = (typeof details?.stdout === "string" ? details.stdout : undefined) ??
        (typeof r.stdout === "string" ? r.stdout : undefined) ??
        (typeof details?.output === "string" ? details.output : undefined) ??
        (typeof r.output === "string" ? r.output : undefined);
    const stderr = (typeof details?.stderr === "string" ? details.stderr : undefined) ??
        (typeof r.stderr === "string" ? r.stderr : undefined);
    const exitCode = (typeof details?.exitCode === "number"
        ? details.exitCode
        : undefined) ??
        (typeof r.exitCode === "number" ? r.exitCode : undefined) ??
        (typeof details?.code === "number" ? details.code : undefined) ??
        (typeof r.code === "number" ? r.code : undefined);
    if ((typeof stdout === "string" && stdout.trim()) ||
        (typeof stderr === "string" && stderr.trim())) {
        const parts = [];
        if (typeof stdout === "string" && stdout.trim())
            parts.push(stdout);
        if (typeof stderr === "string" && stderr.trim())
            parts.push(`stderr:\n${stderr}`);
        if (typeof exitCode === "number")
            parts.push(`exit code: ${exitCode}`);
        return parts.join("\n\n").trimEnd();
    }
    try {
        return JSON.stringify(result, null, 2);
    }
    catch {
        return String(result);
    }
}
// ── Entry point ─────────────────────────────────────────────────────
const input = new WritableStream({
    write(chunk) {
        return new Promise((resolve) => {
            process.stdout.write(chunk, () => resolve());
        });
    },
});
const output = new ReadableStream({
    start(controller) {
        process.stdin.on("data", (chunk) => {
            controller.enqueue(new Uint8Array(chunk));
        });
        process.stdin.on("end", () => controller.close());
        process.stdin.on("error", (err) => controller.error(err));
    },
});
const stream = ndJsonStream(input, output);
const _connection = new AgentSideConnection((conn) => new PiSdkAgent(conn), stream);
// Keep process alive
process.stdin.resume();
// Shutdown on stdin close
process.stdin.on("end", () => {
    process.exit(0);
});
