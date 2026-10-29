// 对客聊天分段流式（SSE）客户端。
// 与服务端 server/chat-stream.mjs 对应：start -> segment* -> final。
// 只负责解析和去重，不碰 React 状态，便于单独测试。
export const CHAT_STREAM_PROTOCOL = "chat-stream-v1";

const decoder = new TextDecoder();

export const isEventStreamResponse = (response) => String(response?.headers?.get?.("content-type") || "")
  .toLowerCase()
  .includes("text/event-stream");

// 解析单个 SSE 帧：支持多行 data、注释行和冒号后的可选空格。
export const parseStreamFrame = (raw) => {
  let event = "message";
  const data = [];
  for (const line of String(raw || "").split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (!data.length) return null;
  try {
    return { event, data:JSON.parse(data.join("\n")) };
  } catch {
    return null;
  }
};

// 读取流并回调 start/segment/final。
// 返回值 complete=false 表示服务端没有下发 final：调用方必须按“回复不完整”处理，
// 不能把已收到的片段当成完整回答提交。
export const consumeChatStream = async (stream, { onStart, onSegment, onFinal } = {}) => {
  if (!stream?.getReader) {
    const failure = new Error("流式响应不可用，请重试。");
    failure.code = "STREAM_UNAVAILABLE";
    throw failure;
  }
  const reader = stream.getReader();
  const segments = [];
  const seen = new Set();
  let buffer = "";
  let started = false;
  let final = null;

  const handleFrame = (raw) => {
    const frame = parseStreamFrame(raw);
    if (!frame) return;
    if (frame.event === "start") {
      started = true;
      onStart?.(frame.data || {});
      return;
    }
    if (frame.event === "segment") {
      const index = Number(frame.data?.index);
      if (!Number.isInteger(index) || seen.has(index)) return;
      seen.add(index);
      const content = String(frame.data?.content || "");
      segments.push({ index, content });
      onSegment?.({ index, content, final:Boolean(frame.data?.final) });
      return;
    }
    if (frame.event === "final") {
      final = frame.data || {};
      onFinal?.(final);
      return;
    }
    if (frame.event === "error") {
      const failure = new Error(String(frame.data?.message || "咨询服务暂时不可用"));
      failure.code = String(frame.data?.code || "STREAM_ERROR");
      throw failure;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = `${buffer}${typeof value === "string" ? value : decoder.decode(value, { stream:true })}`.replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        handleFrame(raw);
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer = `${buffer}${decoder.decode()}`.replace(/\r\n/g, "\n");
    if (buffer.trim()) handleFrame(buffer);
  } finally {
    try { reader.releaseLock?.(); } catch { /* 已中断的流无需再释放 */ }
  }
  return { started, complete:Boolean(final), envelope:final, segments };
};
