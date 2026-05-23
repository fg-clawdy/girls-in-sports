"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    console.log("[Login] Submitting...");

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
        credentials: "include",
      });

      console.log("[Login] Response status:", res.status);
      const data = await res.json();
      console.log("[Login] Response data:", data);

      if (!res.ok) {
        setError(data.error || "Invalid credentials");
        return;
      }

      console.log("[Login] Success — navigating to /dashboard");
      router.push("/dashboard");
      router.refresh();
    } catch (err: any) {
      console.error("[Login] Fetch error:", err);
      setError(err?.message || "Login failed");
    } finally {
      setLoading(false);
    }
  }

  // --- US-001: Administrator login (separate from normal user flow) ---
  const [adminToken, setAdminToken] = useState("");
  const [adminError, setAdminError] = useState("");
  const [adminLoading, setAdminLoading] = useState(false);

  async function handleAdminLogin(e: React.FormEvent) {
    e.preventDefault();
    setAdminError("");
    setAdminLoading(true);
    console.log("[AdminLogin] Submitting...");

    try {
      const res = await fetch("/api/auth/admin-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminToken }),
        credentials: "include",
      });

      console.log("[AdminLogin] Response status:", res.status);
      const data = await res.json();
      console.log("[AdminLogin] Response data:", data);

      if (!res.ok) {
        setAdminError(data.error || "Invalid admin token");
        return;
      }

      console.log("[AdminLogin] Success — navigating to /dashboard");
      router.push("/dashboard");
      router.refresh();
    } catch (err: any) {
      console.error("[AdminLogin] Fetch error:", err);
      setAdminError(err?.message || "Admin login failed");
    } finally {
      setAdminLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50">
      <div className="max-w-sm w-full space-y-6 p-8 bg-white rounded-xl shadow-lg">
        <div>
          <h1 className="text-2xl font-bold text-center text-zinc-900">
            Girls In Sports
          </h1>
          <p className="text-sm text-center text-zinc-500 mt-1">
            Media Catalog &amp; Marketing Composer
          </p>
        </div>

        {/* Normal user / staff login - UNCHANGED per US-001 AC */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="text-xs uppercase tracking-widest text-zinc-400 text-center">Staff Login</div>
          <div>
            <label
              htmlFor="username"
              className="block text-sm font-medium text-zinc-700"
            >
              Username
            </label>
            <input
              id="username"
              type="text"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="mt-1 block w-full px-3 py-2 border border-zinc-300 rounded-md shadow-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:border-[var(--accent)]"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium text-zinc-700"
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 block w-full px-3 py-2 border border-zinc-300 rounded-md shadow-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:border-[var(--accent)]"
            />
          </div>

          {error && (
            <div className="text-red-600 text-sm text-center">{error}</div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[var(--accent)] disabled:opacity-50"
          >
            {loading ? "Logging in..." : "Log In"}
          </button>
        </form>

        {/* Divider */}
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-zinc-200" />
          <span className="text-[10px] text-zinc-400">OR</span>
          <div className="h-px flex-1 bg-zinc-200" />
        </div>

        {/* Administrator login - NEW for US-001 (token only, does not affect normal login) */}
        <form onSubmit={handleAdminLogin} className="space-y-4">
          <div className="text-xs uppercase tracking-widest text-zinc-400 text-center">Administrator Login</div>
          <div>
            <label
              htmlFor="adminToken"
              className="block text-sm font-medium text-zinc-700"
            >
              Admin Token
            </label>
            <input
              id="adminToken"
              type="password"
              required
              placeholder="paste ADMIN_TOKEN from .env"
              value={adminToken}
              onChange={(e) => setAdminToken(e.target.value)}
              className="mt-1 block w-full px-3 py-2 border border-zinc-300 rounded-md shadow-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-red-600 focus:border-red-600 font-mono text-sm"
            />
            <p className="text-[10px] text-zinc-400 mt-1">Uses the strong ADMIN_TOKEN (not your staff password).</p>
          </div>

          {adminError && (
            <div className="text-red-600 text-sm text-center">{adminError}</div>
          )}

          <button
            type="submit"
            disabled={adminLoading || !adminToken}
            className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-red-700 hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-600 disabled:opacity-50"
          >
            {adminLoading ? "Verifying token..." : "Log in as Administrator"}
          </button>
        </form>
      </div>
    </div>
  );
}
