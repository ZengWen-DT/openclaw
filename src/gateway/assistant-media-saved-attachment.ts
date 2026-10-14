import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { getRuntimeConfig } from "../config/io.js";
import { isInternalSessionEffectsKey } from "../config/sessions/internal-session-key.js";
import { collectSessionEntryLookupKeys } from "../config/sessions/store-entry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { FsSafeError } from "../infra/fs-safe.js";
import {
  readSqliteDatabaseScopedWriteTokenForPath,
  sqliteSessionIdWriteScope,
} from "../infra/sqlite-database-admission.js";
import { parseInboundMediaUri } from "../media/inbound-media-uri.js";
import { readPersistedMediaFacts } from "../media/media-facts.js";
import { projectChatDisplayMessage } from "./chat-display-projection.js";
import { MAX_PAYLOAD_BYTES } from "./payload-limits.js";
import {
  isSameSessionSharingTarget,
  prepareSessionSharingRead,
} from "./session-sharing-target-read.js";
import { readSessionMessageByIdAsync } from "./session-transcript-readers.js";

/** A saved upload grants only its own bytes, under the current parent message's authority. */
export async function prepareSavedAssistantAttachmentRead(params: {
  config: OpenClawConfig;
  session: { sessionKey: string; agentId: string; sessionId: string };
  messageId: string;
  inboundId: string;
}) {
  // chat.message.get dispatches these IDs only to the pending-input owner.
  // A colliding transcript row must not grant saved-message authority.
  if (params.messageId.startsWith(CHAT_PENDING_INPUT_MESSAGE_PREFIX)) {
    return undefined;
  }
  const { session } = params;
  const custody = await prepareSessionSharingRead({
    cfg: params.config,
    sessionKey: session.sessionKey,
    agentId: session.agentId,
  });
  try {
    const initial = custody.readCurrent(getRuntimeConfig());
    const target = initial.target;
    if (
      !target ||
      isInternalSessionEffectsKey(target.canonicalKey) ||
      target.entry.sessionId !== session.sessionId ||
      !initial.sourcePath
    ) {
      custody.release();
      return undefined;
    }
    const sourcePath = initial.sourcePath;
    const scopes = [
      ...collectSessionEntryLookupKeys(target.canonicalKey),
      sqliteSessionIdWriteScope(session.sessionId),
    ];
    const readToken = () => readSqliteDatabaseScopedWriteTokenForPath(sourcePath, scopes);
    const assertSessionCurrent = () => {
      const current = custody.readCurrent(getRuntimeConfig()).target;
      if (
        !isSameSessionSharingTarget(current, target) ||
        current?.entry.sessionStartedAt !== target.entry.sessionStartedAt
      ) {
        throw new FsSafeError("path-mismatch", "Saved attachment access changed");
      }
    };
    let token: ReturnType<typeof readToken>;
    const assertCurrent = () => {
      assertSessionCurrent();
      if (!token || readToken() !== token) {
        throw new FsSafeError("path-mismatch", "Saved attachment access changed");
      }
    };
    const readMessage = async () => {
      assertSessionCurrent();
      token = readToken();
      assertCurrent();
      return await readSessionMessageByIdAsync(
        {
          agentId: initial.sourceAgentId ?? target.agentId,
          sessionKey: target.canonicalKey,
          sessionId: session.sessionId,
          storePath: sourcePath,
        },
        params.messageId,
        {
          currentOnly: true,
          maxBytes: MAX_PAYLOAD_BYTES,
          allowResetArchiveFallback: false,
          historyVisibility: { sessionStartedAt: target.entry.sessionStartedAt },
        },
      );
    };
    let selected = await readMessage();
    // A cold read can materialize an unchanged transcript projection. Discard its
    // selection and re-read once under fresh write authority, retaining the same
    // physical session custody. A second change fails closed.
    if (readToken() !== token) {
      selected = await readMessage();
    }
    assertCurrent();
    const message =
      selected.found && !selected.oversized
        ? projectChatDisplayMessage(selected.message, {
            includeCommentaryFallbacks: true,
            maxChars: MAX_PAYLOAD_BYTES,
          })
        : undefined;
    const associated =
      message &&
      readPersistedMediaFacts(message)?.some((fact) => {
        try {
          return (
            typeof fact.url === "string" && parseInboundMediaUri(fact.url)?.id === params.inboundId
          );
        } catch {
          return false;
        }
      });
    if (!associated) {
      custody.release();
      return undefined;
    }
    return { assertCurrent, release: custody.release };
  } catch (error) {
    custody.release();
    throw error;
  }
}
