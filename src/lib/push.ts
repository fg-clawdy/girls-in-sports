import * as webPush from "web-push";
import { getPrisma } from "./prisma";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@girlsinsports.local";

function configureVapid() {
  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    return true;
  }
  return false;
}

export function isPushConfigured(): boolean {
  return Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
}

export async function sendPushNotification(
  userId: string | null,
  payload: PushPayload
): Promise<{ sent: number; failed: number }> {
  if (!configureVapid()) {
    console.warn("[push] VAPID not configured — skipping notification");
    return { sent: 0, failed: 0 };
  }

  const subscriptions = await getPrisma().pushSubscription.findMany({
    where: userId ? { userId } : {},
  });

  let sent = 0;
  let failed = 0;

  for (const sub of subscriptions) {
    try {
      await webPush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth,
          },
        },
        JSON.stringify(payload)
      );
      sent++;
    } catch (err) {
      console.error("[push] Failed to send notification:", err);
      failed++;

      // Remove invalid subscriptions
      if (err instanceof Error && err.message.includes("expired")) {
        await getPrisma().pushSubscription.delete({ where: { id: sub.id } });
      }
    }
  }

  return { sent, failed };
}

export function getVapidPublicKey(): string | null {
  return VAPID_PUBLIC_KEY || null;
}
