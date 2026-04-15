"use client";

import { useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post("/auth/forgot-password", { email });
      setSent(true);
    } catch {
      // Show success regardless to prevent email enumeration
      setSent(true);
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <div className="animate-fade-in text-center">
        <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-tarmoto-cyan/10 flex items-center justify-center text-tarmoto-cyan text-2xl">
          ✓
        </div>
        <h2 className="text-2xl font-bold mb-2">Check your email</h2>
        <p className="text-slate-400 mb-8">
          If an account exists for {email}, we&apos;ve sent a password reset link.
        </p>
        <Link href="/login" className="text-tarmoto-cyan hover:underline text-sm">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <h2 className="text-2xl font-bold mb-2">Reset password</h2>
      <p className="text-slate-400 mb-8">Enter your email and we&apos;ll send a reset link</p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1.5">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder:text-slate-500 focus:outline-none focus:border-tarmoto-cyan focus:ring-1 focus:ring-tarmoto-cyan transition"
            placeholder="rider@example.com"
            required
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full py-2.5 rounded-lg bg-tarmoto-cyan text-slate-950 font-semibold hover:bg-tarmoto-cyan-light disabled:opacity-50 transition"
        >
          {loading ? "Sending..." : "Send reset link"}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-slate-400">
        <Link href="/login" className="text-tarmoto-cyan hover:underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
