import { useCallback, useState, type RefObject } from "react";
import type {
  ConnectionSetupPromptData,
  ConnectionSetupResponse,
} from "@/components/connection-setup-prompt";

type ChatSocketLike = {
  readyState: number;
  send(data: string): void;
};

export function useConnectionSetupResponse({
  wsRef,
}: {
  wsRef: RefObject<ChatSocketLike | null>;
}) {
  const [connectionSetupPrompt, setConnectionSetupPrompt] =
    useState<ConnectionSetupPromptData | null>(null);

  const handleConnectionSetupResponse = useCallback(
    async (response: ConnectionSetupResponse) => {
      const socket = wsRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
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
