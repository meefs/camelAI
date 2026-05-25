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
    files?: Array<{
      id?: string;
      name?: string;
      title?: string;
      mimetype?: string;
      filetype?: string;
      url_private_download?: string;
      url_private?: string;
      size?: number;
    }>;
  };
}

export interface SlackEventQueueMessage {
  payload: SlackEventCallbackPayload;
  received_at: number;
}
