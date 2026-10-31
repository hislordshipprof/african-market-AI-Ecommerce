"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export default function Enroll2FA() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [enrolling, setEnrolling] = useState(false);

  async function startEnrollment(e: React.FormEvent) {
    e.preventDefault();
    setEnrolling(true);
    setError("");
    try {
      const result = await authClient.twoFactor.enable({
        password,
      });
      if (result.error) {
        setError(result.error.message ?? "Failed to start enrollment");
        setEnrolling(false);
        return;
      }
      const data = result.data;
      if (data && "totpURI" in data) {
        setTotpUri(data.totpURI ?? null);
      }
    } catch {
      setError("Failed to start enrollment");
    } finally {
      setEnrolling(false);
    }
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const result = await authClient.twoFactor.verifyTotp({
        code,
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
        <h1 className="mb-2 text-center text-xl font-bold text-[#15201A]">
          Set up two-factor authentication
        </h1>
        <p className="mb-6 text-center text-sm text-[#55625A]">
          Two-factor authentication is required for all platform administrators.
        </p>

        {error && (
          <div className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {!totpUri && (
          <form onSubmit={startEnrollment}>
            <label className="mb-1 block text-sm font-medium text-[#15201A]">
              Current password
            </label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mb-4 w-full rounded-md border border-[#e2e4e9] px-3 py-2 text-sm focus:border-[#1F5A43] focus:outline-none focus:ring-1 focus:ring-[#1F5A43]"
              autoComplete="current-password"
              placeholder="Enter your password"
            />
            <button
              type="submit"
              disabled={enrolling}
              className="w-full rounded-full bg-[#1F5A43] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#123726] disabled:opacity-50"
            >
              {enrolling ? "Setting up..." : "Begin setup"}
            </button>
          </form>
        )}

        {totpUri && (
          <div>
            <div className="mb-4 rounded-md bg-[#f8f9fa] p-4">
              <p className="mb-2 text-sm font-medium text-[#15201A]">
                Scan this URI in your authenticator app, or enter the secret manually:
              </p>
              <code className="block break-all rounded bg-white px-2 py-1 text-xs text-[#55625A]">
                {totpUri}
              </code>
            </div>

            <form onSubmit={verifyCode}>
              <label className="mb-1 block text-sm font-medium text-[#15201A]">
                Verification code
              </label>
              <input
                type="text"
                required
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="mb-4 w-full rounded-md border border-[#e2e4e9] px-3 py-2 text-center text-lg tracking-[0.3em] focus:border-[#1F5A43] focus:outline-none focus:ring-1 focus:ring-[#1F5A43]"
                autoComplete="one-time-code"
                placeholder="000000"
              />
              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-full bg-[#1F5A43] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#123726] disabled:opacity-50"
              >
                {loading ? "Verifying..." : "Verify and continue"}
              </button>
            </form>
          </div>
        )}
      </div>
    </main>
  );
}
