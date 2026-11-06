// In-panel direct chat ("直聊测试") — the zero-download smoke test.
//
// The user can type a message (and optionally an image URL / data URI) straight
// into the DSH panel. We build a real OneBot v11 private-message event and run
// it through the EXACT SAME BotLogic.handle() pipeline that a genuine QQ
// message would use. That means text, images, model calls, long-term memory,
// conversation history, slash commands and reply splitting are all exercised
// without installing NapCat / Lagrange / anything else.
//
// Replies are collected in memory and rendered as a transcript in the panel.

const PANEL_USER_ID = 10001;
const MAX_MESSAGES = 200;

let seq = 0;

export class ChatSimulator {
  /**
   * @param {import('./bot.js').BotLogic} logic
   * @param {(msg: string) => void} log
   * @param {{ memory?: object }} options
   */
  constructor(logic, log = () => {}, options = {}) {
    this.logic = logic;
    this.log = log;
    this.memory = options.memory || (logic && logic.memory) || null;
    this.messages = [];
  }

  /** Conversation key used by the memory layer for the panel chat. */
  get key() {
    return `private:${PANEL_USER_ID}`;
  }

  history() {
    return this.messages.slice();
  }

  clear() {
    this.messages.length = 0;
    // Start a fresh short-term conversation window, but keep long-term facts.
    try {
      if (this.memory && typeof this.memory.clearHistory === 'function') {
        this.memory.clearHistory(this.key);
      }
    } catch {
      /* ignore */
    }
    this.log('直聊测试：对话已清空');
    return { ok: true };
  }

  _push(role, text, images = 0) {
    seq += 1;
    const item = {
      id: `c${Date.now().toString(36)}-${seq}`,
      role,
      text: String(text ?? ''),
      at: Date.now(),
      images,
    };
    this.messages.push(item);
    while (this.messages.length > MAX_MESSAGES) this.messages.shift();
    return item;
  }

  /**
   * Accept a panel message and return the bot's replies.
   * @param {string} text
   * @param {string} [image] - http(s) URL, data:image URI, or base64:// payload
   * @returns {Promise<{ ok: boolean, replies: string[], history: Array, error?: string }>}
   */
  async send(text, image = '') {
    const cleanText = String(text ?? '').trim();
    const cleanImage = String(image ?? '').trim();
    if (!cleanText && !cleanImage) {
      return { ok: false, replies: [], history: this.history(), error: '请输入消息内容或图片地址' };
    }

    const segments = [];
    if (cleanText) segments.push({ type: 'text', data: { text: cleanText } });
    if (cleanImage) segments.push({ type: 'image', data: { url: cleanImage } });

    const messageId = 900000000 + (++seq);
    const event = {
      time: Math.floor(Date.now() / 1000),
      self_id: 999001,
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: messageId,
      user_id: PANEL_USER_ID,
      message: segments,
      raw_message: cleanText || '[图片]',
      font: 0,
      sender: {
        user_id: PANEL_USER_ID,
        nickname: '面板测试',
        sex: 'unknown',
        age: 0,
      },
    };

    this._push('user', cleanText || '[图片]', cleanImage ? 1 : 0);

    const replies = [];
    const replyFn = async (message) => {
      replies.push(String(message));
    };

    let result;
    try {
      result = await this.logic.handle(event, replyFn, { hint: '（这条消息来自 DSH 面板的直聊测试，不是真实 QQ，但请正常作答。）' });
    } catch (err) {
      // handle() is designed not to throw, but never let the panel hang.
      this.log(`直聊测试异常: ${err.message}`);
      replies.push(`抱歉，处理失败：${err.message}`);
      result = { ok: false, error: err.message };
    }

    if (replies.length === 0) {
      // Ignored event, dedup, or a command that produced no output.
      replies.push(result && result.error ? `处理失败：${result.error}` : '（这条消息被机器人的触发规则忽略了，可在「配置」里检查触发设置。）');
    }

    for (const reply of replies) this._push('bot', reply, 0);
    return {
      ok: Boolean(result && result.ok !== false),
      replies,
      history: this.history(),
      error: result && result.ok === false ? result.error : undefined,
    };
  }
}
