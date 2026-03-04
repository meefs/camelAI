import { useState, type FormEvent, useEffect } from "react";
import { useLoaderData, redirect } from "react-router";
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
 * Session isolation:
 * - Each unique `name` in useAgent creates a separate Durable Object instance
 * - WITHOUT a unique name, ALL users share the same DO ("default") and see
 *   each other's conversations — this is the #1 deployment bug
 * - The session ID lives in the URL (/chat?session=<id>) so users can have
 *   multiple conversations and share/bookmark them
 * - Visiting /chat with no ?session redirects to a fresh session automatically
 *
 * API notes (AI SDK v3):
 * - useAgentChat does NOT return input/setInput/handleSubmit — manage your
 *   own input state with useState and use sendMessage() to send
 * - sendMessage accepts { text } shorthand or { role, parts } for rich content
 */

/**
 * Loader generates a session ID if none is in the URL.
 * The ID is in the query string so multiple conversations are just
 * different URLs — easy to extend with a sidebar/history list later.
 */
export function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session");

  // No session in URL → redirect to a fresh one
  if (!sessionId) {
    url.searchParams.set("session", crypto.randomUUID());
    throw redirect(url.pathname + url.search);
  }

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

  // IMPORTANT: Always pass a unique `name` to useAgent.
  // Without it, every user shares the same Durable Object instance ("default")
  // and sees each other's conversations.
  const agent = useAgent({
    agent: "Chat",
    name: sessionId,
  });

  // Note: useAgentChat does NOT return input/setInput/handleSubmit (removed
  // in AI SDK v3). Manage your own input state with useState.
  const { messages, sendMessage, status, error, clearHistory } = useAgentChat({
    agent,
  });

  const isLoading = status === "streaming" || status === "submitted";
  const isStreaming = status === "streaming";

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const text = input;
    setInput("");

    // Using the parts format makes it easy to extend with images, files, etc.
    // For text-only, you can also use the shorthand: sendMessage({ text })
    await sendMessage({
      role: "user",
      parts: [{ type: "text", text }],
    });
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
                {isAssistant ? (
                  <>
                    {/* Render all message parts — text and tool results */}
                    {message.parts?.map((part: any, i: number) => {
                      // Text parts — always use MarkdownRenderer for AI output
                      if (part.type === "text" && part.text) {
                        return (
                          <MarkdownRenderer
                            key={i}
                            content={part.text}
                            isStreaming={isStreaming && isLastMessage}
                          />
                        );
                      }
                      return null;
                    })}
                    {/* Show loading dots on the last assistant message while streaming */}
                    {isLoading && isLastMessage && (
                      <div className="flex space-x-1 py-1">
                        <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" />
                        <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:0.1s]" />
                        <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:0.2s]" />
                      </div>
                    )}
                  </>
                ) : (
                  <p className="whitespace-pre-wrap">
                    {message.parts
                      ?.filter(
                        (p: any): p is { type: "text"; text: string } =>
                          p.type === "text"
                      )
                      .map((p: any) => p.text)
                      .join("")}
                  </p>
                )}
              </div>
            </div>
          );
        })}

        {/* Show loading bubble when waiting and no assistant message exists yet */}
        {isLoading &&
          messages[messages.length - 1]?.role !== "assistant" && (
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
