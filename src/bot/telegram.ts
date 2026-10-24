export type Button = { text: string; callback_data: string };
export interface Update {
  update_id: number;
  message?: { text?: string; chat: { id: number; type: string } };
  callback_query?: { id: string; data?: string; message?: { chat: { id: number; type: string } } };
}
export class Telegram {
  token: string;
  constructor(token: string) { this.token = token; }
  async call<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    // Never log request URLs/errors containing the bot token.
    let response: Response;
    try {
      response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(40_000),
      });
    } catch { throw new Error(`Telegram ${method}: ошибка сети`); }
    const data = await response.json() as { ok: boolean; result: T; error_code?: number; parameters?: { retry_after?: number } };
    if (!data.ok) {
      if (data.parameters?.retry_after) await new Promise((resolve) => setTimeout(resolve, Math.min(data.parameters!.retry_after!, 60) * 1000));
      throw new Error(`Telegram ${method}: код ${data.error_code ?? response.status}`);
    }
    return data.result;
  }
  send(chat: number, text: string, buttons: Button[][] = []) {
    return this.call('sendMessage', { chat_id: chat, text, reply_markup: { inline_keyboard: buttons } });
  }
}
