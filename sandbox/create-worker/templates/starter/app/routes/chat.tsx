import { useState, type FormEvent, useEffect } from "react";
import { useLoaderData } from "react-router";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { UIMessage } from "@ai-sdk/react";
import { MarkdownRenderer } from "~/components/markdown-renderer";
import type { Route } from "./+types/chat";

/**
 * Chat route using Cloudflare Agents SDK.
 *
 * IMPORTANT: Always use MarkdownRenderer for AI responses!
 * AI models return markdown (code blocks, lists, tables) that must be
 * rendered properly. Never use plain <p> tags for assistant messages.
 *
 * Key features:
 * - Real-time streaming responses via WebSocket
 * - Automatic conversation history persistence (SQLite in Durable Object)
 * - Resumable streaming (reconnects continue where they left off)
 * - Full conversation context passed to AI on every message
 *
 * How conversation continuity works:
 * - The Chat Durable Object stores all messages in SQLite via `this.messages`
 * - On each new message, ALL previous messages are passed to the AI model
 * - This happens automatically via `convertToModelMessages(this.messages)` in chat.ts
 * - The SDK handles persistence, so conversations survive page refreshes
 *
 * Session management:
 * - Each unique `name` in useAgent creates a separate chat instance
 * - Generate session IDs server-side in loaders (not in components!)
 * - Client-side ID generation causes re-render issues
 */

/**
 * Loader runs on the server - generate session ID here.
 * IMPORTANT: useAgent uses `name` (not `id`) to identify chat instances.
 */
export async function loader({ request }: Route.LoaderArgs) {
  // Generate a unique session ID for this chat
  // In a real app, you might use user ID, conversation ID from URL params, etc.
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session") || crypto.randomUUID();

  return { sessionId };
}

export default function ChatPage() {
  const { sessionId } = useLoaderData<typeof loader>();
  const [mounted, setMounted] = useState(false);

  // Only render the chat client-side (WebSocket needs browser)
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <div className="flex flex-col h-screen bg-gray-50">
        <header className="bg-white border-b border-gray-200 px-4 py-3">
          <h1 className="text-xl font-semibold text-gray-900">AI Chat</h1>
        </header>
        <main className="flex-1 flex items-center justify-center">
          <p className="text-gray-500">Loading chat...</p>
        </main>
      </div>
    );
  }

  return <ChatClient sessionId={sessionId} />;
}

function ChatClient({ sessionId }: { sessionId: string }) {
  const [input, setInput] = useState("");

  // IMPORTANT: useAgent uses `name` (not `id`) to identify the chat instance
  // Each unique name creates a separate conversation with its own history
  const agent = useAgent({
    agent: "Chat",
    name: sessionId,
  });

  const { messages, sendMessage, status, error, clearHistory } = useAgentChat({
    agent,
  });

  const isLoading = status === "streaming" || status === "submitted";
  const isStreaming = status === "streaming";

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const message = input;
    setInput("");

    // Send message to the Chat Durable Object
    // The DO automatically persists this message and includes all
    // previous messages when calling the AI model
    await sendMessage({
      role: "user",
      parts: [{ type: "text", text: message }],
    });
  };

  // Extract text content from message parts
  const getMessageText = (message: UIMessage): string => {
    if (!message.parts) return "";
    return message.parts
      .filter(
        (part): part is { type: "text"; text: string } => part.type === "text"
      )
      .map((part) => part.text)
      .join("");
  };

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-4 py-3 flex justify-between items-center">
        <h1 className="text-xl font-semibold text-gray-900">AI Chat</h1>
        <button
          onClick={clearHistory}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          Clear
        </button>
      </header>

      {/* Messages */}
      <main className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-center text-gray-500 mt-8">
            <p className="text-lg">Start a conversation</p>
            <p className="text-sm mt-2">
              Type a message below to chat with the AI
            </p>
          </div>
        )}

        {messages.map((message: UIMessage, index: number) => {
          const text = getMessageText(message);
          const isLastMessage = index === messages.length - 1;
          const isAssistant = message.role === "assistant";

          return (
            <div
              key={message.id}
              className={`flex ${isAssistant ? "justify-start" : "justify-end"}`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-4 py-2 ${
                  isAssistant
                    ? "bg-white border border-gray-200 text-gray-900"
                    : "bg-blue-600 text-white"
                }`}
              >
                {/* IMPORTANT: Always use MarkdownRenderer for AI responses */}
                {/* AI output contains markdown (code, lists, tables) that needs proper rendering */}
                {isAssistant ? (
                  <MarkdownRenderer
                    content={text}
                    isStreaming={isStreaming && isLastMessage}
                  />
                ) : (
                  <p className="whitespace-pre-wrap">{text}</p>
                )}
              </div>
            </div>
          );
        })}

        {isLoading && messages[messages.length - 1]?.role !== "assistant" && (
          <div className="flex justify-start">
            <div className="bg-white border border-gray-200 rounded-lg px-4 py-2">
              <div className="flex space-x-1">
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" />
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:0.1s]" />
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:0.2s]" />
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2 text-red-700">
            Error: {error.message}
          </div>
        )}
      </main>

      {/* Input */}
      <footer className="bg-white border-t border-gray-200 p-4">
        <form onSubmit={onSubmit} className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message..."
            className="flex-1 rounded-lg border border-gray-300 px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Send
          </button>
        </form>
      </footer>
    </div>
  );
}
