import {
  extractVisibleText,
  getAllCitationsFromLlmOutput,
  groupCitationsByAttachmentId,
  wrapCitationPrompt,
} from "deepcitation";
import { geolocation, ipAddress } from "@vercel/functions";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  stepCountIs,
  streamText,
} from "ai";
import { checkBotId } from "botid/server";
import { after } from "next/server";
import { createResumableStreamContext } from "resumable-stream";
import { auth, type UserType } from "@/app/(auth)/auth";
import { entitlementsByUserType } from "@/lib/ai/entitlements";
import { allowedModelIds } from "@/lib/ai/models";
import { type RequestHints, systemPrompt } from "@/lib/ai/prompts";
import { getLanguageModel } from "@/lib/ai/providers";
import { createDocument } from "@/lib/ai/tools/create-document";
import { getWeather } from "@/lib/ai/tools/get-weather";
import { requestSuggestions } from "@/lib/ai/tools/request-suggestions";
import { updateDocument } from "@/lib/ai/tools/update-document";
import { isProductionEnvironment } from "@/lib/constants";
import {
  createStreamId,
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  saveChat,
  saveMessages,
  updateChatTitleById,
  updateMessage,
} from "@/lib/db/queries";
import type { DBMessage } from "@/lib/db/schema";
import { ChatbotError } from "@/lib/errors";
import { checkIpRateLimit } from "@/lib/ratelimit";
import { getDeepCitationClient } from "@/lib/ai/deepcitation";
import type { ChatMessage } from "@/lib/types";
import { convertToUIMessages, generateUUID } from "@/lib/utils";
import { generateTitleFromUserMessage } from "../../actions";
import { type PostRequestBody, postRequestBodySchema } from "./schema";

export const maxDuration = 60;

function getStreamContext() {
  try {
    return createResumableStreamContext({ waitUntil: after });
  } catch (_) {
    return null;
  }
}

export { getStreamContext };

