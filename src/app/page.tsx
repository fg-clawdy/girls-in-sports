import { redirect } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";

export default async function HomePage() {
  const authed = await isAuthenticated();
  if (authed) {
    redirect("/dashboard");
  }
  redirect("/login");
}
