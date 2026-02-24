export interface SlackEventCallbackPayload {
  type?: string;
  challenge?: string;
  team_id?: string;
  event_id?: string;
  authorizations?: Array<{ user_id?: string }>;
  event?: {
    type?: string;
    subtype?: string;
    channel?: string;
    channel_type?: string;
    text?: string;
    user?: string;
    bot_id?: string;
    ts?: string;
    thread_ts?: string;
  };
}

export interface SlackEventQueueMessage {
  payload: SlackEventCallbackPayload;
  received_at: number;
}
