import { createChatHandler } from "@/lib/assistant/chat-handler";

export const runtime = "nodejs";
export const maxDuration = 60;

export const POST = createChatHandler();
