import type { Metadata } from "next";

import { LoginForm } from "@/components/session/LoginForm";

export const metadata: Metadata = { title: "Sign in · Ticker" };

export default function LoginPage() {
  return <LoginForm />;
}
