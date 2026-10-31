"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

type Step = "credentials" | "totp";

export default function AdminSignIn() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleCredentials(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const result = await authClient.signIn.email({
        email,
        password,
      });

      if (result.error) {
        setError(result.error.message ?? "Sign-in failed");
      } else if ((result.data as Record<string, unknown>)?.twoFactorRedirect) {
        setStep("totp");
      } else {
        router.push("/admin/stores");
      }
    } catch {
      setError("Sign-in failed. Check your credentials.");
    } finally {
      setLoading(false);
    }
  }

  async function handleTotp(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const result = await authClient.twoFactor.verifyTotp({
        code: totpCode,
      });

      if (result.error) {
        setError(result.error.message ?? "Invalid code");
      } else {
        router.push("/admin/stores");
      }
    } catch {
      setError("Verification failed. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-sm rounded-lg border border-[#e2e4e9] bg-white p-8 shadow-sm">
        <h1 className="mb-6 text-center text-xl font-bold text-[#15201A]">
          Platform Admin
        </h1>

        {error && (
          <div className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {step === "credentials" && (
          <form onSubmit={handleCredentials}>
            <label className="mb-1 block text-sm font-medium text-[#15201A]">
              Email
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mb-4 w-full rounded-md border border-[#e2e4e9] px-3 py-2 text-sm focus:border-[#1F5A43] focus:outline-none focus:ring-1 focus:ring-[#1F5A43]"
              autoComplete="email"
            />

            <label className="mb-1 block text-sm font-medium text-[#15201A]">
              Password
            </label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mb-6 w-full rounded-md border border-[#e2e4e9] px-3 py-2 text-sm focus:border-[#1F5A43] focus:outline-none focus:ring-1 focus:ring-[#1F5A43]"
              autoComplete="current-password"
            />

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-full bg-[#1F5A43] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#123726] disabled:opacity-50"
            >
              {loading ? "Signing in..." : "Sign in"}
            </button>
          </form>
        )}

        {step === "totp" && (
          <form onSubmit={handleTotp}>
            <p className="mb-4 text-sm text-[#55625A]">
              Enter the 6-digit code from your authenticator app.
            </p>
            <label className="mb-1 block text-sm font-medium text-[#15201A]">
              Verification code
            </label>
            <input
              type="text"
              required
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              className="mb-6 w-full rounded-md border border-[#e2e4e9] px-3 py-2 text-center text-lg tracking-[0.3em] focus:border-[#1F5A43] focus:outline-none focus:ring-1 focus:ring-[#1F5A43]"
              autoComplete="one-time-code"
            />

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-full bg-[#1F5A43] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#123726] disabled:opacity-50"
            >
              {loading ? "Verifying..." : "Verify"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
