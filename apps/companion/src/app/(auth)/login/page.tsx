import { Suspense } from "react";
import { LoginForm } from "./LoginForm";
import { getEnabledOAuthProviders } from "@/lib/oauth-providers";

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm oauthProviders={getEnabledOAuthProviders()} />
    </Suspense>
  );
}
