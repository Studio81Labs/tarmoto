import { Suspense } from "react";
import { RegisterForm } from "./RegisterForm";
import { getEnabledOAuthProviders } from "@/lib/oauth-providers";

export default function RegisterPage() {
  return (
    <Suspense fallback={null}>
      <RegisterForm oauthProviders={getEnabledOAuthProviders()} />
    </Suspense>
  );
}
