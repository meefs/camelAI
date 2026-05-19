import { useCallback, useState, type RefObject } from "react";
import type {
  ConnectionSetupPromptData,
  ConnectionSetupResponse,
} from "@/components/connection-setup-prompt";

export function useConnectionSetupResponse({
  connectionSetupResponseSocketRef,
  oobWsRef,
  wsRef,
}: {
  connectionSetupResponseSocketRef: RefObject<"runner" | "oob">;
  oobWsRef: RefObject<WebSocket | null>;
  wsRef: RefObject<WebSocket | null>;
}) {
  const [connectionSetupPrompt, setConnectionSetupPrompt] =
    useState<ConnectionSetupPromptData | null>(null);

  const handleConnectionSetupResponse = useCallback(
    async (response: ConnectionSetupResponse) => {
      const source = connectionSetupResponseSocketRef.current;
      const socket = source === "oob" ? oobWsRef.current : wsRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        console.error(
          "[Chat] WebSocket not available for connection setup response",
          { source },
        );
        throw new Error(
          source === "oob"
            ? "The chat side-channel disconnected before the connection details could be submitted. Please try again."
            : "The chat runner connection disconnected before the connection details could be submitted. Please try again.",
        );
      }

      socket.send(
        JSON.stringify({
          type: "connection_setup_response",
          ...response,
        }),
      );
    },
    [connectionSetupResponseSocketRef, oobWsRef, wsRef],
  );

  const handleConnectionSetupCancel = useCallback(() => {
    setConnectionSetupPrompt(null);
  }, []);

  return {
    connectionSetupPrompt,
    handleConnectionSetupCancel,
    handleConnectionSetupResponse,
    setConnectionSetupPrompt,
  };
}
