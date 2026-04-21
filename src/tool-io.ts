export type ToolResponsePayload = { cancelled?: boolean; [k: string]: any };

const pendingToolResponses = new Map<string, (payload: ToolResponsePayload) => void>();

export function waitForToolResponse(toolCallId: string): Promise<ToolResponsePayload> {
  return new Promise((resolve) => {
    pendingToolResponses.set(toolCallId, resolve);
  });
}

export function resolveToolResponse(toolCallId: string, payload: ToolResponsePayload) {
  const resolve = pendingToolResponses.get(toolCallId);
  if (!resolve) return false;
  pendingToolResponses.delete(toolCallId);
  resolve(payload);
  return true;
}

