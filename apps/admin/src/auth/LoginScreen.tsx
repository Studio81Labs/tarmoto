import { useState, type FormEvent } from "react";

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
    <main className="login">
      <h1>Tarmoto Admin</h1>
      {error ? <p className="login__error">{error}</p> : null}
      <button type="button" className="login__sso" onClick={onGithubSso}>
        Continue with GitHub
      </button>
      {passwordLoginEnabled ? (
        <form className="login__form" onSubmit={handleSubmit}>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="submit">Sign in</button>
        </form>
      ) : null}
    </main>
  );
}