export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch (_) {
    return new ChatbotError("bad_request:api").toResponse();
  }

  try {
    const {
      id,
      message,
      messages,
      selectedChatModel,
      selectedVisibilityType,
      deepCitation: deepCitationData,
    } = requestBody;

    const [botResult, session] = await Promise.all([checkBotId(), auth()]);

    if (botResult.isBot) {
      return new ChatbotError("unauthorized:chat").toResponse();
    }

    if (!session?.user) {
      return new ChatbotError("unauthorized:chat").toResponse();
    }

    if (!allowedModelIds.has(selectedChatModel)) {
      return new ChatbotError("bad_request:api").toResponse();
    }

    await checkIpRateLimit(ipAddress(request));

    const userType: UserType = session.user.type;

    const messageCount = await getMessageCountByUserId({
      id: session.user.id,
      differenceInHours: 1,
    });

    if (messageCount > entitlementsByUserType[userType].maxMessagesPerHour) {
      return new ChatbotError("rate_limit:chat").toResponse();
    }

    const isToolApprovalFlow = Boolean(messages);

    const chat = await getChatById({ id });
    let messagesFromDb: DBMessage[] = [];
    let titlePromise: Promise<string> | null = null;

    if (chat) {
      if (chat.userId !== session.user.id) {
        return new ChatbotError("forbidden:chat").toResponse();
      }
      if (!isToolApprovalFlow) {
        messagesFromDb = await getMessagesByChatId({ id });
      }
    } else if (message?.role === "user") {
      await saveChat({
        id,
        userId: session.user.id,
        title: "New chat",
        visibility: selectedVisibilityType,
      });
      titlePromise = generateTitleFromUserMessage({ message });
    }

    const uiMessages = isToolApprovalFlow
      ? (messages as ChatMessage[])
      : [...convertToUIMessages(messagesFromDb), message as ChatMessage];

    const { longitude, latitude, city, country } = geolocation(request);

    const requestHints: RequestHints = {
      longitude,
      latitude,
      city,
      country,
    };

    if (message?.role === "user") {
      await saveMessages({
        messages: [
          {
            chatId: id,
            id: message.id,
            role: "user",
            parts: message.parts,
            attachments: [],
            createdAt: new Date(),
          },
        ],
      });
    }

    const isReasoningModel =
      selectedChatModel.endsWith("-thinking") ||
      (selectedChatModel.includes("reasoning") &&
        !selectedChatModel.includes("non-reasoning"));

    const modelMessages = await convertToModelMessages(uiMessages);

    // Wrap prompts with citation instructions if deepCitation data is present
    const baseSystemPrompt = systemPrompt({ selectedChatModel, requestHints });
    let finalSystemPrompt = baseSystemPrompt;

    if (deepCitationData) {
      console.log("[DeepCitation] Wrapping prompts with citation instructions", {
        attachmentIds: deepCitationData.attachmentIds,
        deepTextLength: deepCitationData.deepTextPromptPortion?.length,
      });
      const lastUserMsg = modelMessages
        .filter((m) => m.role === "user")
        .at(-1);

      let userText = "";
      if (lastUserMsg) {
        const content = lastUserMsg.content;
        if (typeof content === "string") {
          userText = content;
        } else if (Array.isArray(content)) {
          userText = content
            .filter((p) => p.type === "text")
            .map((p) => ("text" in p ? p.text : ""))
            .join("");
        }
      }

      const { enhancedSystemPrompt, enhancedUserPrompt } = wrapCitationPrompt({
        systemPrompt: baseSystemPrompt,
        userPrompt: userText,
        deepTextPromptPortion: deepCitationData.deepTextPromptPortion,
      });

      finalSystemPrompt = enhancedSystemPrompt;

      // Replace the last user message text with the enhanced prompt
      if (enhancedUserPrompt && lastUserMsg) {
        const content = lastUserMsg.content;
        if (typeof content === "string") {
          lastUserMsg.content = enhancedUserPrompt;
        } else if (Array.isArray(content)) {
          const textPartIndex = content.findIndex((p) => p.type === "text");
          if (textPartIndex >= 0) {
            (content[textPartIndex] as { type: string; text: string }).text =
              enhancedUserPrompt;
          }
        }
      }
    }

    const stream = createUIMessageStream({
      originalMessages: isToolApprovalFlow ? uiMessages : undefined,
      execute: async ({ writer: dataStream }) => {
        const result = streamText({
          model: getLanguageModel(selectedChatModel),
          system: finalSystemPrompt,
          messages: modelMessages,
          stopWhen: stepCountIs(5),
          experimental_activeTools: isReasoningModel
            ? []
            : [
                "getWeather",
                "createDocument",
                "updateDocument",
                "requestSuggestions",
              ],
          providerOptions: isReasoningModel
            ? {
                anthropic: {
                  thinking: { type: "enabled", budgetTokens: 10_000 },
                },
              }
            : undefined,
          tools: {
            getWeather,
            createDocument: createDocument({ session, dataStream }),
            updateDocument: updateDocument({ session, dataStream }),
            requestSuggestions: requestSuggestions({ session, dataStream }),
          },
          experimental_telemetry: {
            isEnabled: isProductionEnvironment,
            functionId: "stream-text",
          },
        });

        // Merge the LLM stream — this pipes tokens to the client immediately
        dataStream.merge(
          result.toUIMessageStream({ sendReasoning: isReasoningModel })
        );

        if (titlePromise) {
          const title = await titlePromise;
          dataStream.write({ type: "data-chat-title", data: title });
          updateChatTitleById({ chatId: id, title });
        }

        // Citation verification runs after the LLM finishes but before
        // the stream closes, so the verification event reaches the client
        if (deepCitationData) {
          const dc = getDeepCitationClient();
          if (dc) {
            try {
              const fullText = await result.text;
              console.log("[DeepCitation] LLM output length:", fullText.length);

              const citations = getAllCitationsFromLlmOutput(fullText);
              const citationCount = Object.keys(citations).length;
              console.log("[DeepCitation] Parsed citations:", citationCount);

              const visibleText = extractVisibleText(fullText);

              if (citationCount > 0) {
                const citationsByAttachment =
                  groupCitationsByAttachmentId(citations);
                const allVerifications: Record<string, unknown> = {};

                const verifyPromises = Array.from(
                  citationsByAttachment.entries()
                ).map(async ([attachmentId, fileCitations]) => {
                  console.log("[DeepCitation] Verifying attachment:", attachmentId, "citations:", fileCitations.length);
                  const response = await dc.verifyAttachment(
                    attachmentId,
                    fileCitations
                  );
                  Object.assign(allVerifications, response.verifications);
                });

                await Promise.all(verifyPromises);
                console.log("[DeepCitation] Verification complete, keys:", Object.keys(allVerifications).length);

                // Render citations as markdown with verification indicators
                let renderedMarkdown = visibleText;
                try {
                  const { renderCitationsAsMarkdown } = await import("deepcitation");
                  const rendered = renderCitationsAsMarkdown(fullText, {
                    verifications: allVerifications as Record<string, never>,
                    indicatorStyle: "check",
                  });
                  renderedMarkdown = rendered.full;
                  console.log("[DeepCitation] Rendered markdown length:", renderedMarkdown.length);
                } catch (renderError) {
                  console.error("[DeepCitation] renderCitationsAsMarkdown failed:", renderError);
                }

                dataStream.write({
                  type: "data-citation-verification",
                  data: {
                    verifications: allVerifications,
                    visibleText,
                    renderedMarkdown,
                    attachmentIds: deepCitationData.attachmentIds,
                  },
                });
              } else {
                console.log("[DeepCitation] No citations in LLM output, sending visible text only");
                dataStream.write({
                  type: "data-citation-verification",
                  data: {
                    verifications: {},
                    visibleText,
                    renderedMarkdown: visibleText,
                    attachmentIds: deepCitationData.attachmentIds,
                  },
                });
              }

              console.log("[DeepCitation] Wrote citation-verification event to data stream");
            } catch (verifyError) {
              console.error("[DeepCitation] Citation verification failed:", verifyError);
            }
          } else {
            console.warn("[DeepCitation] No API key configured — skipping verification");
          }
        }
      },
      generateId: generateUUID,
      onFinish: async ({ messages: finishedMessages }) => {
        if (isToolApprovalFlow) {
          for (const finishedMsg of finishedMessages) {
            const existingMsg = uiMessages.find((m) => m.id === finishedMsg.id);
            if (existingMsg) {
              await updateMessage({
                id: finishedMsg.id,
                parts: finishedMsg.parts,
              });
            } else {
              await saveMessages({
                messages: [
                  {
                    id: finishedMsg.id,
                    role: finishedMsg.role,
                    parts: finishedMsg.parts,
                    createdAt: new Date(),
                    attachments: [],
                    chatId: id,
                  },
                ],
              });
            }
          }
        } else if (finishedMessages.length > 0) {
          await saveMessages({
            messages: finishedMessages.map((currentMessage) => ({
              id: currentMessage.id,
              role: currentMessage.role,
              parts: currentMessage.parts,
              createdAt: new Date(),
              attachments: [],
              chatId: id,
            })),
          });
        }
      },
      onError: (error) => {
        if (
          error instanceof Error &&
          error.message?.includes(
            "AI Gateway requires a valid credit card on file to service requests"
          )
        ) {
          return "AI Gateway requires a valid credit card on file to service requests. Please visit https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dadd-credit-card to add a card and unlock your free credits.";
        }
        return "Oops, an error occurred!";
      },
    });

    return createUIMessageStreamResponse({
      stream,
      async consumeSseStream({ stream: sseStream }) {
        if (!process.env.REDIS_URL) {
          return;
        }
        try {
          const streamContext = getStreamContext();
          if (streamContext) {
            const streamId = generateId();
            await createStreamId({ streamId, chatId: id });
            await streamContext.createNewResumableStream(
              streamId,
              () => sseStream
            );
          }
        } catch (_) {
          // ignore redis errors
        }
      },
    });
  } catch (error) {
    const vercelId = request.headers.get("x-vercel-id");

    if (error instanceof ChatbotError) {
      return error.toResponse();
    }

    if (
      error instanceof Error &&
      error.message?.includes(
        "AI Gateway requires a valid credit card on file to service requests"
      )
    ) {
      return new ChatbotError("bad_request:activate_gateway").toResponse();
    }

    console.error("Unhandled error in chat API:", error, { vercelId });
    return new ChatbotError("offline:chat").toResponse();
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return new ChatbotError("bad_request:api").toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const chat = await getChatById({ id });

  if (chat?.userId !== session.user.id) {
    return new ChatbotError("forbidden:chat").toResponse();
  }

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}
