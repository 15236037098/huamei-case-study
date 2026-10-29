// 对客聊天的分段流式协议（SSE）。
// 说明：当前回答由确定性草稿或受控模型一次性生成，这里按 reply_segments 逐段下发，
// 属于“分段流式”，不是 token 级流式；最终事件携带与普通 JSON 接口一致的完整回执，
// 保证流式结果与后台归档同源。
export const CHAT_STREAM_VERSION = "1.0.0";

export const chatStreamSegments = (envelope = {}) => {
  const segments = Array.isArray(envelope.reply_segments)
    ? envelope.reply_segments.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  if (segments.length) return segments;
  const fallback = String(envelope.reply || "").trim();
  return fallback ? [fallback] : [];
};

export const chatStreamEvents = (envelope = {}, { requestId = "", messageId = "" } = {}) => {
  const segments = chatStreamSegments(envelope);
  const events = [{
    event:"start",
    data:{
      protocol:"chat-stream-v1",
      version:CHAT_STREAM_VERSION,
      request_id:requestId,
      message_id:messageId,
      status:envelope.status || "completed",
      segment_count:segments.length
    }
  }];
  for (const [index, content] of segments.entries()) {
    events.push({
      event:"segment",
      data:{ index, content, final:index === segments.length - 1 }
    });
  }
  events.push({
    event:"final",
    data:{ ...envelope, reply_segments:segments, stream:{ protocol:"chat-stream-v1", version:CHAT_STREAM_VERSION, segment_count:segments.length } }
  });
  return events;
};

export const writeChatStream = async (response, events, headers = {}) => {
  // 客户端可能在首段前就断开；此时继续写会抛出 ERR_STREAM_DESTROYED。
  if (response.destroyed || response.writableEnded) return false;
  response.writeHead(200, {
    "Content-Type":"text/event-stream; charset=utf-8",
    "Cache-Control":"no-cache, no-transform",
    "Connection":"keep-alive",
    "X-Accel-Buffering":"no",
    ...headers
  });
  if (typeof response.on === "function") response.on("error", () => {});
  try {
    for (const item of events) {
      if (response.destroyed || response.writableEnded) break;
      const writable = response.write(`event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`);
      if (writable === false && typeof response.once === "function") {
        await new Promise((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            response.off?.("drain", finish);
            response.off?.("close", finish);
            response.off?.("error", finish);
            resolve();
          };
          const timer = setTimeout(finish, 5_000);
          response.once("drain", finish);
          response.once("close", finish);
          response.once("error", finish);
        });
      }
    }
    if (!response.destroyed && !response.writableEnded) response.end();
    return true;
  } catch (error) {
    if (!response.destroyed) response.destroy(error);
    return false;
  }
};
