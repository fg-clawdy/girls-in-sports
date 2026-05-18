import { NextResponse } from "next/server";
import { sendChatMessage, isChatConfigured } from "@/lib/chat";
import type { ChatMessage, ChatContext } from "@/lib/chat";

export async function POST(request: Request) {
  try {
    const { message, history, context }: {
      message: string;
      history: ChatMessage[];
      context: ChatContext;
    } = await request.json();

    if (!message) {
      return NextResponse.json(
        { error: "message is required" },
        { status: 400 }
      );
    }

    const result = await sendChatMessage(message, history || [], context);

    return NextResponse.json({
      success: true,
      response: result.response,
      modelUsed: result.modelUsed,
    });
  } catch (error) {
    console.error("Chat error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Chat failed" },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({ configured: isChatConfigured() });
}
