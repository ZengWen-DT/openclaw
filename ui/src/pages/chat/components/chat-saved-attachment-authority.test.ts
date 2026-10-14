/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { buildAssistantMediaUrl } from "../../../app/assistant-media.ts";
import { resolveAssistantAttachmentAvailability } from "./chat-message-attachment-availability.ts";
import { prepareGroupedMessage } from "./chat-message-bubble-presentation.ts";
import { prepareChatMessageRender } from "./chat-message-markdown-view.tsx";
import { releaseChatMediaResourceSubscriber } from "./chat-message-media.ts";

const subscribers = new Set<() => void>();
afterEach(() => {
  for (const subscriber of subscribers) {
    releaseChatMediaResourceSubscriber(subscriber);
  }
  subscribers.clear();
  vi.unstubAllGlobals();
});

it("carries the persisted row identity for saved text attachments without images", () => {
  const message = {
    role: "user",
    content: "Review this selection",
    __openclaw: {
      id: "saved-row",
      seq: 12,
      media: [
        {
          url: "media://inbound/selection.txt",
          contentType: "text/plain",
          fileName: "selection.txt",
        },
      ],
    },
  };
  const prepared = prepareGroupedMessage(prepareChatMessageRender(message), "render-key", {
    isStreaming: false,
    showReasoning: false,
    sessionKey: "agent:main:dashboard:attachment",
    agentId: "main",
  });
  expect(prepared.images).toHaveLength(0);
  expect(prepared.imageRenderOptions.messageId).toBe("saved-row");
  const url = new URL(
    buildAssistantMediaUrl(
      "media://inbound/selection.txt",
      "",
      "ticket",
      prepared.imageRenderOptions,
    ),
    "https://control.example",
  );
  expect(url.searchParams.get("messageId")).toBe("saved-row");
  expect(url.searchParams.get("mediaTicket")).toBe("ticket");
});

it.each([
  { id: "external-row", importedFrom: "legacy" },
  { sendId: "pending-send", seq: 99 },
])("never invents saved row authority from imported or pending identity: %j", (__openclaw) => {
  const message = { role: "user", content: "Pending or imported text", __openclaw };
  const prepared = prepareGroupedMessage(prepareChatMessageRender(message), "render-key", {
    isStreaming: false,
    showReasoning: false,
  });
  expect(prepared.imageRenderOptions.messageId).toBeUndefined();
});

it("keeps metadata and tickets separate for the same file on different saved messages", async () => {
  const source = `media://inbound/${crypto.randomUUID()}.txt`;
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input), "https://control.example");
    return Response.json({
      available: true,
      mediaTicket: `ticket-${url.searchParams.get("messageId")}`,
      mediaTicketExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const options = ["first-row", "second-row"].map((messageId) => {
    const onRequestUpdate = () => {};
    subscribers.add(onRequestUpdate);
    return { sessionKey: "cache-session", agentId: "main", messageId, onRequestUpdate };
  });
  for (const option of options) {
    expect(resolveAssistantAttachmentAvailability(source, option).status).toBe("checking");
  }
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  for (const option of options) {
    await vi.waitFor(() =>
      expect(resolveAssistantAttachmentAvailability(source, option)).toMatchObject({
        status: "available",
        mediaTicket: `ticket-${option.messageId}`,
      }),
    );
  }
});
