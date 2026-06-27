import { useState, type FormEvent } from "react";
import { Heading, Alert, Button, Input, Card } from "@tarmoto/ui";

interface LoginScreenProps {
  onPasswordLogin: (email: string, password: string) => Promise<void>;
  onGithubSso: () => void;
  error: string | null;
  passwordLoginEnabled: boolean;
}

export function LoginScreen({
  onPasswordLogin,
  onGithubSso,
  error,
  passwordLoginEnabled,
}: LoginScreenProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void onPasswordLogin(email, password).catch(() => {
      /* error surfaced via the error prop */
    });
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-cream px-4">
      <Card className="w-full max-w-sm" variant="default">
        <Heading as="h1" size="lg" className="mb-6 text-center">
          Tarmoto Admin
        </Heading>
        {error ? (
          <Alert intent="danger" title={error} className="mb-4" />
        ) : null}
        <Button variant="accent" block onClick={onGithubSso}>
          Continue with GitHub
        </Button>
        {passwordLoginEnabled ? (
          <form className="mt-4 flex flex-col gap-3" onSubmit={handleSubmit}>
            <div>
              <label
                htmlFor="email"
                className="mb-1 block text-sm font-bold text-ink"
              >
                Email
              </label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={setEmail}
                tone="paper"
              />
            </div>
            <div>
              <label
                htmlFor="password"
                className="mb-1 block text-sm font-bold text-ink"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-line-strong bg-paper px-3 py-2 font-sans text-sm text-ink placeholder:text-fg-mute transition focus:border-accent focus:outline-none"
              />
            </div>
            <Button type="submit" variant="primary" block>
              Sign in
            </Button>
          </form>
        ) : null}
      </Card>
    </main>
  );
}
