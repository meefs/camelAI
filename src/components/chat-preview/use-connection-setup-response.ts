import { useCallback, useState, type RefObject } from "react";
import type {
  ConnectionSetupPromptData,
  ConnectionSetupResponse,
} from "@/components/connection-setup-prompt";

export function useConnectionSetupResponse({
  wsRef,
}: {
  wsRef: RefObject<WebSocket | null>;
}) {
  const [connectionSetupPrompt, setConnectionSetupPrompt] =
    useState<ConnectionSetupPromptData | null>(null);

  const handleConnectionSetupResponse = useCallback(
    async (response: ConnectionSetupResponse) => {
      const socket = wsRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        console.error(
          "[Chat] WebSocket not available for connection setup response",
        );
        throw new Error(
          "The chat connection disconnected before the connection details could be submitted. Please try again.",
        );
      }

      socket.send(
        JSON.stringify({
          type: "connection_setup_response",
          ...response,
        }),
      );
    },
    [wsRef],
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
